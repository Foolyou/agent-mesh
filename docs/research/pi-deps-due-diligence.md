# Pi 依赖上线前尽调（Phase A 信誉 + Phase B 安全取码/静态审计）

> Slug `pi-deps-due-diligence`，分支 `task/pi-deps-due-diligence`。**纯研究/审计，未改 src，未加 package.json/lockfile 依赖，未在仓库安装任何包。**
> **Phase A（不拉码）**：社区信誉、版本、维护者、已知安全公告、供应链红旗。**Phase B（已放行，本次完成）**：`npm pack`（仅下载 tarball，**绝不 install、绝不跑安装脚本**）+ `git clone` tag + tarball↔repo provenance + 全传递依赖树 + 安装脚本/危险模式静态扫描；终裁见 **§5 Phase B + §6 终裁**。**Phase B 深审仅 `pi-acp` + `pi-mcp-adapter`**（prdmgr 决定跳过 `@zhafron/pi-mcp-tools` 拉码，保留 NO-GO）。
> **取码/扫描全部在仓库外的隔离 scratch `/tmp/pi-audit`（独立 `HOME`、独立 npm cache、`npm_config_ignore_scripts=true`）完成**；仓库 worktree 内只写本文档。审计后 scratch 已清理。
> 数据采集时间：**2026-06-21**（npm/GitHub/OSV 当日快照；下载量为 2026-06-13~06-19 周）。基线 main：任务指定 `633c2c1`；实际从当前 main `f1c6391` 新建分支（docs-only，基线 commit 不影响审计内容，prdmgr 已接受）。

## 审核对象与范围
| 包 | 角色 | 重点 |
|---|---|---|
| `pi-acp`（repo svkozak/pi-acp） | 非官方 ACP 桥（Zed/ACP ↔ Pi） | **最脆弱、重点**，0.0.x 预发布 |
| `pi-mcp-adapter`（npm, repo nicobailon/pi-mcp-adapter, v2.10.0） | Pi 的 MCP 适配扩展 | 次重点，含 OAuth/Bearer 面 |
| `@zhafron/pi-mcp-tools` | 备选 MCP 工具扩展 | 顺带审查 |
| ~~`@earendil-works/pi-coding-agent`（Pi 主体）~~ | — | **用户已定不审，本文档不覆盖** |

---

## 0. Phase A 速览与初判

| 维度 | pi-acp | pi-mcp-adapter | @zhafron/pi-mcp-tools |
|---|---|---|---|
| 最新版 | **0.0.31**（pre-1.0） | **2.10.0** | **1.1.5** |
| 首发 / 末发 | 2025-12-20 / 2026-06-17 | 2026-01-19 / 2026-06-13 | 2026-02-17 / **2026-02-18** |
| 版本数 / 节奏 | 20 / 活跃（4 天前） | 35 / 很活跃（8 天前） | ~8 / **停更 4 个月** |
| 周下载 | ~10,158 | ~27,999 | **11**（几乎无人用） |
| ★ / forks / open issues | 461 / 72 / 31 | 906 / 168 / 71 | （仓库未细查，下载量极低） |
| 贡献者 / bus factor | 4 / **~1**（svkozak） | 8 / **~1**（近期 commit 全是 owner Nico Bailon） | 1 / **1**（zhafron） |
| License | MIT | MIT | MIT |
| deprecated | 否 | 否 | 否 |
| 安装脚本（install hook） | **无**（仅 prepack/prepublishOnly，发布侧） | **无**（仅 test 脚本） | `prepare: husky`（dev 钩子，registry 消费安装不触发） |
| npm provenance | publishConfig **声明 provenance:true**，但 registry attestations 端点查无（待 B 复核） | 未声明，attestations 查无 | 未声明 |
| OSV / GHSA 公告 | **无** | **无** | **无** |
| 关键运行依赖 | `@agentclientprotocol/sdk`(官方 ACP SDK 新 scope) + `zod` | `@earendil-works/pi-ai`+`pi-tui`(Pi 内部)、`@modelcontextprotocol/sdk`(官方)、`open`(开浏览器)、`recheck`、`typebox`、`zod` | `@modelcontextprotocol/sdk`、`@sinclair/typebox` |
| 官方性 | **社区第三方**（Pi 官方 ACP 支持仍在 discussion #175/#4444） | **社区第三方** Pi 扩展 | 社区第三方 |
| **Phase A 初判** | **CAUTION**（可控前提下倾向 GO） | **CAUTION**（倾向 GO） | **NO-GO 倾向** |

