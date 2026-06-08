# Per-Agent 初始化提示词（per-agent instructions）

日期: 2026-06-08

## 背景

当前每个 agent 的首条 prompt 由 `buildMeshBriefing()`（src/mesh-briefing.ts）生成一段简报，结构为：身份 + roster + 网关职责 + mesh 工具 + 可选的 `charter`（团队章程，所有 agent 共享的"公共提示词"），再拼接实际任务。

`AgentConfig`（src/acp/types.ts）目前只有 `id / harness / project / role / effort / mode`，没有针对单个 agent 的自定义初始化提示词。本变更在保留公共 charter 的前提下，支持为每个 agent 单独编辑专属指令。

## 目标

- 为每个 agent 增加可选的专属初始化提示词，注入到该 agent（且仅该 agent）的简报中。
- 保留现有公共 charter 行为不变。
- 向后兼容：旧 mesh 配置无需迁移。

## 非目标

- 不实现提示词热重载。编辑只对未来冷启动 / 新 spawn 的 agent 生效——与现有 charter 行为一致（简报在首条 prompt 注入一次，由 control-plane 的 `briefed` 标记控制）。

## 设计

### 1. 数据模型 — src/acp/types.ts

`AgentConfig` 新增可选字段：

```ts
/** Optional per-agent instructions injected into THIS agent's briefing only. Free text. */
instructions?: string;
```

字段可选，旧配置（无该字段）继续有效，无需迁移。

### 2. 校验 — src/mesh-validate.ts

- 若 `instructions` 提供且 trim 后非空：长度 ≤ 4000 字符，超出报错（与 charter 的 4000 上限一致）。
- 空字符串 / 纯空白视为未提供，不报错。

### 3. 简报注入 — src/mesh-briefing.ts

在 charter 小节之后、`---` 分隔之前，若该 agent 的 `instructions` trim 后非空，追加专属小节：

```
Your role-specific instructions — additional guidance for you specifically (only you see this):
  <instructions 文本，缩进>
```

- 公共 charter 在前，专属 instructions 在后（更靠近任务）。
- charter 缺省时，该专属小节仍可独立出现。
- agent 无 instructions 时，简报与现状完全一致。

### 4. Web UI — src/web/client/MeshBuilder.tsx（+ store.ts 如需要）

- 每个 agent 行的现有字段（harness/role/project/effort/mode）下方，新增多行 textarea「专属指令（可选）」。
- 客户端镜像 4000 字符校验，与现有客户端校验风格一致。
- 提交时 `instructions` 随该 agent 一起 POST 到 `/api/meshes`。
- 编辑模式下，从 `GET /api/meshes/:name/config` 回填已有 `instructions`。

## 测试（TDD）

- **src/mesh-briefing.test.ts**：
  - agent 有 instructions → 简报含专属小节，文本正确缩进。
  - agent 无 instructions → 简报不含该小节（与现状一致）。
  - charter + instructions 同时存在 → 两小节都在，charter 在前、instructions 在后。
  - 仅 instructions、无 charter → 专属小节独立出现。
- **mesh-validate 测试**：instructions 超 4000 报错；空串 / 纯空白被忽略不报错。
- **e2e（src/web/*.e2e.ts）**：在 MeshBuilder 为某 agent 填写专属指令 → 保存 → 重新打开编辑，确认回填。

## 风险 / 权衡

- 编辑不热生效是已知且与 charter 一致的行为，文档与 UI 文案需让用户理解"对未来 spawn 生效"。
- 4000 上限为保守选择，与 charter 对齐，后续如需可单独调整。
