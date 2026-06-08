# Steer (打断引导) + 中断按钮归位 — Design

Date: 2026-06-08
Status: Approved (design), pending team review

## Goal

两件事：

1. **中断按钮归位**：把会话工具条（`conv-control`）里的「中断」按钮挪进对话框 composer，放在发送区，仅在目标 agent live/working 时显示。位置更合理。
2. **Steer（通信对方引导能力）**：当前 `send_mail` 默认排队投递——给正在干活的 agent 发信，会排在它当前回合之后。新增「打断引导」能力：抢占收件人当前回合、把新消息插到队首立刻处理，用于快速把对方引导到新方向。该能力在**边配置中按边勾选**，只有勾选过的边允许 agent→agent 打断引导；人类作为操作者始终可打断引导。

## 现状（grounding）

- 中断按钮：`src/web/client/MeshDetail.tsx:274-278`，在 `conv-control` 工具条，和思考强度/模式/模型并排，仅 `live` 时显示。
- 消息排队：`send_mail` → `control-plane.ts:handleSendMail`（写信箱 + emit + `wake()`）。ACP 连接对每个 agent 的 prompt **串行排队**（`acp/client.ts:199-217`：有 in-flight turn 时新 prompt 入队，不并发）。这就是「默认排队」。
- interrupt：`interrupt` 工具仅 router（`control-plane.ts:337`），只取消当前回合，不带消息注入。`ControlPlane.interrupt(id, by)`（`control-plane.ts:150`）是人类路径。
- 边模型：`edges: Array<[from, to]>`（`acp/types.ts:35`），`canMail` 据此判断（`mesh.ts:42`）。
- composer：`src/web/client/ui.tsx` `Composer`，`onKey` 中 Enter→submit、Shift+Enter→换行；`submit()` 调 `onSend(text, images)`。

## 决策（已与用户确认）

1. 作用域：**agent↔agent + 人类**。
2. 人类侧门控：**始终可打断引导**，不受边勾选限制；入口在对话框 composer。
3. agent 侧触发：**新增独立工具 `steer_mail(to, body)`**（不污染 `send_mail`）。
4. 收件人行为：**取消当前回合 + steer 消息插到队首立刻处理；已排队的其它消息保留在其后**（不丢消息）。被打断的回合以 cancelled 收场。
5. 数据模型：**边对象化** `{ from, to, steer? }`，旧 `[from, to]` 加载时归一化兼容。
6. 人类打断发送触发键：**Ctrl+Enter**（普通 Enter = 排队发送，Ctrl+Enter = 打断发送）。
7. `steer_mail` 工具：**始终注册**给所有 agent；描述里动态列出可 steer 的目标，无可用目标时调用报错。

## 设计

### 1. 数据模型（边对象化 + 兼容）

`src/acp/types.ts`：
```ts
export interface MeshEdge { from: AgentId; to: AgentId; steer?: boolean }
// MeshConfig.edges: MeshEdge[]
```
- **归一化**：在 `Mesh` 构造（或配置加载入口）统一把 `[from, to]` → `{ from, to }`（`steer` 缺省 false）。单一归一化入口，避免散落。
- `mesh.ts`：`canMail(from, to)` 改读对象；新增 `canSteer(from, to)` = 存在该边且 `steer === true`。
- `web/types.ts` `MeshSummary.edges` 同步改对象；拓扑渲染照常工作。steer 边的差异化样式**本次不做**（YAGNI）。
- 校验（`mesh-validate.ts` / `MeshBuilder.validate`）：`steer === true` 的边必须本身是合法 mail 边（from/to 都是已知 agent）。

### 2. 后端机制

**新工具 `steer_mail(to, body)`**（`src/mcp/mesh-services.ts`）：
- 对所有 agent 始终注册。
- 描述动态生成：列出调用者出边里 `steer === true` 的目标；无目标时描述说明「当前没有可打断引导的对象」。
- handler 委托 `control-plane`。

**`control-plane.ts` `handleSteerMail(ctx, to, body)`**：
- 校验 `mesh.agent(to)` 存在；`canMail(from, to)`；`canSteer(from, to)`。任一不满足返回 error（提示改用 `send_mail`）。
- 通过后：写信箱（与 mail 同格式，便于 check_mail 回看）+ emit 新活动 `kind: "steer"`（含 from/to/body，用于 UI 高亮与审计）+ 走**打断投递路径**。