**一句话**：`pi-acp` 与 `pi-mcp-adapter` 都活跃、有真实采用、无已知 CVE、MIT。**Phase B 后的终裁（见 §6）**：`pi-acp` = **GO（pin + 监控）**——传递依赖仅 3 个、零安装脚本、零原生码、provenance 强（repo tag==gitHead）；`pi-mcp-adapter` = **CAUTION→条件 GO（必须沙箱化安装）**——运行期安全卫生良好，但 **217 个传递依赖含安装脚本（koffi 原生 FFI、protobufjs postinstall）+ recheck JAR/二进制**，必须 `--ignore-scripts`/剥离 postinstall/出口允许列表后才接入；`@zhafron/pi-mcp-tools` = **NO-GO**（已否，未拉码）。

---

## 1. pi-acp（重点）

### 1.1 身份与采集到的事实
- **npm**：`pi-acp@0.0.31`，MIT，`type: module`，`engines.node >=20`，`bin: pi-acp → dist/index.js`。author Sergii Kozak `<svkozak@gmail.com>`；maintainer `deepstereo <svkozak@icloud.com>`（同一人两邮箱）。repo `git+https://github.com/svkozak/pi-acp.git`。
- **发布节奏**：2025-12-20 首发 0.0.9 → 0.0.31（2026-06-17），20 个版本约 6 个月，近期 0.0.28~0.0.31 集中在 6 月中旬 → **活跃维护**。
- **GitHub svkozak/pi-acp**：★461、fork 72、open issues 31、watchers 2、贡献者约 4（实际近乎单人），未 archived、非 fork。
- **下载**：周 ~10,158（2026-06-13~19）。对一个 6 个月、0.0.x 的桥来说采用度不低（多半来自 Zed/ACP 生态尝鲜 + CI）。
- **依赖**（运行时极简）：`@agentclientprotocol/sdk ^0.26.0`、`zod ^3.25.0`。
  - ✅ 实证：`@agentclientprotocol/sdk`（latest 0.28.1，Apache-2.0，描述与官方 ACP 逐字一致）= **官方 ACP SDK 的新组织 scope**（ACP 从 `@zed-industries/agent-client-protocol` 迁移到 `@agentclientprotocol/sdk`）。**注意**：本仓当前用的是**旧** scope `@zed-industries/agent-client-protocol@0.4.5`，pi-acp 用新 scope `@agentclientprotocol/sdk@0.28.x`——**集成时存在 ACP SDK scope/版本错配**，需在接入设计里对齐（Phase B / 集成规划）。
- **安装脚本**：package.json scripts 仅 `prepack`/`prepublishOnly`（发布侧构建/测试），**无 `preinstall`/`install`/`postinstall`/`prepare`** → 消费方 `npm install` 不会触发任何脚本。✅
- **provenance**：package.json `publishConfig: { access: public, provenance: true }`（**声明**用 GitHub Actions OIDC 带 provenance 发布，正面信号）；但 `registry.npmjs.org/-/npm/v1/attestations/pi-acp@0.0.31` 返回 `not found`，**未能从该端点确认实际 attestation**（可能端点路径差异或未真正生成）——**列入 Phase B 复核**（npm 网页 Provenance 徽章 / `npm audit signatures`）。
- **安全公告**：OSV `api.osv.dev/v1/query` 查 `pi-acp`（npm）→ `{}`（**无**已知漏洞/公告；OSV 含 GHSA）。

### 1.2 功能定位（来自 README/DeepWiki 调研，未拉码）
`pi-acp` 把 Pi 经 `@earendil-works/pi-coding-agent` SDK 嵌入，**spawn `pi --mode rpc`**，在 stdio 上桥接 ACP JSON-RPC 2.0 ↔ Pi，供 Zed 等 ACP 客户端用。对我们而言它就是又一个 ACP host（类比 codex-acp / claude-agent-acp）。Zed 的 ACP agent 目录列了 "Pi"。

### 1.3 供应链红旗 / 名称混淆
- 🚩 **bus factor ~1**：实质单人（svkozak）维护，0.0.x，API 不稳定（"最脆弱"成立）。
- 🚩 **名称/来源混淆（重要）**：存在多个 "pi-acp" 变体——`victor-software-house/pi-acp`（搜索结果称其为"更新了社区原版的官方 VSH 版本"）、`gsd-pi-acp`（libraries.io 上另一个 npm 包）、以及 Zed ACP 目录里的 "Pi"。**npm 上的 `pi-acp` 包 = `svkozak/pi-acp`**。接入务必**钉死 `pi-acp@<exact ver>` + repo `svkozak/pi-acp` + 校验 tarball↔repo**，别误装同名/相近包。
- 🚩 **provenance 未实证**（见上）。
- ✅ 正面：无安装脚本、运行依赖极简且为官方 ACP SDK、MIT、活跃、采用度尚可、无 CVE。

