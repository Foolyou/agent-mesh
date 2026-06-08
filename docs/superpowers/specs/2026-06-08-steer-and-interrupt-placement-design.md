# Steer (打断引导) + 中断按钮归位 — Design

Date: 2026-06-08
Status: Approved (design + team review folded in), ready for task breakdown

## Goal

两件事：

1. **中断按钮归位**：把会话工具条（`conv-control`）里的「中断」按钮挪进对话框 composer，放在发送区，仅在目标 agent live 且 working 时显示。位置更合理。
2. **Steer（通信对方引导能力）**：当前 `send_mail` 默认排队投递——给正在干活的 agent 发信，会排在它当前回合之后。新增「打断引导」能力：抢占收件人当前回合、把新消息插到队首立刻处理，用于快速把对方引导到新方向。该能力在**边配置中按边勾选**，只有勾选过的边允许 agent→agent 打断引导；人类作为操作者始终可打断引导。

## 现状（grounding）

- 中断按钮：`src/web/client/MeshDetail.tsx:274-278`，在 `conv-control` 工具条，和思考强度/模式/模型并排，仅 `live` 时显示。
- 消息排队：`send_mail` → `control-plane.ts:handleSendMail`（写信箱 + emit + `wake()`）。ACP 连接对每个 agent 的 prompt **串行排队**（`acp/client.ts:199-217`：有 in-flight turn 时新 prompt 入队，不并发）。这就是「默认排队」。
- interrupt：`interrupt` 工具仅 router（`control-plane.ts:337`），只取消当前回合，不带消息注入。`ControlPlane.interrupt(id, by)`（`control-plane.ts:150`）是人类路径，会 emit `kind:"interrupt"`（`control-plane.ts:151`）。
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
8. **禁 agent→router steer**（member 抢占 router 正处理人类指令的回合 = 权威反转）；人类 operator-steer 不受此限。
9. **steer 之间 FIFO**：连续多个 steer 按到达顺序处理（都进队首的 "steer 优先段"末尾，先到先跑），而非纯 unshift 的 LIFO。
10. **禁 to===self**（自打断会取消正发起该 tool call 的回合）。

## 设计

### 1. 数据模型（边对象化 + 兼容，归一化在 load/define 边界）

`src/acp/types.ts`：
```ts
export interface MeshEdge { from: AgentId; to: AgentId; steer?: boolean }
// MeshConfig.edges: MeshEdge[]
```
- **共享归一化助手** `normalizeMeshEdge` / `normalizeMeshEdges`（放在 types/domain 共享处）：接受旧 `[from, to]` 或新 `{from,to,steer?}`，统一产出对象（`steer` 缺省 false）。所有写/读边界复用，禁止各处手写解构。
- **单一归一化入口必须在持久化边界**（不只是 `Mesh` 构造）：
  - `mesh-store.ts` `load()`（:48 `JSON.parse as MeshConfig`）归一化后再返回；`define()`（:26 写盘前）归一化。这样 `gateway.ts:152` 直接读 `config.edges` 构 `MeshSummary` 时拿到的已是对象形态。
- `mesh.ts`：`canMail(from,to)` 改读对象；新增 `canSteer(from,to)` = 存在该边 且 `steer===true` 且 `from!==to` 且 **`to` 不是 router**。
- **所有 edges reader 同步**（漏改会导致解构得 undefined→canMail 全 false→通信静默死亡）：
  - 后端：`mesh.ts:44`、`mesh-validate.ts:45`（`for (const [from,to] of edges)` 必改，否则对象边不可迭代）。
  - 持久化/网关：`mesh-store.ts` load/define、`gateway.ts:152`。
  - master agent 建 mesh 路径：**`mcp/mesh-control.ts:68-70`** create_mesh/update_mesh 的 zod `z.array(z.tuple([string,string]))` → 接受对象（含可选 steer）。
  - 前端：`Topology.tsx:105`、`MeshCanvas.tsx:34/278/457`、`MeshBuilder.tsx:34/57/178`。
  - `web/types.ts` `MeshSummary.edges` 改对象。
- 校验（`mesh-validate.ts` / `MeshBuilder.validate`）：`steer===true` 的边必须是合法 mail 边；**steer→router 的边在 validate 阶段拒绝**（双保险，配合 canSteer 的 to!==router）。
- 旧磁盘配置（DEV/prod ~/.agent-mesh 都是元组）靠 load 归一化兼容；反向（新对象被旧版控制器读）仅降级时坏，记一笔。
- steer 边的拓扑差异化样式本次**不做**（YAGNI）。

