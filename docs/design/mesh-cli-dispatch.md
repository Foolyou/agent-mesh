# `mesh` CLI 命令分发重设计（research + 可执行方案）

- **任务**: `mesh-cli-dispatch-research`
- **分支**: `task/mesh-cli-dispatch-research`（基于 main `38bf2fb`）
- **范围**: 纯阅读分析 + 可执行修改方案。**本文档不实现任何功能代码**，不加 harness，不改 `main.ts`/`service.ts`/`auth-cli.ts` 等。
- **状态标签**: `[confirmed]` = 已在源码核验（含 file:line/符号）；`[inference]` = 基于源码的推断；`[proposal]` = 建议方案。

实际读过的文件（均在 `38bf2fb`）：`src/main.ts`、`src/service.ts`、`src/auth-cli.ts`、`src/args.ts`、`src/cli-options.ts`、`src/diagnostics-sources.ts`、`src/diagnostics.ts`（佐证 ps/doctor 入口）、`src/web/service.e2e.ts`、`scripts/update.sh`、`README.md`、`docs/device-auth-operations.md`。

---

## 0. TL;DR

`mesh` 的子命令分发集中在 `src/main.ts` 的 `runCli()`，用两条极简启发式：

```ts
// src/main.ts:43-44
const sub = process.argv[2];
const cmd = sub && !sub.startsWith("-") ? sub : "all";
```

加上一条**无 `default:`/`else` 守卫**的 `if/else if` 链，**最后一个 `else` 直接启动 combined Web/API 控制台**（`src/main.ts:185-198`）。两者叠加导致：未知命令、`help`、`--help`、以及 global flag 前置（`mesh --root . status`）全部**误落入控制台启动路径**。同时 `parseAssistantHarness(process.argv)` 在分发**之前**无条件执行（`src/main.ts:48`），会让 `status/ps/doctor/auth` 这类只读命令因 assistant harness flag/env 非法而**抛错退出**。

本文给出：① 逐条问题定位；② 一个带显式命令表 + 复用 `src/args.ts` 解析器的分发结构（启动类 / 只读·配置类 / `channels` 子命令树）；③ 不破坏 `scripts/update.sh` 与现有 e2e 的兼容策略；④ 分阶段 commit 实现步骤；⑤ 测试计划；⑥ 风险与规避。

---

## 1. 当前问题定位（对应背景 1–7）

### 1.1 背景①：裸 `mesh` 启动 combined 控制台——保留但需显式 `[confirmed]`

- 裸 `mesh`（无子命令）→ `process.argv[2]` 为 `undefined` → `cmd = "all"`（`src/main.ts:44`）。
- `"all"` 不匹配任何 `if/else if` 分支，落入最后的 `else`（`src/main.ts:185-198`）：`buildGateway()` + `startWebServer({ port, gateway })`，打印 `agent-mesh web console → …`。
- **问题**：行为本身合理（保留），但它是"兜底分支"而非"显式命令"，与 1.2 的误启动同源。建议把"启动 combined 控制台"提升为**显式默认命令**（如裸 `mesh` 或 `mesh console`），并让兜底分支改为"未知命令报错"。

### 1.2 背景②：未知命令 / `help` / `--help` / global flag 前置误启动控制台 `[confirmed]`

四种输入都会启动控制台，因为它们都解析成 `cmd ∉ {已知分支}` 后落入 `else`：

| 输入 | `process.argv[2]` | `cmd`（`main.ts:44`） | 结果 |
|---|---|---|---|
| `mesh frobnicate` | `"frobnicate"` | `"frobnicate"` | 无匹配 → `else` → **启动控制台** |
| `mesh help` | `"help"` | `"help"` | 无匹配 → `else` → **启动控制台** |
| `mesh --help` | `"--help"` | `"all"`（以 `-` 开头） | → `else` → **启动控制台** |
| `mesh --root . status` | `"--root"` | `"all"`（以 `-` 开头） | → `else` → **启动控制台**（`status` 被忽略） |

注意：参数**取值**函数 `argVal`（`main.ts:38-41`，`indexOf`）与 `has`（`main.ts:42`，`includes`）扫描整个 `argv`，所以 `--root/--port/--fake` 等**无论前置后置都能取到值**；**唯一断点是命令名**——`cmd` 固定取 `argv[2]`，一旦 `argv[2]` 是 flag，命令名就丢失、误判为 `"all"`。这正是"global flag 前置失败、后置成功"的根因。