### 1.4 Phase A 初判：**CAUTION**（可控前提下倾向 GO）
单人维护 + pre-1.0 + 名称混淆是主要保留项；但作为"经 stdio 的 ACP 桥、依赖极简、无安装脚本"，攻击面相对收敛。**前提**：钉死精确包/repo、Phase B 通过代码审计。

### 1.5 Phase B 重点（待放行）
1. `npm pack pi-acp@0.0.31`（**不跑安装脚本**）+ `git clone --branch <tag> svkozak/pi-acp`，**核对 tarball ↔ repo provenance**，确认 npm Provenance 徽章是否真实。
2. 进程模型审计：如何 `spawn('pi', ['--mode','rpc'])`、参数/env 透传、stdio 桥接、子进程生命周期/teardown（孤儿风险，呼应本仓 codex-acp 孤儿经验）。
3. 危险模式扫描：`eval`/`new Function`、`child_process`(已知会 spawn pi)、写 cwd 外、外联网络、读 env/凭据/API key/Bearer/mesh MCP URL token、混淆/仅压缩码。
4. ACP SDK scope 错配（旧 `@zed-industries` vs 新 `@agentclientprotocol`）对本仓 host 适配层的影响。
5. 依赖树（`@agentclientprotocol/sdk`+`zod` 的传递依赖、有无 deprecated/重复）。
6. 必要时**隔离 HOME + `--ignore-scripts`** 动态校验 ACP 桥握手，确认无隐藏行为。

---

## 2. pi-mcp-adapter（次重点）

### 2.1 身份与采集到的事实
- **npm**：`pi-mcp-adapter@2.10.0`，MIT，`type: module`，`bin: pi-mcp-adapter → cli.js`，keywords 含 `pi-package`。author Nico Bailon；maintainer/npmUser `nicopreme <nico.bailon@gmail.com>`。repo `git+https://github.com/nicobailon/pi-mcp-adapter.git`。
- **发布节奏**：2026-01-19 首发 1.1.0 → 2.10.0（2026-06-13），**35 个版本约 5 个月（极高频）**，近期持续更新 → 很活跃。
- **GitHub nicobailon/pi-mcp-adapter**：★906、fork 168、open issues 71、watchers 3、贡献者约 8 **但近期 commit 全是 owner Nico Bailon** → 实际 bus factor ~1。未 archived、非 fork。描述 "Token-efficient MCP adapter for Pi coding agent"。
- **下载**：周 ~27,999（三者最高）。
- **依赖**（比 pi-acp 多，且耦合 Pi 内部）：
  - `@earendil-works/pi-ai ^0.74.0`、`@earendil-works/pi-tui ^0.74.0` → **拉入 Pi 自家库**（与用户"不审 Pi 主体"形成张力：装它就间接引入 Pi 内部库）。
  - `@modelcontextprotocol/sdk ^1.25.1`、`@modelcontextprotocol/ext-apps ^1.2.2` → **官方 MCP SDK** ✅。
  - `open ^10.2.0` → 🚩 **会调用系统/浏览器打开 URL**（OAuth 授权流常用），安装面/运行面都要标记。
  - `recheck ^4.5.0`（ReDoS 静态检测器）、`typebox`、`zod`。
- **安装脚本**：scripts 仅 `test`/`test:watch`/`test:coverage`/`test:oauth-provider`，**无 install hook** → 消费安装不触发。✅
- **OAuth 面**：存在 `mcp-oauth-provider.test.ts`/`test:oauth-provider` → 该包**实现/处理 MCP OAuth provider**（Bearer/token/回调），正是 lead 点名的 TLS/Bearer/URL/token/泄密重点面。
- **provenance**：未在 package.json 声明；attestations 端点查无。
- **安全公告**：OSV 查 `pi-mcp-adapter`（npm）→ `{}`（**无**）。

### 2.2 供应链红旗
- 🚩 **bus factor ~1**（近期全 owner 提交），尽管 ★/贡献者数较高。
- 🚩 **`open`（浏览器/OS 启动器）+ OAuth/Bearer 处理** = 实打实的运行期安全面（外联、令牌、回调、日志泄密），Phase B 必审。
- 🚩 **耦合 Pi 内部库**（pi-ai/pi-tui）：依赖树更深、间接引入未审主体的库。
- ✅ 正面：官方 MCP SDK、活跃、采用度最高、无安装脚本、无 CVE、版本已到 2.x（相对成熟）。