**`acp/client.ts` 打断投递语义**：
- 新增方法（如 `steerPrompt(text)`）：取消当前 in-flight turn（`cancel()`）+ 把该 prompt **unshift 到队首**，已排队项保留其后。队列泵在 cancelled 回合结算后先取队首（steer）。
- 复用现有 queue 机制（`acp/client.ts:199-217`），不引入并发。

**人类路径**：
- `control-plane` 暴露 operator-steer 入口：取消目标当前回合 + 把人类消息 unshift 队首注入（不写 agent↔agent 信箱；走与人类普通 prompt 相同的 compose 路径，仅投递方式为打断）。不受边勾选限制。
- 经 `web/api.ts` / `store` 暴露给 UI 新方法（如 `store.steerAgent(mesh, agent, text, images)`）。

### 3. UI

**任务 1 + 人类 steer（`ui.tsx` Composer + `MeshDetail.tsx`）**：
- 「中断」按钮从 `conv-control` 移入 `Composer` 发送区，仅当目标 agent live 且 working 时显示。Composer 新增可选 props：`onInterrupt?`、`working?`（控制中断按钮显隐）、`steerEnabled?`（是否允许 Ctrl+Enter 打断发送）。
- `onKey`：Enter（无修饰）= 普通发送；Shift+Enter = 换行（不变）；**Ctrl+Enter = 打断发送**（仅 `steerEnabled` 时；否则回退普通发送）。
- `onSend` 扩展为 `onSend(text, images, opts?: { steer?: boolean })`，或并列 `onSteer`。`MeshDetail` 的 agent pane 传入：steer 分支调 `store.steerAgent`，普通分支调 `store.promptAgent`。router/master pane 不启用 steer（Ctrl+Enter 回退普通发送）。
- placeholder/提示文案补充 Ctrl+Enter 说明（i18n `src/web/client/i18n.ts`）。

**Builder（`MeshBuilder.tsx`）**：
- 每条边行新增一个 `steer` 勾选框。edges state 从 `[string,string][]` 改为带 steer 的对象数组；`addEdge`/`setEdge`/`delEdge`/`validate`/`defineMesh` 同步。
- i18n 文案：`build.steer` 等。

### 4. 测试（TDD，先红后绿）

单测：
- 边归一化：旧 `[from,to]` 配置加载后 `canMail` 正常、`canSteer` 默认 false。
- `canSteer`：勾选边 true、未勾选边 false、不存在边 false。
- `handleSteerMail` 鉴权三态：无边→error、有边无勾→error、有勾→投递。
- 打断投递顺序：busy agent 收到 steer 时，当前回合被 cancel、steer 在队首先于已排队项执行。
- 人类 operator-steer：取消当前回合 + 队首注入，不受边限制。

e2e（`src/web/*.e2e.ts`，Playwright + 自带 chromium，参照 `mode.e2e.ts`）：
- 中断按钮出现在 composer 新位置、点击触发 interrupt。
- Builder 边勾选 steer，保存后配置含 steer 标记。
- 人类 Ctrl+Enter 打断发送路径（live working agent）。

门禁：`bunx tsc --noEmit && bun test` 全绿；行为变更同步更新对应 `*.e2e.ts`。

## 影响面（改动文件）

- `src/acp/types.ts`（MeshEdge）
- `src/mesh.ts`（canMail 读对象 + canSteer + 归一化）
- `src/mesh-validate.ts`（steer 边校验）
- `src/mcp/mesh-services.ts`（steer_mail 工具）
- `src/control-plane.ts`（handleSteerMail + operator-steer + steer 活动）
- `src/acp/client.ts`（打断投递 / steerPrompt）
- `src/web/types.ts`（MeshSummary.edges 对象 + steer 活动 kind）
- `src/web/api.ts` / `src/web/client/store.ts`（steerAgent 通路）
- `src/web/client/ui.tsx`（Composer：中断按钮 + Ctrl+Enter steer）
- `src/web/client/MeshDetail.tsx`（移除工具条中断按钮，接 composer）
- `src/web/client/MeshBuilder.tsx`（边 steer 勾选）
- `src/web/client/i18n.ts`（文案）
- 对应 `*.test.ts` / `*.e2e.ts`

## 非目标（YAGNI）

- steer 边的拓扑差异化样式。
- steer 速率限制 / 防滥用策略。
- 对 dead/idle agent 的 steer 特殊化（idle 时等同普通投递即可，无 in-flight 可取消）。