- **硬目标**：未知命令应 `exit 2 + usage`、`help`/`--help` 应打印 usage，且二者都**不得启动服务**。
- **修法方向**：命令名应取"第一个非 flag 位置参数"（跳过 flag 及其值），而非固定 `argv[2]`；并加显式 `help`/`--help`/`-h` 分支 + 未知命令兜底 `exit 2`。

### 1.3 背景③：`mesh up/restart` 实启 combined，但命名/输出像 backend `[confirmed]`

- `service.up()` 后台 spawn 的是**无子命令**的自身：`selfCmd(...passthrough, "--port", port, "--root", base)`（`src/service.ts:118`），其注释明说 *"No subcommand → combined SPA + API + WS, like production"*（`src/service.ts:117`）。即 `mesh up` 起的是 **combined Web+API**。
- 但用户可见输出与记录都叫 "backend"：`up` 打印 `backend up → http://localhost:${port}`（`src/service.ts:131`），`status` 打印 `backend : UP`（`src/service.ts:173`），状态文件是 `backend.json`/`backend.log`（`src/service.ts:25-26`）。
- 另有真正只起 REST+WS 的 `mesh backend`（`src/main.ts:167-178`，`startApiServer`）。命名冲突：`mesh up` 起的是 combined，却报成 "backend"；`mesh backend` 才是 headless backend。
- **修法方向**：术语统一。两选一（见 §2）：把 `mesh up` 报成 "control plane / console service"，或显式说明 "backend(=combined)"。文件名 `backend.json` 可保留（内部状态，改名涉及兼容）但 CLI 文案澄清。

### 1.4 背景④：`mesh down` 默认只停 backend、保留 daemons；`--cold` 才清 `[confirmed]`

- `down()` 默认 `SIGTERM→SIGKILL` 仅 backend 进程并删 `backend.json`（`src/service.ts:141-161`）；mesh daemon（子进程树）**故意保留**，供下次 backend `reattachRunning()` 重连（语义见 `src/main.ts:74-80`、`buildGateway` 注释）。
- 仅当 `--cold` 时才 `reapDaemons()`（`SIGTERM→SIGKILL` 每个 daemon + 扫孤儿 socket，`src/service.ts:80-85, 162-165`）。
- `restart` 同理：hot 保活 daemon，`--cold` 先 reap（且 cold 会派 detached worker 以免自杀，`src/service.ts:185-199`）。
- **问题**：`down`/`restart` 的 hot vs cold 语义对用户不透明（"为什么 down 之后 agent 还在跑？"）。与既有记忆口径一致：热重启=保活 agent，冷重启=reap 整套。
- **修法方向**：纯文案/usage 澄清（`down` 打印时点明"mesh daemons 仍在运行，用 `--cold` 一并停止"），**不改行为**。

### 1.5 背景⑤：只读命令因 assistant harness flag/env 非法而失败 `[confirmed]`（最高优先级）

- `parseAssistantHarness(process.argv)` 在**命令分发之前无条件调用**（`src/main.ts:48`），其实现对非法值**抛异常**：

```ts
// src/cli-options.ts:11-20
export function parseAssistantHarness(args, env = process.env): HarnessId {
  const raw = argVal(args, "--assistant-harness") ?? … ?? env.MESH_ASSISTANT_HARNESS ?? … ?? DEFAULT_ASSISTANT_HARNESS;
  if (raw in HARNESSES) return raw as HarnessId;
  throw new Error(`invalid assistant harness "${raw}" (use …)`);
}
```

- 因此 `MESH_ASSISTANT_HARNESS=bogus mesh status`（或 `mesh doctor --assistant-harness bogus`）会在跑到 `status/ps/doctor` **之前抛错**，尽管这些命令**根本不需要 assistant**。`assistantCliDeprecationWarnings`（`main.ts:47`）也无条件执行（仅 warning，无害，但同样是"启动期才需要的解析过早执行"）。
- 只读/配置命令（`status`/`ps`/`doctor`/`device`/`feishu`/`auth`/`logs`/`kill`）均不构造 `MeshAssistant`，只有 `buildGateway()`（`up`/`restart`/`backend`/`console` 路径）才用到 `assistantHarness`（`src/main.ts:67`）。
- **硬目标**：只在真正需要启动 control plane 的路径解析 assistant harness。
- **修法方向**：把 `parseAssistantHarness`/deprecation 解析**下沉到 `buildGateway()`（或启动类分支内）**，不在顶层无条件执行。