### 2.3 Phase A 初判：**CAUTION**（倾向 GO）
三者中最成熟、采用最广、用官方 MCP SDK；主要风险是单人维护 + OAuth/Bearer/`open` 安全面 + 依赖树更深。**前提**：Phase B 重点过 MCP 网络/令牌面。

### 2.4 Phase B 重点（待放行）
1. `npm pack pi-mcp-adapter@2.10.0`（不跑脚本）+ clone 对应 tag，核对 tarball↔repo provenance。
2. **网络/MCP 面**（lead 点名）：streamable-HTTP MCP 的 **TLS 校验**、`mcp.json` 读取与优先级、**Bearer/URL/token 处理与日志是否泄密**、OAuth 回调/`open` 启动的 URL 来源是否可信、**是否执行工具返回内容**（命令注入/RCE 面）。
3. 危险模式：`eval`/`new Function`、`child_process`/`exec`/`spawn`、`open` 的全部调用点与参数来源、写 cwd 外、读 env/凭据、混淆码。
4. 依赖树深度与风险：`@earendil-works/pi-ai`/`pi-tui` 的传递依赖、`open`/`recheck` 链、有无 deprecated/重复/lockfile。
5. 隔离 HOME + `--ignore-scripts` 动态校验 streamable-HTTP MCP 功能，确认无隐藏外联。

---

## 3. @zhafron/pi-mcp-tools（备选，顺带）

### 3.1 事实
- `@zhafron/pi-mcp-tools@1.1.5`，MIT，maintainer `zhafron <zhafronadani@gmail.com>`（单人）。描述 "Universal MCP tools extension for pi coding agent"。
- **发布全部集中在 2026-02-17~02-18（约 8 个版本一天内），此后 4 个月零发布 → 实质停更**。
- **周下载 11**（几乎无人使用）。
- 依赖：`@modelcontextprotocol/sdk ^1.0.0`（**最旧**约束）、`@sinclair/typebox ^0.34.0`。
- scripts 含 `prepare: husky`（**dev 钩子**；从 registry 安装已发布 tarball 时不会触发 `prepare`，但若以 git 依赖/本地方式安装会跑 → 记一笔）。
- OSV → `{}`（无公告）。

### 3.2 Phase A 初判：**NO-GO 倾向**
停更 4 个月 + 采用近乎为零（11/周）+ 单人 + 最旧 MCP SDK 约束。功能上可能与 pi-mcp-adapter 重叠但远不如其活跃/成熟。**建议**：除非 pi-mcp-adapter 被否、且本包有人接手复活，否则不投入 Phase B；如需，仅做最小代码瞥一眼（`prepare:husky` + MCP SDK 用法）。

---

## 4. 跨包结论与给 prdmgr 的开放问题（Phase A 阶段）

**Phase A 初判汇总**：pi-acp / pi-mcp-adapter = CAUTION（倾向 GO）；@zhafron = NO-GO 倾向。三者均**无已知 CVE/公告、MIT、无消费安装脚本（直接包）**；共同短板=单人维护+年轻。**Phase B 终裁见 §6。**

**已由 prdmgr 拍板**：① Phase B 只审 pi-acp+pi-mcp-adapter（跳过 @zhafron 拉码，保留 NO-GO）；② 接受基线 f1c6391；③ pi-mcp-adapter 传递依赖纳入"供应链+危险模式"扫描但不深审 Pi 内部功能。**仍开放**：ACP SDK scope 错配的接入方向；单人/早期版本的 vendoring/fork-pin 偏好。

---

## 5. Phase B — 安全取码 + 静态审计（已完成）

> 方法：隔离 scratch `/tmp/pi-audit`（独立 HOME / npm cache / `ignore_scripts=true`）。`npm pack <pkg>@<精确版本>` 仅下载 tarball；`npm install --ignore-scripts` 仅用于在 scratch 内展开**传递依赖树**做静态扫描（**全程不跑任何 lifecycle 脚本、不在仓库安装、不执行包代码**）。`git clone --branch <tag>` 取仓库做 provenance 比对。**未做任何动态执行**（无需，静态足以裁决；如需功能性动态校验，建议后续在隔离 HOME+`--ignore-scripts` 容器内做，单列下方）。

