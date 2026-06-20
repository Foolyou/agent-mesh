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

本文给出：① 逐条问题定位；② 一个带显式命令表 + **有界 schema resolver**（已知全局选项 arity 表 + 在首个命令 token 处停下 + tail verbatim）的分发结构（启动类 / 只读·配置类 / `channels` 子命令树）——**刻意不用裸 `src/args.ts::parseArgs` 做顶层解析**（它贪婪吞 `--flag <next>`，会吃掉命令名与子命令本地 flag，详见 §2.3）；③ 不破坏 `scripts/update.sh` 与现有 e2e 的兼容策略；④ 分阶段 commit 实现步骤；⑤ 测试计划；⑥ 风险与规避。

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

### 2.3 全局 flag 前置/后置解析方案——**有界 schema resolver，不用裸 `parseArgs`**

> ⚠️ **不能复用 `src/args.ts::parseArgs` 做顶层解析**。它对 `--flag <next-non---token>` 一律贪婪吞值（`src/args.ts:30-37`），会破坏硬目标：
> - **布尔全局吃掉命令**：`parseArgs(["--fake","status"])` → `values.fake = "status"`、`rest = []`，命令名丢失（误判 console）。
> - **子命令本地 flag 被顶层吞掉**：对整段 argv 跑 `parseArgs` 时，`device approve CODE --label laptop` 的 `--label laptop`、`auth bootstrap --ttl 60` 的 `--ttl 60` 会被顶层当成全局键值吃走，`auth-cli` 永远收不到。
>
> `parseArgs` 仍保留给它现有的脚本消费者（`pty-room.ts`/`mailbox-*.ts` 等），但**顶层命令分发改用下述有界 resolver**；子命令域继续用 `auth-cli` 自己的 `takeFlag`（`src/auth-cli.ts:63-70`）。

**核心思路**：顶层只认识"已知全局选项 + 其 arity"，在**第一个命令 token 处停下**；命令之后的 tail 原样保留给命令本地解析器，只从 tail 里**剥离明确已知的全局选项**，其余（未知 flag、子命令 flag 及其值）一律不动。

**已知全局选项 arity 表**（仅这些会被顶层消费；其它一切留给命令本地）：

| 选项 | arity | 备注 |
|---|---|---|
| `--root <v>` / `--port <v>` / `--host <v>` / `--backend <v>` | 1（取值；亦支持 `--k=v`） | 启动/服务全局 |
| `--assistant-harness <v>` / `--master-harness <v>`(deprecated) | 1 | 仅启动路径用（见背景⑤下沉） |
| `--fake` / `--cold` / `--no-assistant` / `--no-mesh-assistant` / `--no-master` | 0（布尔） | |
| `--help` / `-h` / 字面 `help` | 0（最高优先级） | 任意位置出现即 help 模式，exit 0，不启动 |

> 命令本地 flag（**不**在表内，必须原样保留）：`ps -v/--verbose`、`logs -f/--follow`、`kill -a/--all`、`device approve --label`、`auth bootstrap --ttl` 等。

**`resolveCommand(argv)` 算法**（`argv = process.argv.slice(2)`）：

1. **前缀扫描**（定位命令）：从左到右逐 token：
   - help token（`--help`/`-h`/`help`）→ 立即返回 `{ mode: "help" }`（exit 0）。
   - 已知**取值**全局 → 收进 `globals`，跳过其值（`--k=v` 自带值）。
   - 已知**布尔**全局 → 收进 `globals`。
   - **未知 `-`/`--` 开头 token**（此刻还没有命令拥有它）→ 返回 `{ mode: "error", msg: "unknown option <x>" }`，**exit 2**（绝不静默启动 console）。
   - 第一个**非 flag 位置 token** → 即命令名 `command`，停止前缀扫描。
   - 扫到末尾仍无命令 → `command = "(console)"`（裸 `mesh` / `mesh --root .` 等只带全局的形态，背景①）。
2. **tail = `argv` 中命令 token 之后的全部 token**（verbatim）。
3. **从 tail 剥离已知全局**（实现后置全局，同时不碰子命令 flag）：逐 token：
   - 已知取值全局 → 收进 `globals`，跳过其值；取值全局在 tail 末尾缺值 → `error` exit 2。
   - 已知布尔全局 → 收进 `globals`。
   - **其它一切**（未知 flag、子命令动作、位置参数、子命令 flag 及其值）→ **push 进 `commandTail`，原样不动**。
4. 返回 `{ mode: "run", command, globals, commandTail }`。命令本地解析器拿到的就是 `commandTail`（等价于今天的 `argv.slice(3)`，但前后置全局已被剥净），交给 `auth-cli`/`channels`/`ps`/`logs`/`kill` 各自解析。

**为什么满足全部硬目标**（逐例）：