### 1.6 背景⑥：顶层 `mesh feishu …` 不合理，应走 `mesh channels feishu …` `[confirmed]`

- 现状：`mesh feishu …` 与 `mesh device`/`mesh auth` 一起，由 `main.ts:163-166` 的 `cmd === "device" || cmd === "feishu" || cmd === "auth"` 分支统一委派给 `runAuthCommand(root, cmd, argv.slice(3))`（`src/auth-cli.ts:276-325`）。
- `feishu` 子命令在 `auth-cli.ts` 内是一个 group：`list` / `approve <code>` / `revoke <channelKey> <openId>`（`src/auth-cli.ts:140-211, 265-269, 309-313`）。文档亦以顶层形式记录（`docs/device-auth-operations.md:99-101`）。
- **问题**：`feishu` 是众多潜在 channel provider 之一，挂在顶层与 `device`/`auth`（设备/密钥域）混在一起，不利扩展（背景⑦）。
- **目标入口**：`mesh channels feishu list | approve <code> | revoke <channelKey> <openId>`；旧 `mesh feishu …` 保留为 **deprecated alias + warning**。

### 1.7 背景⑦：命令结构需支持更多 channels provider `[confirmed/inference]`

- 当前 channel 抽象已存在：`createFeishuChannelController`（`src/channels`，`main.ts:20,70-72`）、`gw.feishuChannel()` 等；但 **CLI 侧**没有 `channels` 命名空间，feishu 直接顶层。
- `auth-cli.ts` 的 `USAGE` 表与 `runAuthCli` 的 `group` 分派（`src/auth-cli.ts:259-271, 292-325`）是按 `device|feishu|auth` 平铺的，新增 provider 需再加一个顶层词。
- **修法方向**：引入 `channels <provider> <action>` 子命令树，provider 注册表化（见 §2.3），feishu 成为其下第一个 provider；`device`/`auth` 留在顶层（属设备/密钥域，非 channel）。

---

## 2. 推荐命令结构 `[proposal]`

### 2.1 顶层分组

把命令显式分为三组，并用一张**命令表**（而非裸 if/else 链）描述：

```
启动类（构造 control plane / gateway，需要 assistant harness 解析）
  mesh                      启动 combined Web/API 控制台（前台）         ← 背景①保留，显式化
  mesh console              同上的显式别名（推荐文档主入口）             ← 可选
  mesh up / start           后台启动 combined control plane（service.up）
  mesh down / stop          停 control plane（保留 daemons；--cold 同时 reap）
  mesh restart              重启（hot 保活 daemons；--cold reap，派 detached worker）
  mesh backend              headless REST+WS（startApiServer）
  mesh web --backend URL    仅 SPA + 反代（startWebServer proxy 模式）

只读 / 配置类（绝不需要 assistant harness，绝不启动服务）
  mesh status               control plane up/down + 端口 + 运行中 meshes
  mesh ps [-v]              运行中 mesh daemons（-v 走 shared diagnostics）
  mesh doctor               系统体检（diagnostics；仅 error 非零退出）
  mesh logs [-f]            backend.log
  mesh kill <name>|--all    停指定/全部 mesh daemon
  mesh device  …            设备授权（list/approve/revoke）
  mesh auth    …            授权密钥（list/rotate-key/bootstrap）

channels 子命令树（外部对话渠道；可扩展多 provider）
  mesh channels feishu list
  mesh channels feishu approve <code>
  mesh channels feishu revoke <channelKey> <openId>
  （未来：mesh channels <provider> …）

help
  mesh help | --help | -h   打印 usage，exit 0，不启动服务
```

### 2.2 help / usage / 未知命令形态

- 维护一张 `COMMANDS` 表：`{ name, group, summary, run }`（以及 alias 映射，如 `start→up`、`stop→down`）。
- `mesh help` / `mesh --help` / `mesh -h` → 按 group 渲染 usage，**exit 0**，不进入任何 `run`。
- 未知命令（解析出的命令名不在表内且非 help）→ 打印 `unknown command '<x>'` + 顶层 usage 到 **stderr**，**`process.exitCode = 2`**，**不启动服务**。这与既有 `mesh kill` 无参时的 `exitCode = 2`（`src/main.ts:160-161`）一致。
- 裸 `mesh`（无任何位置参数）→ 显式映射到"启动 combined 控制台"（背景①），**不走兜底分支**。