### 2. 后端机制

**新工具 `steer_mail(to, body)`**（`src/mcp/mesh-services.ts`）：
- 对所有 agent 始终注册。
- 描述动态生成：register(agentId) 时经新增 handler `steerTargets(ctx)` 列出调用者出边里 `steer===true` 且合法的目标；无目标时描述说明「当前没有可打断引导的对象」。拓扑运行中不变，静态生成即可。
- **`ControlPlane.MESH_TOOLS` 必须加入 `steer_mail`**（`control-plane.ts:345`），否则被当外部 permission request 走人工审批。

**`control-plane.ts` `handleSteerMail(ctx, to, body)`**：
- 校验顺序：`mesh.agent(to)` 存在 → `to !== ctx.agentId`（禁自打断）→ `canMail` → `canSteer`（内含 to!==router）。任一不满足返回 error，文案明确提示「改用 send_mail」。
- 通过后：写信箱（与 mail 同格式，便于 check_mail 回看）+ emit `kind:"steer"`（含 from/to/body，UI 高亮与审计）+ 走打断投递路径。
- **复用 `trackTurn(...)`**（先计数再 cancel，避免 UI working 状态漏报/闪烁）。

**`acp/client.ts` 抢占入队（避免 cancel/pump 竞态）**：
- 抽私有 `enqueuePrompt(text, images, placement: "back"|"front")`；普通 `prompt()` 走 back。
- 新 `steerPrompt(text, images)`：**先同步把 job 插入队列**——FIFO 段语义：插到「已有 steer 优先项之后、普通排队项之前」（维护一个 steer 段边界），实现 steer 之间 FIFO、整体优先于普通 mail。**然后**若当时 busy 才发 `session/cancel`；不 busy 则 `pump()`。即"先占位、再取消"，保证 cancelled turn 结算时 `finally` 的 pump 必看到 steer 在前。
- `cancel` 不是 steer promise 的前置条件：steer promise 随其 prompt turn 结果结算；cancel RPC 失败仅 log，不丢已入队 steer（语义退化为"当前 turn 结束后优先处理"）。
- **idle 不 cancel**：调用方（control-plane）依据 busy/turnCounts>0 决定是否需要 cancel；idle 时 steerPrompt 等同普通 front 投递（队列空，无 in-flight 可杀），避免误杀窗口内新起回合。
- **images**：steerPrompt/front 路径与现有 queue job 一样读取并附带 images，不只搬 text。
- 在测试/注释写清：`cancel()` 出站早于后续 prompt 写入；无 in-flight 时 cancel 为 no-op。

**人类 operator-steer**（`control-plane.ts`，不受边限制）：
- 取消目标当前回合（仅当 busy）+ 把人类消息经 front 投递注入。
- **审计 parity（must）**：(a) emit 一条活动（`kind:"steer"`，from:"operator"，含 body/摘要），与 operator interrupt 的 emit 对齐；(b) 注入文本像普通人类 prompt 一样进入 transcript 时间线（走 update 流可见），不可静默注入。
- 经 `web/api.ts` / `store` 暴露新方法（如 `store.steerAgent(mesh, agent, text, images)`）。

**已知遗留（非本次范围，记一笔/补测试）**：cancel 发生在 pending permission 等待期间时，旧 interrupt 路径已有 pending 残留问题，steer 会让其更常见——本次至少补一个测试或 issue 标注，不在本任务强行收口。

### 3. UI

**任务 1 + 人类 steer（`ui.tsx` Composer + `ChatPane` + `MeshDetail.tsx`）**：
- 「中断」按钮从 `conv-control` 移入 `Composer` 发送区，仅当目标 agent **live 且 working** 时显示；dead 时禁用。props 经 `ChatPane` 透传（`onInterrupt?`、`working?`、`steerEnabled?`），避免 MeshDetail 直接耦合 composer 内部。
- `onKey`：**先分支 Ctrl+Enter**（`e.ctrlKey && Enter` → 打断发送），再普通 `Enter && !shiftKey`（排队发送），Shift+Enter 换行不变。`steerEnabled` 为否时 Ctrl+Enter 回退普通发送。idle 的 live agent 上 Ctrl+Enter 退化为 front 投递/no-op cancel。
- `onSend` 扩展为 `onSend(text, images, opts?: { steer?: boolean })`。`MeshDetail` agent pane：steer 分支调 `store.steerAgent`，普通分支调 `store.promptAgent`。router/master pane 不启用 steer。
- placeholder/提示补 Ctrl+Enter 说明（i18n `src/web/client/i18n.ts`）。

