# Kimi CLI 支持 + 全 advertise 驱动的 mode/model 控制（含运行时缓存）

日期: 2026-06-08

## 背景

mesh 通过 ACP-over-stdio 编排异构 coding agent，现支持 codex / opencode / claude。新增第四个 harness **Kimi CLI**。

调研中实测发现：kimi 与 opencode 都通过 ACP `session/new` 响应里的 **`configOptions`** 数组广告其可配置项（mode / model / thinking），而**不是**通过标准 `session.modes.availableModes`。control-plane 目前只读 `availableModes`，导致 opencode 的 build/plan 从未显示、kimi 的模式也无法控制。

进一步实测：kimi 和 opencode 都**真正实现**了标准 ACP 方法 `session/set_mode` 和 `session/set_model`（设置后 `currentValue` 确实改变），二者在已装库 `@zed-industries/agent-client-protocol@0.4.5`（npm 最新）中均有封装（`setSessionMode` / `setSessionModel`，后者标 UNSTABLE）。`newSession` 不对响应做 zod 解析、原样返回，故 `configOptions` 可经 `(session as any).configOptions` 读取。

**设计取向（与用户敲定）**：模式系统改为**完全 advertise 驱动**——不再硬编码任何"每个 harness 有哪些模式"的静态表，也不再维护"哪些模式不安全"的集合（假设用户充分了解自己使用的 harness）。builder 不再做模式预设；模式与模型只在运行时由操作者通过选择器切换。为消除冷启动摩擦，操作者的选择会**持久化进 mesh 配置**（`AgentConfig.mode`/`model`），冷启动 spawn 后 best-effort 重新应用。

thinking 开关（kimi/opencode 仅经非标准 `set_config_option`）本次**不做**，留作后续。

## 实测事实（已验证）

- **kimi**：`kimi acp` 原生 ACP；`image=true`；MCP `http=true`（mesh 工具走 HTTP MCP，兼容）。configOptions: mode=default/plan/auto/yolo；model 单一；thinking on/off。`set_mode`/`set_model` 实测生效。本机已装（`~/.kimi-code/bin`）并登录。
- **opencode**：configOptions: mode=build/plan；model 多款。`set_mode`/`set_model` 实测生效。本机已装（`~/.opencode/bin`）。
- 二者在 PATH 中需 `source ~/.zshrc`。

## 目标

1. 注册 kimi harness，可正常 spawn / prompt / 收发 mail / 图片输入。
2. 删除静态模式机制，模式/模型来源完全 advertise 驱动（标准 availableModes 或 configOptions）。
3. 运行时切换的 mode/model 持久化进配置，冷启动 best-effort 重应用。

## 非目标

- thinking on/off 运行时控制（需 set_config_option，推迟）。
- builder 内的模式/模型预设（改为纯运行时 + 缓存）。
- 任何"不安全模式"门禁（移除现有 UNSAFE 逻辑）。

## 设计

### 1. 注册 kimi
- `src/acp/types.ts`：`HarnessId` 增加 `| "kimi"`。
- `src/harness.ts`：`HARNESSES.kimi = { command: "kimi", args: ["acp"] }`。
- `src/web/client/MeshBuilder.tsx`：`HARNESSES` 数组加 `"kimi"`。
- `spawnConfigFor`：**不**为 kimi 加 effort 分支。

### 2. 删除静态模式机制（`src/harness.ts`）
- 删除 `HARNESS_MODES`、`UNSAFE_MODES`、`builderModesFor`（及其全部引用）。
- `src/mesh-validate.ts`：删除 mode 校验块（按静态表校验 + UNSAFE/`ALLOW_UNSAFE_MESH_MODES` 门禁）及对应 import；`mode`/`model` 成为自由文本，不做静态校验（spawn 时 best-effort 应用）。保留 `HARNESSES` 用于 harness 存在性校验。
- `src/web/client/MeshBuilder.tsx`：删除 mode 下拉（现 155-168 行）与 `builderModesFor` import；builder 不再写 `mode`（从 agent draft / 提交中去除 mode）。**保留 effort 下拉**（codex/claude 的 spawn 期 effort，与本次无关）。

### 3. AgentConfig（`src/acp/types.ts`）
- 新增 `model?: string`（与既有 `mode?: string` 并列）。二者语义改为"操作者运行时选择的持久化缓存"，而非 builder 预设。

### 4. control-plane：advertise 派生 + 缓存应用（`src/control-plane.ts` start()）
`newSession` 之后：
- **modes**：先取标准 `availableModes`；为空则从 `configOptions(category==="mode")` 派生 `available = options.map(o => ({id:o.value, name:o.name, description:o.description}))`、`current = configOption.currentValue`。喂进现有 `sessionModes`/`agent_modes` 链路。
- **models**：从 `configOptions(category==="model")` 读取 `{current, available: options.map(o=>({id:o.value,name:o.name}))}`；`available` 非空时存储并 emit 新事件 `agent_models`。
- 抽 `deriveConfigOption(session, category)` 复用。
- **缓存应用**：spawn 后 best-effort 应用 `a.mode`（现已有 `available.some` 判断）与 `a.model`（新增，匹配不上则 log 跳过）。
- 新增 `setModel(id, modelId)`：调 `conn.setModel(modelId)`，更新本地 model 状态并重新 emit `agent_models`（model 无标准通知，自行回显，仿现有 setMode 回显 current_mode_update）。
- 不得让 claude/codex（走 availableModes）回归。