| 输入 | 前缀扫描 | tail 剥离 | 结果 |
|---|---|---|---|
| `mesh --fake status` | `--fake`(bool)→globals；`status`→command | — | command=`status`，globals.fake ✓（不再误判 console） |
| `mesh --cold restart` | `--cold`(bool)→globals；`restart`→command | — | command=`restart`，globals.cold ✓ |
| `mesh restart --cold` | `restart`→command | `--cold`(bool)→globals | command=`restart`，globals.cold ✓ |
| `mesh --root . status` / `mesh status --root .` | 见上，两式 command 均=`status` | `--root .` 剥入 globals | root 一致 ✓ |
| `mesh device approve CODE --label laptop` | `device`→command | `--label`/`laptop` 非全局→保留 | commandTail=`["approve","CODE","--label","laptop"]`，`auth-cli` 收到 `--label laptop` ✓ |
| `mesh auth bootstrap --ttl 60` | `auth`→command | `--ttl`/`60` 非全局→保留 | commandTail=`["bootstrap","--ttl","60"]`，`auth-cli` 收到 `--ttl 60` ✓ |
| `mesh ps -v` / `mesh logs -f` | `ps`/`logs`→command | `-v`/`-f` 非全局→保留 | 命令本地 flag 不被吞 ✓ |
| `mesh frobnicate` | `frobnicate`→command | — | 命令名不在表 → §2.2 未知命令 exit 2 ✓ |
| `mesh --bogus status` | `--bogus` 未知前缀 flag | — | error exit 2（不启动）✓ |

- 兼容现有取值点：`svcPort`（`main.ts:118`）、`svcCold`（`:119`）、`base`/`--root`（`:52`）、`hostname`/`--host`（`:54`）改为从 `globals` 读取（语义不变）。

> 设计取舍 `[inference]`：顶层"已知全局 arity 表 + 停在命令处 + tail verbatim"与子命令本地 `takeFlag` 并存是有意的——顶层只认全局词表，绝不臆测子命令文法；任何不在表内的 flag 都属于命令本地，原样下传。这既支持全局前/后置，又保证 `--label`/`--ttl`/`-v`/`-f` 永不被顶层吞掉，且改动面集中在一个可纯函数单测的 `resolveCommand`。

---

## 3. 兼容策略 `[proposal]`

### 3.1 Deprecated alias + warning