### 5.1 pi-acp@0.0.31 深审
- **Provenance（强）**：`git clone svkozak/pi-acp@v0.0.31` HEAD = `9e857dcc05a057404eb1537e5f31e5aef88a5863` = **精确等于 package.json `gitHead`**，版本一致。仓库出 `src/`（acp / index.ts / pi-rpc），`dist/` 不在 git → 发布的 `dist/index.js` 是 `prepack: tsup` **发布时构建**产物。
  - ⚠️ **bundle↔source provenance 缺口**：发布物只有打包后的 `dist/index.js`（+sourcemap），未发布 `src/`；无法不复现构建就字节级核对 bundle↔源码。缓解=`publishConfig.provenance:true` 已声明（GH Actions OIDC）；但 npm registry attestations 端点对该版本返回 not-found（npm 网页 Provenance 徽章 Phase A 被 403 拦），**attestation 实体未最终确认**——pin 前建议用 `npm audit signatures` 或 npm 网页核一次。
- **依赖树（极小）**：传递依赖共 **3 个**（`pi-acp` + `@agentclientprotocol/sdk` + `zod`）。`@agentclientprotocol/sdk`=官方 ACP SDK 新 scope（Apache-2.0，描述与官方逐字一致）。
- **安装脚本（直接+传递）**：**全树 0 个** preinstall/install/postinstall；0 个 prepare。✅
- **危险模式**（扫 `dist/index.js`）：
  - `child_process.spawn`：spawn `pi --mode rpc --no-themes [--session …]`（`cwd: params.cwd`, `stdio: pipe`, **`env: process.env`**, `shell: shouldUseShellForPiCommand(cmd)`）。即把宿主**全量环境变量透传给 pi 子进程**（启动 agent 的正常需要，凭据留在本地子进程，非外泄）；`shell` 为条件 true（cmd 来自 `getPiCommand(piCommand)`，operator 配置、非远端输入 → 注入面低，仍记一笔）。
  - `spawnSync`：`which pi` / `npm root -g` / `pi --version` / **`npm view @earendil-works/pi-coding-agent version`**（后者=向 npm registry 查最新 pi 版本的"提示更新"调用，唯一的对外联网，子进程方式，benign，可关闭）。
  - **无** `eval`/`new Function`；**无**直接 `http/https/fetch/net`；**0** 处 `process.env`/Bearer/token/credential 读取（pi-acp 不碰凭据）。
- **小结**：攻击面极窄——一个 stdio ACP 桥 + 定位/启动 pi。无原生码、无安装脚本、无凭据处理、无直接外联（仅版本检查子进程）。

### 5.2 pi-mcp-adapter@2.10.0 深审
- **Provenance（源码强、bundle 弱）**：发布的 **`.ts` 源码与 `git clone @v2.10.0` 仓库逐字节一致（diff 0 文件不同）** ✅。但发布物含 `app-bridge.bundle.js`（一个**已打包的 webview/MCP-UI bundle**，仓库内也提交了同名 bundle）——bundle 的源码来源未在该仓暴露，属**打包产物 provenance 弱点**（需信任作者的构建）。未声明 npm provenance。
- **运行期安全卫生（多项良好）**：
  - **TLS**：全树**未发现** `rejectUnauthorized:false`/`NODE_TLS_REJECT_UNAUTHORIZED`/`insecure`/`strictSSL` 等关闭证书校验的写法 → 走 Node/MCP SDK **默认 TLS 校验**。✅
  - **本地服务器绑定**：UI server `server.listen(port, "127.0.0.1")`、OAuth callback `localhost`，且 UI URL 带 `?session=<token>` 门禁 → **仅环回 + 会话令牌**。✅ OAuth `redirectUri` 被强制为 localhost/loopback（否则抛错，`mcp-auth-flow.ts:114-116`）。✅
  - **OAuth token 落盘**：`$MCP_OAUTH_DIR` 或 `<Pi agent dir>/mcp-oauth/sha256-<hash>/tokens.json`，**目录 `mode 0o700`、文件 `mode 0o600`**（仅属主可读写）✅。明文 JSON 落盘（非 OS keychain），但权限收敛——合理但非最强。
  - **`open()`（开浏览器）受 consent 门禁**：`elicitation-handler.ts` 的 `open(params.url)` 前先弹确认（显示完整 host+URL，"Open/Decline"，拒绝即取消）✅；`mcp-auth-flow.ts` 的 `open(authorizationUrl)` 为 OAuth 授权流。`ConsentManager`（默认 `once-per-server`）+ sampling 需交互批准（`samplingAutoApprove` 才免）。残留：用户被社工批准恶意 URL 的风险（已展示 URL，可控）。
  - **是否执行工具返回**：`tool-result-renderer.ts` **只格式化文本行渲染，无** `eval/exec/Function/innerHTML/srcdoc/<script>` → **不执行工具返回内容** ✅。独立的 **MCP-UI/ext-apps webview**（`app-bridge.bundle.js`+`ui-server`+`host-html-template`）会渲染**服务器提供的 UI 资源（HTML）**，经 `buildAllowAttribute(permissions)` 的 iframe allow 属性沙箱化——属 MCP-UI 特性，是一处需信任 MCP server 的 webview 渲染面（残留 XSS/越权面，受 permissions 约束）。
  - **MCP server 启动**：`npx-resolver.ts` 用 `spawn("npm",["exec","--yes","--package",<packageSpec>, …])`（数组参数、非 shell → 无 shell 注入），`<packageSpec>` 来自 **mcp.json 的 server 定义** → **按 mcp.json 运行任意 npm 包**（MCP 适配器的本质能力，信任根=mcp.json）。
  - **mcp.json 来源/优先级（注意）**：`cli.js` 从多处读取——`<Pi agent dir>/mcp.json`、`~/.config/mcp/mcp.json`、`./.mcp.json`、`./.pi/mcp.json`，**并导入 `~/.cursor/mcp.json`、`~/.claude/mcp.json`、`~/.claude/claude_desktop_config.json`**。即会**拾取 Cursor/Claude 既有 MCP 配置（含其 server 命令与 env/token）** → 配置攻击面扩大；接入时需明确我们投喂哪个 mcp.json、是否禁用对 .cursor/.claude 的导入，避免误拾凭据/server。
  - **日志/泄密**：`console.*` 日志输出 server 名、错误对象、OAuth **authorize URL**（pre-token，含 client_id/state，非 secret）；**未发现**直接打印 access_token/Bearer/client_secret 的明文。残留：错误对象 `{ error }` 可能间接夹带敏感串，建议接入时收敛日志级别。