### 5. ACP client（`src/acp/client.ts`）
- 新增 `async setModel(modelId)`：`if (this.sessionId) await this.conn!.setSessionModel({ sessionId: this.sessionId, modelId })`。

### 6. 缓存持久化（`src/mesh-manager.ts`）
- `setMode(name, agentId, modeId)` 与 `setModel(name, agentId, modelId)`：在委托运行中的 client 之外，**同时把选择 patch 进配置并持久化**——完全套用既有 effort 持久化模式（现 ~83-89 行：`patched = {...config, agents: agents.map(a => a.id===id ? {...a, mode/model} : a)}`；`await store.define(patched)`；`entry.config = patched`）。运行中允许（topology 不变）。

### 7. Web 事件 / 网关 / API / store
- `src/web/types.ts`：新增 `ServerEvent` 变体 `agent_models { agent, current, available:{id,name}[] }`；summary 的 agent 增加 `model?: {current, available}`。
- `src/web/gateway.ts`：仿 `agent_modes`（~214 行）处理 `agent_models`，折叠进每-mesh 状态并反映 summary；新增 `setModel`（仿 ~363 行 setMode）。
- `src/web/api.ts`：新增 `POST /api/meshes/:name/agents/:id/model`（仿 ~107 行 mode 路由），body `{ modelId }`。
- `src/web/client/store.ts`：新增 `setModel`（仿 ~248 行 setMode）。
- `src/web/fake.ts`：补 `setModel` 与 `agent_models` 发射。

### 8. UI（`src/web/client/MeshDetail.tsx`）
- mode picker（~82-98 行）逻辑不变，kimi/opencode 现在会被填充自动出现。
- 旁边新增 model picker：agent 广告了 models（`available.length>0`）时渲染，`onChange` 调 `store.setModel`。
- `EffortControl`（~118 行）对 `kimi` 隐藏（仿 opencode）。

## 测试（TDD）
- `src/harness.test.ts`：删除 HARNESS_MODES/UNSAFE/builderModesFor 断言；保留/新增 kimi resolver（command `kimi`、args `["acp"]`）与 spawnConfig（effort 被忽略、env `{}`）。
- `src/mesh-validate.test.ts`：删除 ALLOW_UNSAFE/静态模式校验相关用例；新增 mode/model 任意字符串均不报错。
- control-plane 测试：fake 连接返回带 `configOptions`（mode+model）、无 `availableModes` 的 session → 断言 emit `agent_modes`（如 build/plan）与 `agent_models`；spawn 时 best-effort 应用配置中的 `mode`/`model`；`setModel` 调 `conn.setSessionModel` 并重 emit。
- `src/mesh-manager.test.ts`：`setMode`/`setModel` 将选择 patch 进配置并经 store 持久化（mock store 断言）。
- `src/web/gateway.test.ts` / `api.test.ts`：`agent_models` 折叠进 summary；`POST .../model` 委托 `setModel`。
- e2e：
  - `src/web/browser.e2e.ts`：builder 下拉含 `kimi`；builder **不再有** mode 下拉。
  - 扩展 `src/web/mode.e2e.ts` 或新增 `src/web/model.e2e.ts`：用 fake 发 `agent_models`，确认 model picker 出现且切换 round-trip。
  - 真·端到端（本机已装并登录 kimi/opencode）：起临时 dev 实例 `bun run src/main.ts --port 10020 --root ~/.agent-mesh-dev`，建含一个 kimi + 一个 opencode agent 的 mesh，验证 spawn/prompt/收发 mail、mode picker（kimi default/plan、opencode build/plan）、model picker 切换生效，并验证**切换后冷重启仍保留**（缓存写回配置）。用完杀掉。绝不碰生产（10010 / ~/.agent-mesh）。PATH 需 `source ~/.zshrc`。

## 风险 / 权衡
- 移除模式静态校验与 UNSAFE 门禁后，错误的 mode/model 字符串在 spawn 时静默 best-effort 跳过（log），不再有 define 期早报错——符合"信任用户了解自己 harness"的取向。
- `setSessionModel` 库中标 UNSTABLE；实测 kimi/opencode 可用，未来库/agent 变更需回归。仅影响 model 选择器。
- 运行时切换写回 `.mesh/meshes/<name>.json`：声明式配置会随运行时选择变动（下次 builder 打开显示上次所选），属预期。
- mode 来源双路（availableModes 或 configOptions）须保证 claude/codex 不回归——control-plane 测试 + 真·端到端覆盖。