- `mesh feishu …` → 等价于 `mesh channels feishu …`，但在 stderr 打印一次 `--`feishu`` is deprecated; use `mesh channels feishu …``。复用既有"deprecation warning"风格（参考 `assistantCliDeprecationWarnings`，`src/cli-options.ts:26-33`）。
- `start`/`stop` 继续作为 `up`/`down` 的 alias（`src/main.ts:122,124` 已如此），保留。
- 旧 assistant flag alias（`--master-harness`/`--no-master`/`MESH_MASTER_HARNESS`）的 deprecation warning 维持（`cli-options.ts:26-33`），但**仅在启动类路径触发**（随解析下沉，背景⑤修复的副产物）。

### 3.2 不破坏 `scripts/update.sh`

- `update.sh` 唯一依赖的 CLI 形态是 `${RESTART_CMD} restart --root "$BASE" --port "$PORT" [--cold]`（`scripts/update.sh:146-147`，`RESTART_CMD` 默认即 mesh 二进制 / `bun run src/main.ts`）。
- 该形态是"**子命令在前、全局 flag 在后**"：`resolveCommand` 前缀扫描即得 command=`restart`，tail 里的 `--root/--port/--cold` 都是已知全局、被剥进 `globals`，`commandTail` 为空——**完全兼容**；`globals.cold` 驱动 `service.restart`（语义不变，`main.ts:128-129`）。
- 输出文案若调整（背景③），需确保 `update.sh` 的健康判定不依赖被改字符串：它用 HTTP `/api/state` 探活（`MESH_HEALTH_TIMEOUT`，`update.sh:42`），**不** grep `backend up`，故安全。

### 3.3 不破坏现有 e2e

- `src/web/service.e2e.ts` 以 `mesh <cmd> … --root BASE --port PORT` 形态驱动（子命令在前、全局 flag 在后，`service.e2e.ts:30-34, 60-93`），与新解析兼容。
- 它**断言固定输出串**：`backend : DOWN`（`:61`）、`backend up`（`:67`）、`already running`（`:80`）、`backend : UP (pid N)`（`:75`）。**约束**：若背景③改这些文案，必须在**同一 commit** 同步更新 e2e 断言（见 §4 阶段 C / §5）。若仅做"追加澄清行"而不改既有串，可零改动 e2e。

---

## 4. 具体实现步骤（分阶段 commit）`[proposal]`

> 每个 commit 后 STOP 等批（per-commit 纪律）。受影响文件已标注;均不改变启动行为本身，只改分发/解析/文案。

- **Commit 1 — 分发骨架 + 有界 resolver（无行为回归）**
  - 文件：`src/main.ts`（+ 可新增 `src/cli-dispatch.ts` 放纯函数 `resolveCommand`，便于单测）。
  - 实现 §2.3 的 `resolveCommand(argv)`：已知全局选项 arity 表（`GLOBAL_VALUE`/`GLOBAL_BOOL`/help）、前缀扫描停在首个命令 token、tail verbatim、从 tail 剥离已知全局、未知前缀 flag → error exit 2。**不**用裸 `parseArgs`。
  - 全局 flag 改从 `globals` 读；命令本地参数用 `commandTail` 原样下传（替换今天的 `argv.slice(3)`，`main.ts:166`）。
  - 加显式 `help`/`--help`/`-h` 分支（exit 0 + usage）与**未知命令兜底**（stderr usage + `exitCode = 2`，不启动）。
  - 裸 `mesh`（无命令 token 且非 help）→ 显式 console 启动分支。
  - 硬目标覆盖：未知命令/未知前缀 flag exit 2、help、global flag 前/后置、布尔全局不吃命令、子命令本地 flag 不被吞（1.2 + 2.3）。

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

新增/修改测试清单。大部分用 `resolveCommand` 纯函数单测覆盖（建议 `src/cli-dispatch.test.ts`），无需真起进程；服务形态走 `service.e2e`：

1. **未知命令**：`resolveCommand(["frobnicate"])` → 命令名不在表 → `exitCode === 2`，stderr 含 usage，**不启动服务**。
2. **未知前缀 flag**：`resolveCommand(["--bogus","status"])` → `mode:"error"`，exit 2，不启动。
3. **help**：`mesh help` / `mesh --help` / `mesh -h`（含 `mesh status --help`）→ `mode:"help"`，exit 0，含 usage，不启动。
4. **布尔全局不吃命令**（reviewer）：`resolveCommand(["--fake","status"])` → command=`status`、`globals.fake===true`（**不是** `all`/console）。
5. **cold 前/后置**（reviewer）：`resolveCommand(["--cold","restart"])` 与 `resolveCommand(["restart","--cold"])` 都得 command=`restart`、`globals.cold===true`。
6. **取值全局前/后置**：`mesh --root . --port 10010 status` 与 `mesh status --root . --port 10010` 解析出同一命令 `status`、同一 root/port。
7. **device 本地 flag 保留**（reviewer）：`resolveCommand(["device","approve","CODE","--label","laptop"])` → `commandTail === ["approve","CODE","--label","laptop"]`（`--label laptop` 完整到达 `auth-cli`）。
8. **auth 本地 flag 保留**（reviewer）：`resolveCommand(["auth","bootstrap","--ttl","60"])` → `commandTail === ["bootstrap","--ttl","60"]`。
9. **命令本地短 flag 不被吞**：`mesh ps -v` / `mesh logs -f` / `mesh kill --all` 的 `-v`/`-f`/`--all` 留在 `commandTail`。
10. **裸 `mesh` / 仅全局**：`resolveCommand([])` 与 `resolveCommand(["--root","."])` → console 模式（保留背景①，root 被采纳）。
11. **assistant harness 隔离**（背景⑤）：`MESH_ASSISTANT_HARNESS=bogus mesh status`（及 `mesh doctor --assistant-harness bogus`）→ 正常输出、**不抛错**；而 `mesh up --assistant-harness bogus` 仍应报错（启动路径才校验）。
12. **channels feishu alias**（背景⑥）：`mesh channels feishu list` 正常；`mesh feishu list` 输出相同 + stderr 一次 deprecation warning；二者退出码一致。
13. **channels 未知 provider**：`mesh channels nope` → exit 2 + usage。
14. **`service.e2e` 兼容**：保持 `up/status/restart/down` 全绿（断言串不变；若改文案则同步）。
15. **scripts/update.sh 形态**：`resolveCommand(["restart","--root","X","--port","Y","--cold"])` → command=`restart`、root/port/cold 全部进 `globals`，`commandTail===[]`。
16. **`mesh kill` 既有 exit 2 行为**（`main.ts:160-161`）不回归。

> 本任务交付物是文档，**未跑** `tsc`/`bun test`/e2e（无功能代码改动）。上述为实现阶段（Commit 1–4）的验证清单。

---

## 6. 潜在风险 + 规避

1. **改动 `main.ts` 顶层解析引入回归** → 规避：先抽出纯函数 `resolveCommand(argv): { mode, command, globals, commandTail }` 并单测（测试计划 1–10, 15 可纯函数覆盖），`runCli` 只做 IO；分阶段 commit，每步跑 `service.e2e`。
2. **改输出文案打破 `service.e2e` 断言**（`service.e2e.ts:61,67,75,80`）→ 规避：默认只"追加澄清行"，确需改串则同 commit 改断言（§3.3）。
3. **`scripts/update.sh` 静默失效** → 规避：保持 `mesh restart <flags-after>` 与 `--cold` 语义；不依赖输出串（update.sh 用 HTTP 探活，§3.2）。
4. **顶层解析误吞命令名/子命令 flag**（reviewer High：裸 `parseArgs` 会让 `--fake status`→`fake="status"`、把 `--label`/`--ttl` 当全局吃走，`src/args.ts:30-37`）→ 规避：**不在顶层用 `parseArgs`**；改用 §2.3 有界 `resolveCommand`——只认已知全局 arity 表、停在首个命令 token、tail 仅剥已知全局、其余原样进 `commandTail` 下传 `auth-cli`/`channels`。该函数纯函数可单测（测试 4–9, 15）。
5. **assistant 解析下沉遗漏某启动路径**（`up`/`restart`/`backend`/`console` 都需要）→ 规避：集中在 `buildGateway()` 内解析（`up`/`restart` 经 detached 子进程二次进入 `buildGateway`，天然覆盖；`backend`/`console` 直接调用 `buildGateway`）。
6. **deprecated alias 长期堆积** → 规避：warning 文案标注移除窗口；`feishu`→`channels feishu`、`--master-*`→`--assistant-*` 统一在 `cli-options` 风格集中管理。
7. **`mesh up` 误被理解为只起 backend**（背景③命名）→ 规避：CLI 文案统一为 "control plane (combined Web+API)"；内部文件名 `backend.json`/`backend.log` 暂不改（改名涉及历史记录/兼容，价值低风险高），仅在文档注明二者关系。

---

## 附录 A：硬目标覆盖核对

| 硬目标 | 覆盖位置 | 验证 |
|---|---|---|
| 未知命令（及未知前缀 flag）exit 2 + usage，不启动 | §2.2, §2.3, §4 Commit 1 | 测试 1, 2 |
| `mesh help` / `mesh --help` 输出 usage，不启动 | §2.2, §4 Commit 1 | 测试 3 |
| global flag 前置 + 后置都支持（布尔不吃命令） | §2.3（有界 `resolveCommand`：已知全局 arity 表 + 停在首个命令 token + tail 仅剥已知全局） | 测试 4, 5, 6 |
| 子命令本地 flag 不被顶层吞（`--label`/`--ttl`/`-v`/`-f`） | §2.3（tail verbatim，非全局原样进 `commandTail`） | 测试 7, 8, 9 |
| 只在需要启动 control plane 时解析 assistant harness | §1.5, §4 Commit 2（下沉到 `buildGateway()`） | 测试 11 |
| `mesh channels feishu …` 正式入口；`mesh feishu …` deprecated alias + warning | §2.1, §2.3, §4 Commit 3 | 测试 12 |
| 不破坏 `scripts/update.sh` 与现有 e2e | §3.2, §3.3 | 测试 14, 15 |

## 附录 B：关键代码坐标（便于实现期定位）

- 命令名启发式：`src/main.ts:43-44`；全局 flag 取值：`src/main.ts:38-42`。
- 兜底 `else`（启动 combined 控制台）：`src/main.ts:185-198`。
- 启动类分支：`up/down/status/restart/logs` `src/main.ts:122-131`；`backend` `:167-178`；`web` `:179-184`。
- 只读/授权分支：`ps` `:132-144`；`doctor` `:145-149`；`kill` `:150-162`；`device|feishu|auth` `:163-166`。
- assistant 解析（需下沉）：`src/main.ts:47-48` → 实现 `src/cli-options.ts:11-33`；唯一使用点 `src/main.ts:67`（`buildGateway`）。
- service 语义：`up` `src/service.ts:99-138`；`down`（hot/cold）`:141-166`；`status` `:169-180`；`restart`（cold detached worker）`:185-202`；`reapDaemons` `:80-85`。
- auth/feishu CLI：dispatcher `src/auth-cli.ts:292-325`；`USAGE` 表 `:259-271`；feishu 实现 `:140-211`。
- `src/args.ts:6-41`（`parseArgs`/`stringArg`/`booleanArg`）——贪婪 `--flag <next>` 吞值在 `:30-37`，**不适合顶层分发**（见 §2.3）；顶层改用新 `resolveCommand`。
- 兼容锚点：`scripts/update.sh:146-147`（`restart --root --port [--cold]`）；`src/web/service.e2e.ts:30-93`（输出串断言）。
- 文档现状：`README.md:316-321`（service 命令）；`docs/device-auth-operations.md:81-114`（device/feishu/auth 命令表）。