- **依赖树（大）**：传递依赖 **217 个**（`@earendil-works/pi-ai`+`pi-tui` 拉入多 LLM provider 生态 → `@google/genai`、`protobufjs` 等；`@modelcontextprotocol/sdk`+`ext-apps`；`open`；`recheck`；`typebox`；`zod`）。
- **安装脚本（直接 0，传递 3 个 🚩）**：直接包 scripts 仅 test。**传递依赖含安装脚本**：
  - 🚩🚩 **`koffi`** — `install: node src/cnoke/cnoke.js -P . -D src/koffi --prebuild`：**原生 FFI 库 + 安装期 native 构建/取预编译**。FFI=可调任意原生代码；安装钩子会编译/下载二进制。**最高供应链关注点。**
  - 🚩 **`protobufjs`** — `postinstall: node scripts/postinstall`（知名包，但仍是 postinstall）。
  - 🟡 **`@google/genai`** — `preinstall: echo 'preinstall: no-op'`（Google GenAI SDK，no-op preinstall，无害但记一笔）。
  - prepare 钩子 12 个（dev-only，registry 消费安装不触发）。
  - 🟡 **`recheck`**（ReDoS 检测器）`optionalDependencies` 拉 **`recheck-jar`(JAR/JVM) + recheck-{linux-x64,macos-arm64,macos-x64,windows-x64}` 平台二进制** → 又一处**预编译二进制/JVM**面。
  - 🟡 `depd` 等 deprecated 传递依赖（legacy，低风险）。
- **小结**：**运行期代码本体卫生良好**（loopback、consent、0600 token、不执行工具返回、无 TLS 降级）；**风险主要在供应链体量与安装期**——217 依赖 + `koffi`(原生 FFI install) + `protobufjs`(postinstall) + `recheck` 二进制/JAR。普通 `npm install` 会执行这些钩子并落地原生码。

### 5.3 传递依赖安全扫描边界（按 prdmgr 要求单列）
对 `pi-mcp-adapter` 的 217 个传递依赖，本次**只做"会装进环境/会跑"的供应链+危险模式扫描，不做功能深审**：
- ✅ 已扫：全树 install/preinstall/postinstall/prepare 钩子（上列 koffi/protobufjs/@google/genai + 12 prepare）；原生/二进制面（koffi、recheck-jar/平台二进制）；deprecated 标记（depd 等）。
- ❌ 未做（边界外）：逐个传递依赖的功能正确性、`@earendil-works/pi-ai`/`pi-tui` 等 Pi 内部库的功能深审（用户已定不审 Pi 主体）；每个 provider SDK（@google/genai 等）的运行行为。
- ⚠️ 含义：接入 pi-mcp-adapter = 把上述原生码/安装钩子带进环境。**强烈建议安装期 `--ignore-scripts` + 显式审过的 lockfile 锁定，并评估 koffi/recheck 原生件是否真的运行所需**（若 MCP-UI / ReDoS 检查可关，可砍掉对应依赖面）。

---

## 6. 终裁 / 推荐 pin / 缓解措施 / 总体建议

| 包 | **裁决** | 推荐 pin | 关键依据 |
|---|---|---|---|
| `pi-acp` | **GO**（pin + 监控） | `pi-acp@0.0.31`（repo `svkozak/pi-acp`，commit `9e857dcc`） | 攻击面极窄、3 依赖、0 安装脚本、0 原生码、provenance 强（tag==gitHead）；仅余 bundle↔source 与 attestation 待核 + 单人/pre-1.0 |
| `pi-mcp-adapter` | **CAUTION → 条件 GO**（**必须沙箱化安装**） | `pi-mcp-adapter@2.10.0`（repo `nicobailon/pi-mcp-adapter`） | 运行期卫生良好；但 217 依赖 + koffi 原生 FFI install + protobufjs postinstall + recheck JAR/二进制 → 安装期供应链风险高 |
| `@zhafron/pi-mcp-tools` | **NO-GO**（已否，未拉码） | — | 停更 4 月、11 dl/wk、单人；备选已排除 |

**pi-acp 缓解**：① pin 精确版本+commit；② 接入前 `npm audit signatures` / npm 网页核 provenance 徽章，补 bundle↔attestation 这一缺口；③ 可选 vendor/fork-pin 防上游 0.0.x 漂移；④ 关掉其 `npm view … version` 的联网更新检查（如可配）；⑤ 留意 ACP SDK scope（新 `@agentclientprotocol/sdk` vs 本仓旧 `@zed-industries/...@0.4.5`）。

**pi-mcp-adapter 缓解（接入前置条件）**：
1. **安装期 `--ignore-scripts`**（CI/部署都加），用**审过的 lockfile** 锁定 217 依赖；koffi/recheck 的原生件按需手动放行，不让其在宿主自动 build。
2. **剥离/审 postinstall**：koffi(install)、protobufjs(postinstall) 单独评估；能不引入就砍（评估 MCP-UI ext-apps、ReDoS recheck 是否运行所需）。
3. **沙箱运行**：在受限子进程/容器跑（本仓既有 per-mesh 进程隔离可复用），**出口网络允许列表**（仅放行需要的 MCP server 域 + OAuth 端点）。
4. **配置面收敛**：明确只投喂我们生成的 mcp.json，**禁用其对 `~/.cursor`/`~/.claude` 配置的导入**（避免误拾外部 server/凭据）；mcp.json 是信任根，谁能写它就能让它 `npm exec` 任意包。
5. **token/日志**：沿用其 0600 落盘；接入时收敛 `console.*` 日志级别，避免错误对象夹带敏感串。
6. 可选 vendor/fork-pin，去掉不需要的 provider/UI 依赖面以缩小 217 棵树。

**总体建议**：
- **pi-acp**：作为 ACP 桥**可接入**（与现有 codex-acp/claude-agent-acp host 同构），先补 provenance 核验 + 解决 ACP SDK scope，pin 后用。
- **pi-mcp-adapter**：**代码本体可接受，但不要"裸 `npm install`"**——务必走 `--ignore-scripts` + 锁定 lockfile + 沙箱 + 出口允许列表 + 配置导入收敛后再用；或评估是否只取其核心 MCP 适配能力（vendor 子集）以避开 koffi/recheck/provider SDK 的体量。两者都是单人/年轻项目，**建立上游版本监控**。

---

## 附录 A：实际查询来源与命令（Phase A）
- **npm 注册表元数据（仅元数据，未下载 tarball、未安装、未跑脚本）**：
  - `npm view pi-acp --json` / `npm view pi-acp@0.0.31 dist.attestations --json`
  - `npm view pi-mcp-adapter@2.10.0 scripts dependencies deprecated dist.integrity _npmUser --json`
  - `npm view @zhafron/pi-mcp-tools --json` / `... scripts dependencies time --json`
  - `npm view @agentclientprotocol/sdk --json`、`npm view @zed-industries/agent-client-protocol ...`（核对 ACP SDK 官方性）
- **npm 下载量 API**：`curl https://api.npmjs.org/downloads/point/last-week/<pkg>`
- **npm provenance/attestations 端点**：`curl https://registry.npmjs.org/-/npm/v1/attestations/<pkg>@<ver>`（pi-acp/pi-mcp-adapter 均 `not found`）
- **GitHub REST API（未认证）**：`curl https://api.github.com/repos/<owner>/<repo>`（stars/forks/issues/pushed_at/archived）、`/contributors`、`/commits`
- **OSV.dev**：`curl -X POST https://api.osv.dev/v1/query -d '{"package":{"name":"<pkg>","ecosystem":"npm"}}'`（三包均 `{}` = 无公告）
- **Web 搜索**：pi-acp 官方性/ACP 关系（earendil-works/pi #175、discussion #4444、Zed ACP 目录、victor-software-house/pi-acp 与 gsd-pi-acp 名称混淆）。
- **WebFetch npmjs.com/package/pi-acp** → HTTP 403（npm 网页拦截抓取，provenance 徽章未取到 → §5.1 列为接入前待核项）。