### 2.3 全局 flag 前置/后置解析方案

**复用已存在的 `src/args.ts::parseArgs`**（位置无关解析器：支持 `--k=v`、`--k v`、布尔 `--k`、`--` 终止符；`src/args.ts:6-41`）。当前 `main.ts` 未使用它（仅被 `pty-room.ts`/`mailbox-*.ts` 等脚本使用，见消费者列表），改用它即可一举解决前/后置问题：

- 用 `parseArgs(process.argv.slice(2))` 得到 `{ values, rest }`。
- **命令名 = `rest[0]`**（第一个非 flag 位置参数），子动作 = `rest[1]`…。这样 `mesh --root . status` 与 `mesh status --root .` 解析出的命令名都是 `status`。
- global flags 从 `values` 读取（`--root`/`--port`/`--host`/`--fake`/`--cold`/`--no-assistant`/…），天然前后置无关。
- 兼容现有取值点：`svcPort`（`main.ts:118`）、`svcCold`（`:119`）、`base`/`--root`（`:52`）、`hostname`/`--host`（`:54`）改为从 `values` 读取（语义不变）。
- **保留**对 auth 子命令的"原样透传"：`device|auth|channels feishu` 的动作与位置参数（`approve <code>`、`revoke <channelKey> <openId>`、`--label`、`--ttl`）目前由 `auth-cli.ts` 自己用 `takeFlag` 解析（`src/auth-cli.ts:63-70`），应继续把"命令名之后的原始 token"交给它，避免顶层 `parseArgs` 吃掉 `--label/--ttl`。实现上：顶层只用 `rest[0]` 定位 group，把 `rest.slice(...)` 原样下传（等价于今天的 `argv.slice(3)`，`main.ts:166`）。

> 设计取舍 `[inference]`：顶层 `parseArgs` 与子命令本地 `takeFlag` 并存是有意的——顶层只需识别"命令名 + 全局 flag"，子命令域（auth/channels）有自己的 flag 文法，保持其解析自治最稳，改动面最小。

---

## 3. 兼容策略 `[proposal]`

### 3.1 Deprecated alias + warning