**Builder（`MeshBuilder.tsx`）**：
- 每条边行新增 `steer` 勾选框；edges state 从 `[string,string][]` 改为带 steer 的对象数组；`addEdge`/`setEdge`/`delEdge`/`validate`/`defineMesh` 同步。
- 勾选框 **tooltip** 明确："允许该 agent 取消收件人当前回合（含 router/人类发起的回合）并插队引导"。
- 校验：steer 边必须是合法 mail 边，且 to 不是 router。
- i18n 文案：`build.steer` 等。

### 4. 测试（TDD，先红后绿）

单测：
- 边归一化：旧 `[from,to]` 与新对象边同时过 `normalizeMeshEdges` / validator / `canMail` / `canSteer`；旧配置 `canSteer` 默认 false。
- `canSteer`：勾选边 true；未勾选 false；不存在边 false；**self（from===to）false**；**to===router false**。
- `handleSteerMail` 鉴权：无边→error、有边无勾→error、有勾→投递；**self-steer 拒绝**、**router-target 拒绝**、**idle 目标不触发 cancel**。
- `client.test`（可控 deferred prompt）：busy 时 普通 A → 排队 B → steer S，cancel 被调用，A settle 后顺序为 **S 再 B**；连续 **S1/S2 为 FIFO**（S1 先于 S2，二者都先于 B）。
- 人类 operator-steer：busy 时 cancel + front 注入 + emit 活动 + 进 transcript；idle 时不 cancel。

e2e（`src/web/*.e2e.ts`，Playwright + 自带 chromium，参照 `mode.e2e.ts`）：
- 中断按钮出现在 composer 新位置（live working）、点击触发 interrupt。
- Builder 边勾选 steer，保存后配置含 steer 标记；steer→router 勾选被校验拒绝。
- 人类 Ctrl+Enter 打断发送路径（live working agent）。
- **验收项**：steer 活动在 UI 醒目可见，人类可用中断兜底（DoS backstop 的人工可观测性）。

门禁：`bunx tsc --noEmit && bun test` 全绿；行为变更同步更新对应 `*.e2e.ts`。

## 影响面（改动文件）

- `src/acp/types.ts`（MeshEdge + normalizeMeshEdge(s)）
- `src/mesh.ts`（canMail 读对象 + canSteer，含 self/router 排除）
- `src/mesh-validate.ts`（对象边迭代 + steer/router 校验）
- `src/mesh-store.ts`（load/define 归一化入口）
- `src/mcp/mesh-services.ts`（steer_mail 工具 + steerTargets 描述）
- `src/mcp/mesh-control.ts`（create_mesh/update_mesh zod schema 接受对象边）
- `src/control-plane.ts`（handleSteerMail + operator-steer + steer 活动 + MESH_TOOLS）
- `src/acp/client.ts`（enqueuePrompt placement + steerPrompt + idle/images 处理）
- `src/web/types.ts`（MeshSummary.edges 对象 + steer 活动 kind）
- `src/web/gateway.ts`（读对象边）
- `src/web/api.ts` / `src/web/client/store.ts`（steerAgent 通路）
- `src/web/client/ui.tsx`（Composer：中断按钮 + Ctrl+Enter steer）
- `src/web/client/ChatPane.tsx`（透传 props）
- `src/web/client/MeshDetail.tsx`（移除工具条中断按钮，接 composer）
- `src/web/client/MeshBuilder.tsx`（边 steer 勾选 + tooltip）
- `src/web/client/Topology.tsx` / `MeshCanvas.tsx`（对象边 reader）
- `src/web/client/i18n.ts`（文案）
- 对应 `*.test.ts` / `*.e2e.ts`

## 非目标（YAGNI）

- steer 边的拓扑差异化样式。
- steer 速率限制 / 防滥用策略（以"活动高可见 + 人类 interrupt 兜底"替代）。
- pending permission 在 cancel 期间残留的彻底收口（旧 interrupt 已有，本次仅补测试/标注）。
- 对 dead/idle agent 的 steer 特殊化（idle 等同普通 front 投递，无 in-flight 可取消）。