## 附录 A2：Phase B 实际命令与来源（全部在仓库外 scratch `/tmp/pi-audit`）
> 隔离设置：`export HOME=/tmp/pi-audit/home; export npm_config_cache=/tmp/pi-audit/npm-cache; export npm_config_ignore_scripts=true`
- **安全取码（仅下载 tarball，不 install，不跑脚本）**：`npm pack pi-acp@0.0.31`、`npm pack pi-mcp-adapter@2.10.0` → `sha256sum *.tgz` → `tar xzf` 解包到 scratch。
- **取仓库（provenance）**：`git clone --depth 1 --branch v0.0.31 https://github.com/svkozak/pi-acp.git`；`git clone --depth 1 --branch v2.10.0 https://github.com/nicobailon/pi-mcp-adapter.git`。
- **provenance 比对**：pi-acp `git rev-parse HEAD` == package.json `gitHead`；pi-mcp-adapter 逐 `.ts` `diff 发布物↔仓库`（0 不同）。
- **传递依赖树（仅静态展开，`--ignore-scripts`，scratch 内，不在仓库）**：`npm install --ignore-scripts --no-audit --no-fund <pkg>@<ver>`（pi-acp 树=3 包、pi-mcp-adapter 树=217 包）。
- **安装脚本全树扫描**：Python 遍历 `node_modules/**/package.json` 的 `scripts.{pre,,post}install/prepare`（发现 koffi.install / protobufjs.postinstall / @google/genai.preinstall(no-op) + 12 prepare）。
- **危险模式静态扫描**：`grep -nE` over `*.ts/*.js`（排除 `.map`/bundle）扫 `eval|new Function`、`child_process/exec/spawn/open`、`http/https/net/tls/ws/fetch/axios`、`open(`、`process.env|Bearer|token|secret|credential`、TLS `rejectUnauthorized/NODE_TLS/insecure`、server `listen/127.0.0.1/localhost/0.0.0.0`。
- **未做动态执行**：未运行任何包/二进制（静态足以裁决）；如需功能性动态校验，建议隔离 HOME + `--ignore-scripts` 容器内单独做。

