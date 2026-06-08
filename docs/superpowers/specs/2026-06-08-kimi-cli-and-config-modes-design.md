# Kimi CLI 支持 + 通用 mode/model 控制（基于 ACP configOptions）

日期: 2026-06-08

## 背景

mesh 通过 ACP-over-stdio 编排异构 coding agent，现支持 codex / opencode / claude 三个 harness。新增第四个 harness **Kimi CLI**。

调研中实测发现：kimi 与 opencode 都通过 ACP `session/new` 响应里的 **`configOptions`** 数组广告其可配置项（mode / model / thinking），而**不是**通过标准的 `session.modes.availableModes`。我们的 control-plane 目前只读 `availableModes`，因此：
- opencode 的 build/plan 模式从未在 UI 显示过（既有缺口）。
- kimi 的 default/plan/auto/yolo 模式同理无法控制。

进一步实测确认：kimi 和 opencode 都**真正实现**了标准 ACP 方法 `session/set_mode` 和 `session/set_model`（设置后 `currentValue` 确实改变），而这两个方法在我们已装的库 `@zed-industries/agent-client-protocol@0.4.5`（npm 最新版）中均有封装（`setSessionMode` / `setSessionModel`，后者标注 UNSTABLE）。库的 `newSession` 不对响应做 zod 解析、原样返回，因此 `configOptions` 字段可经 `(session as any).configOptions` 读取。

结论：mode 与 model 的运行时控制**无需重写传输层**——读取来源从 `availableModes` 扩展到也接受 `configOptions`，施加仍走标准 `setSessionMode` / `setSessionModel`。

唯一离不开非标准 `session/set_config_option` 的是 kimi/opencode 的 **thinking 开关**——本次**不做**（kimi 默认 thinking on），留作后续。

## 实测事实（已验证）

- **kimi**：`kimi acp` 原生 ACP；`promptCapabilities.image=true`；`mcpCapabilities.http=true`（mesh 工具走 HTTP MCP，兼容）。configOptions: mode=`default`(手动批准)/`plan`(只读)/`auto`(自动批准安全操作)/`yolo`(全自动批准)；model 单一；thinking on/off。`session/set_mode` 与 `session/set_model` 实测生效。需 device-code 登录（本机已登录）。
- **opencode**：configOptions: mode=`build`(默认,按权限执行)/`plan`(禁编辑)；model 多款（deepseek/kimi/opencode 等）。`session/set_mode` 与 `session/set_model` 实测生效。
- 库无 `session/set_config_option` 封装，底层 `Connection` 未导出，`extMethod` 会强制加 `_` 前缀（实测 kimi 拒绝 `_`-前缀）。故 thinking 推迟。

## 目标

1. 注册 kimi harness，可在 mesh 中正常 spawn、prompt、收发 mail、图片输入。
2. 通用化 mode 来源：当标准 `availableModes` 缺失时，从 `configOptions(category="mode")` 派生，使 kimi 与 opencode 的模式选择器与启动预设都生效（复用现有 setMode 链路）。
3. 新增通用 model 选择器（运行时）：从 `configOptions(category="model")` 读取，经标准 `session/set_model` 切换。对 opencode 有实际意义。

## 非目标

- thinking on/off 运行时控制（需 `set_config_option`，推迟）。
- model 的启动期预设（model 列表是账户/agent 动态的，无静态校验表）——model 仅运行时由操作者在 UI 切换，不进 mesh 配置/builder。

## 设计

### 1. 注册 kimi

- `src/acp/types.ts`：`HarnessId` 增加 `| "kimi"`。
- `src/harness.ts`：`HARNESSES.kimi = { command: "kimi", args: ["acp"] }`。
- `src/web/client/MeshBuilder.tsx`：`HARNESSES` 数组加 `"kimi"`。
- `spawnConfigFor`：**不**为 kimi 加 effort 分支（kimi 无 effort 等级）。

### 2. HARNESS_MODES 与 UNSAFE_MODES（`src/harness.ts`）

- `HARNESS_MODES.kimi = ["default", "plan", "auto", "yolo"]`
- `HARNESS_MODES.opencode = ["build", "plan"]`（原为 `[]`）
- `UNSAFE_MODES` 增加 `"auto"` 与 `"yolo"`（自动批准＝绕过审批；与 codex `full-access`、claude `bypassPermissions` 同等门禁，启动预设需 `ALLOW_UNSAFE_MESH_MODES`）。
- `builderModesFor` 已自动过滤 UNSAFE，故 builder 对 kimi 仅提供 default/plan，对 opencode 提供 build/plan。

### 3. control-plane：从 configOptions 派生 mode 与 model（`src/control-plane.ts` start()）

在 `newSession` 之后（现 ~187-205 行）：