- `mesh feishu …` → 等价于 `mesh channels feishu …`，但在 stderr 打印一次 `--`feishu`` is deprecated; use `mesh channels feishu …``。复用既有"deprecation warning"风格（参考 `assistantCliDeprecationWarnings`，`src/cli-options.ts:26-33`）。
- `start`/`stop` 继续作为 `up`/`down` 的 alias（`src/main.ts:122,124` 已如此），保留。
- 旧 assistant flag alias（`--master-harness`/`--no-master`/`MESH_MASTER_HARNESS`）的 deprecation warning 维持（`cli-options.ts:26-33`），但**仅在启动类路径触发**（随解析下沉，背景⑤修复的副产物）。

### 3.2 不破坏 `scripts/update.sh`

- `update.sh` 唯一依赖的 CLI 形态是 `${RESTART_CMD} restart --root "$BASE" --port "$PORT" [--cold]`（`scripts/update.sh:146-147`，`RESTART_CMD` 默认即 mesh 二进制 / `bun run src/main.ts`）。
- 该形态是"**子命令在前、全局 flag 在后**"，新解析（命令名=第一个非 flag 位置参数）**完全兼容**；`--cold` 经 `values.cold` 读取，语义不变（`restart` 仍走 `service.restart`，`main.ts:128-129`）。
- 输出文案若调整（背景③），需确保 `update.sh` 的健康判定不依赖被改字符串：它用 HTTP `/api/state` 探活（`MESH_HEALTH_TIMEOUT`，`update.sh:42`），**不** grep `backend up`，故安全。

### 3.3 不破坏现有 e2e

- `src/web/service.e2e.ts` 以 `mesh <cmd> … --root BASE --port PORT` 形态驱动（子命令在前、全局 flag 在后，`service.e2e.ts:30-34, 60-93`），与新解析兼容。
- 它**断言固定输出串**：`backend : DOWN`（`:61`）、`backend up`（`:67`）、`already running`（`:80`）、`backend : UP (pid N)`（`:75`）。**约束**：若背景③改这些文案，必须在**同一 commit** 同步更新 e2e 断言（见 §4 阶段 C / §5）。若仅做"追加澄清行"而不改既有串，可零改动 e2e。

---

## 4. 具体实现步骤（分阶段 commit）`[proposal]`

> 每个 commit 后 STOP 等批（per-commit 纪律）。受影响文件已标注;均不改变启动行为本身，只改分发/解析/文案。

- **Commit 1 — 分发骨架（无行为回归）**
  - 文件：`src/main.ts`。
  - 引入 `parseArgs`（`src/args.ts`）求 `{ values, rest }`；命令名取 `rest[0]`；全局 flag 改从 `values` 读。
  - 加显式 `help`/`--help`/`-h` 分支（exit 0 + usage）与**未知命令兜底**（stderr usage + `exitCode = 2`，不启动）。
  - 裸 `mesh`（`rest.length === 0` 且非 help）→ 显式 console 启动分支。
  - 硬目标覆盖：未知命令 exit 2、help、global flag 前/后置（1.2 + 2.3）。

- **Commit 2 — assistant harness 解析下沉（背景⑤）**
  - 文件：`src/main.ts`（必要时 `src/cli-options.ts` 不改 API，仅调用点移动）。
  - 把 `parseAssistantHarness` / `assistantCliDeprecationWarnings` 调用从顶层（`main.ts:47-48`）移入 `buildGateway()` 或启动类分支；只读命令路径不再触碰它。
  - 硬目标覆盖：只读命令不因 assistant harness 非法而失败。

- **Commit 3 — `channels` 子命令树 + feishu deprecated alias（背景⑥⑦）**
  - 文件：`src/main.ts`（新增 `channels` 分支）、`src/auth-cli.ts`（`runAuthCli` 接受 `channels feishu` 路由 / 或新增 `runChannelsCli` 复用现有 `feishuList/approve/revoke`）。
  - `mesh channels feishu …` 为正式入口；`mesh feishu …` → 同实现 + 一次性 deprecation warning。
  - provider 注册表化预留（`channels` → `{ feishu: { list, approve, revoke } }`）。
  - 硬目标覆盖：`mesh channels feishu …` 正式 + alias warning。

- **Commit 4 — 文案/术语澄清（背景①③④）**
  - 文件：`src/main.ts`（console 启动打印）、`src/service.ts`（`up`/`down`/`status`/`restart` 文案，仅追加澄清，不删既有串以保 e2e）、`README.md` + `docs/device-auth-operations.md`（命令表更新）。
  - `down` 明示"mesh daemons 仍在运行；`--cold` 一并 reap"。
  - 若必须改既有输出串，则与 `service.e2e.ts` 断言同 commit 更新。

> 注：阶段顺序可调；Commit 1 是其余的前置。每阶段都应能独立 `tsc + test + service.e2e` 绿。

---

## 5. 测试计划 `[proposal]`

新增/修改测试清单（建议放 `src/main.dispatch.test.ts` 或抽出可测的 `dispatch()` 纯函数后单测；e2e 走 `service.e2e`）：

1. **未知命令**：`mesh frobnicate` → `exitCode === 2`，stderr 含 usage，**不启动服务**（无监听端口）。
2. **help**：`mesh help` / `mesh --help` / `mesh -h` → exit 0，stdout 含分组 usage，不启动服务。
3. **global flag 前置**：`mesh --root . --port 10010 status` 与**后置** `mesh status --root . --port 10010` 解析出同一命令 `status`、同一 root/port。
4. **裸 `mesh`**：仍启动 combined console（保留背景①；可在 fake 模式断言打印 `web console`）。
5. **assistant harness 隔离**（背景⑤）：`MESH_ASSISTANT_HARNESS=bogus mesh status`（及 `mesh doctor --assistant-harness bogus`）→ 正常输出、**不抛错**；而 `mesh up --assistant-harness bogus` 仍应报错（启动路径才校验）。
6. **channels feishu alias**（背景⑥）：`mesh channels feishu list` 正常；`mesh feishu list` 输出相同 + stderr 一次 deprecation warning；二者退出码一致。
7. **channels 未知 provider**：`mesh channels nope` → exit 2 + usage。
8. **`service.e2e` 兼容**：保持 `up/status/restart/down` 全绿（断言串不变；若改文案则同步）。
9. **scripts/update.sh 形态**：`mesh restart --root X --port Y --cold` 命令名仍解析为 `restart`、`--cold` 生效（可用 dispatch 单测覆盖，避免真重启）。
10. **`mesh kill` 既有 exit 2 行为**（`main.ts:160-161`）不回归。

> 本任务交付物是文档，**未跑** `tsc`/`bun test`/e2e（无功能代码改动）。上述为实现阶段（Commit 1–4）的验证清单。

---

## 6. 潜在风险 + 规避

1. **改动 `main.ts` 顶层解析引入回归** → 规避：先抽出纯函数 `resolveCommand(argv): { cmd, action, rest, values }` 并单测（测试计划 1–3,5,9 可纯函数覆盖），`runCli` 只做 IO；分阶段 commit，每步跑 `service.e2e`。
2. **改输出文案打破 `service.e2e` 断言**（`service.e2e.ts:61,67,75,80`）→ 规避：默认只"追加澄清行"，确需改串则同 commit 改断言（§3.3）。
3. **`scripts/update.sh` 静默失效** → 规避：保持 `mesh restart <flags-after>` 与 `--cold` 语义；不依赖输出串（update.sh 用 HTTP 探活，§3.2）。
4. **顶层 `parseArgs` 误吞子命令 flag**（如把 `--label`/`--ttl`/`--backend` 当全局）→ 规避：命令名后原样下传 `rest.slice(...)` 给 `auth-cli`/`channels`，不在顶层消费子域 flag（§2.3 取舍）。
5. **assistant 解析下沉遗漏某启动路径**（`up`/`restart`/`backend`/`console` 都需要）→ 规避：集中在 `buildGateway()` 内解析（`up`/`restart` 经 detached 子进程二次进入 `buildGateway`，天然覆盖；`backend`/`console` 直接调用 `buildGateway`）。
6. **deprecated alias 长期堆积** → 规避：warning 文案标注移除窗口；`feishu`→`channels feishu`、`--master-*`→`--assistant-*` 统一在 `cli-options` 风格集中管理。
7. **`mesh up` 误被理解为只起 backend**（背景③命名）→ 规避：CLI 文案统一为 "control plane (combined Web+API)"；内部文件名 `backend.json`/`backend.log` 暂不改（改名涉及历史记录/兼容，价值低风险高），仅在文档注明二者关系。

---

## 附录 A：硬目标覆盖核对

| 硬目标 | 覆盖位置 | 验证 |
|---|---|---|
| 未知命令 exit 2 + usage，不启动 | §2.2, §4 Commit 1 | 测试 1 |
| `mesh help` / `mesh --help` 输出 usage，不启动 | §2.2, §4 Commit 1 | 测试 2 |
| global flag 前置 + 后置都支持 | §2.3（复用 `args.ts::parseArgs`，命令名=首个非 flag 位置参数） | 测试 3 |
| 只在需要启动 control plane 时解析 assistant harness | §1.5, §4 Commit 2（下沉到 `buildGateway()`） | 测试 5 |
| `mesh channels feishu …` 正式入口；`mesh feishu …` deprecated alias + warning | §2.1, §2.3, §4 Commit 3 | 测试 6 |
| 不破坏 `scripts/update.sh` 与现有 e2e | §3.2, §3.3 | 测试 8, 9 |

## 附录 B：关键代码坐标（便于实现期定位）

- 命令名启发式：`src/main.ts:43-44`；全局 flag 取值：`src/main.ts:38-42`。
- 兜底 `else`（启动 combined 控制台）：`src/main.ts:185-198`。
- 启动类分支：`up/down/status/restart/logs` `src/main.ts:122-131`；`backend` `:167-178`；`web` `:179-184`。
- 只读/授权分支：`ps` `:132-144`；`doctor` `:145-149`；`kill` `:150-162`；`device|feishu|auth` `:163-166`。
- assistant 解析（需下沉）：`src/main.ts:47-48` → 实现 `src/cli-options.ts:11-33`；唯一使用点 `src/main.ts:67`（`buildGateway`）。
- service 语义：`up` `src/service.ts:99-138`；`down`（hot/cold）`:141-166`；`status` `:169-180`；`restart`（cold detached worker）`:185-202`；`reapDaemons` `:80-85`。
- auth/feishu CLI：dispatcher `src/auth-cli.ts:292-325`；`USAGE` 表 `:259-271`；feishu 实现 `:140-211`。
- 复用解析器：`src/args.ts:6-41`（`parseArgs`/`stringArg`/`booleanArg`）。
- 兼容锚点：`scripts/update.sh:146-147`（`restart --root --port [--cold]`）；`src/web/service.e2e.ts:30-93`（输出串断言）。
- 文档现状：`README.md:316-321`（service 命令）；`docs/device-auth-operations.md:81-114`（device/feishu/auth 命令表）。