## 附录 B：Phase B 完成度 / 未跑 gate / 安全铁律声明
- **Phase B 已完成**：pi-acp+pi-mcp-adapter 的 npm pack、git clone、tarball↔repo provenance、全传递依赖树、安装脚本全树扫描、危险模式静态扫描、pi-mcp-adapter 的 TLS/绑定/mcp.json 来源/Bearer-token 落盘/日志/是否执行工具返回/`open` consent 均已覆盖。
- **刻意未做**：动态执行/功能性运行校验（静态已足够裁决；列为可选后续，须隔离 HOME+`--ignore-scripts`）；@zhafron 拉码（prdmgr 已定跳过）；Pi 内部库（pi-ai/pi-tui）功能深审（边界外）。
- **接入前待核（写进 §6 缓解）**：pi-acp 的 bundle↔source/attestation 核验（`npm audit signatures`/npm 网页徽章）；ACP SDK scope 对齐。
- **未跑的 gate**：纯研究文档、无代码改动，**未运行** tsc/测试（不涉回归）。
- **安全铁律遵守声明**：全程在**仓库外**隔离 scratch（独立 HOME/cache/`ignore_scripts=true`）；**未在仓库 install/写 tarball/解包物**；**未跑任何 lifecycle/安装脚本、未执行任何包代码或原生二进制**；仅 `npm pack`（下载）+ `--ignore-scripts` 静态展开 + grep/读码。审计完成后 scratch `/tmp/pi-audit` 已 `rm -rf` 清理。