- **modes**：先取标准 `session.modes.availableModes`；若为空，则从 `session.configOptions` 中 `category==="mode"` 的项派生：`available = options.map(o => ({ id: o.value, name: o.name, description: o.description }))`，`current = configOption.currentValue`。其余（`sessionModes` 存储、`agent_modes` 事件、`a.mode` 预设经 `conn.setMode`）逻辑不变。
- **models**：从 `session.configOptions` 中 `category==="model"` 的项读取 `{ current: currentValue, available: options.map(o => ({ id: o.value, name: o.name })) }`；仅当 `available.length > 0` 时存储并发 `agent_models` 事件。
- 写成通用辅助：`deriveConfigOption(session, category)`，mode/model 共用。

新增方法 `setModel(id, modelId)`：调用 `conn.setModel(modelId)`，更新本地 model 状态并重新 emit `agent_models`（model 无标准 `current_model_update` 通知，故自行回显，与现有 `setMode` 回显 `current_mode_update` 同理）。

### 4. ACP client（`src/acp/client.ts`）

新增 `async setModel(modelId: string)`：`if (this.sessionId) await this.conn!.setSessionModel({ sessionId: this.sessionId, modelId })`。

### 5. Web 事件 / 网关 / API / store

- `src/web/types.ts`：新增 `ServerEvent` 变体 `agent_models { agent, current, available: {id,name}[] }`；mesh summary 的 agent 增加 `model?: { current, available }`。
- `src/web/gateway.ts`：仿 `agent_modes`（214 行）处理 `agent_models`，折叠进每-mesh 状态（如 `pm.models`）并反映到 summary；新增 `setModel(name, agentId, modelId)`（仿 363 行 `setMode`）委托 manager/control-plane。
- `src/web/api.ts`：新增路由 `POST /api/meshes/:name/agents/:id/model`（仿 107 行 mode 路由），body `{ modelId }`。
- `src/web/client/store.ts`：新增 `setModel(name, agentId, modelId)`（仿 248 行 setMode）。
- `src/web/fake.ts`：补 `setModel` 与 `agent_models` 发射，供测试/e2e。

### 6. UI（`src/web/client/MeshDetail.tsx`）

- 现有 mode picker（82-98 行）无需改动，kimi/opencode 的 modes 现在会被填充而自动出现。
- 在 mode picker 旁新增 model picker：当 agent 广告了 models（`available.length>0`）时渲染，`onChange` 调 `store.setModel`。
- `EffortControl`（118 行）对 `kimi` 隐藏（同 opencode）。

## 测试（TDD）

- `src/harness.test.ts`：kimi resolver（command `kimi`、args `["acp"]`）+ spawnConfig（effort 被忽略，env `{}`）；`HARNESS_MODES.kimi`/`opencode` 内容；`UNSAFE_MODES` 含 auto/yolo。
- `src/mesh-validate.test.ts`：kimi mode `plan` 通过、`auto`/`yolo` 在无 `ALLOW_UNSAFE_MESH_MODES` 时报错、有则通过；opencode `build`/`plan` 通过；未知 mode 报错。
- control-plane 测试：用 fake 连接构造一个返回 `configOptions`（category mode + model）但无 `availableModes` 的 session，断言：emit 了 `agent_modes`（如 build/plan）与 `agent_models`；`setModel` 调用 `conn.setSessionModel` 并重新 emit `agent_models`。
- `src/web/gateway.test.ts` / `api.test.ts`：`agent_models` 折叠进 summary；`POST .../model` 委托 `setModel`。
- e2e：
  - `src/web/browser.e2e.ts` 或新增片段：builder 下拉含 `kimi`。
  - 扩展 `src/web/mode.e2e.ts` 或新增 `src/web/model.e2e.ts`：用 fake 发 `agent_models`，确认 model picker 出现且切换 round-trip。
  - 真·端到端（本机已装并登录 kimi/opencode）：起临时 dev 实例 `bun run src/main.ts --port 10020 --root ~/.agent-mesh-dev`，建含一个 kimi agent + 一个 opencode agent 的 mesh，验证 spawn/prompt/收发 mail、mode picker（kimi: default/plan；opencode: build/plan）、model picker 切换生效；用完杀掉。绝不碰生产（10010 / ~/.agent-mesh）。

## 风险 / 权衡

- `setSessionModel` 在库中标注 UNSTABLE；实测 kimi/opencode 可用，若未来库或 agent 变更需回归。仅影响 model 选择器。
- mode 来源双路（availableModes 或 configOptions）需保证 claude/codex（走 availableModes）行为不回归——control-plane 测试与真·端到端覆盖。
- auto/yolo 经 UNSAFE 门禁，避免 LLM 生成的 mesh 配置静默启用绕过审批的模式。
