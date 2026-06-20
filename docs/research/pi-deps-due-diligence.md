# Pi 依赖上线前尽调 — Phase A（社区/信誉/安全公告）

> Slug `pi-deps-due-diligence`，分支 `task/pi-deps-due-diligence`。**纯研究/审计，未改 src，未加 package.json/lockfile 依赖，未安装任何包。**
> 本文档为 **Phase A（不拉码）**：社区信誉、版本、维护者、已知安全公告、供应链红旗 + 每包初判。**Phase B（安全取码+静态/动态审计）等 prdmgr 放行后再做**——见每包 §"Phase B 重点"。
> 数据采集时间：**2026-06-21**（npm/GitHub/OSV 数据为当日快照；下载量为 2026-06-13~06-19 周）。基线 main：任务指定 `633c2c1`；实际从当前 main 新建分支（docs-only，基线 commit 不影响审计内容）。

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

**一句话**：`pi-acp` 与 `pi-mcp-adapter` 都活跃、有真实采用、无已知 CVE、无安装脚本、MIT、依赖链干净度尚可——但**都是单人维护（bus factor 1）+ 年轻（<7 个月）+ pre/早期版本**，且各有需 Phase B 实证的安全面（pi-acp 的进程 spawn/stdio 桥、pi-mcp-adapter 的 OAuth/Bearer/`open` 浏览器）。`@zhafron/pi-mcp-tools` **停更 + 几乎零采用**，除非 pi-mcp-adapter 被否则不建议投入 Phase B。

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

## 4. 跨包结论与给 prdmgr 的开放问题

**初判汇总**：pi-acp = CAUTION(倾向 GO，钉死包/repo)；pi-mcp-adapter = CAUTION(倾向 GO，过 OAuth/网络面)；@zhafron/pi-mcp-tools = NO-GO 倾向。三者均**无已知 CVE/公告、MIT、无消费安装脚本**；共同短板是**单人维护 + 年轻**。

**需 prdmgr/用户拍板**：
1. 是否进入 Phase B？建议**只对 pi-acp + pi-mcp-adapter 做 Phase B**，跳过 @zhafron（停更/零采用）。
2. ACP SDK scope 错配：本仓用旧 `@zed-industries/agent-client-protocol@0.4.5`，pi-acp 用新 `@agentclientprotocol/sdk@0.28.x` —— 接入方向（升级本仓 ACP SDK / 适配层兼容）需要单独决策。
3. 单人维护 + pre/早期版本的**长期可维护性**风险偏好：是否接受 vendoring / fork-pin 作为缓解？
4. pi-mcp-adapter 间接引入 Pi 内部库（pi-ai/pi-tui）与"不审 Pi 主体"的边界如何处理？

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
- **WebFetch npmjs.com/package/pi-acp** → HTTP 403（npm 网页拦截抓取，provenance 徽章未取到，列入 Phase B）。

## 附录 B：未完成的 Phase B 项（全部待 prdmgr 放行）
- **未做**：`npm pack`/`git clone`/tarball↔repo provenance 核对、依赖树展开、安装脚本逐包确认、危险模式静态扫描（eval/child_process/网络/env/凭据/混淆）、pi-mcp-adapter 的 TLS/mcp.json/Bearer/URL/token/日志泄密/是否执行工具返回、隔离 HOME+`--ignore-scripts` 动态功能校验。
- **未跑的 gate**：本任务为纯研究文档，**未运行** tsc / 测试（无代码改动，不涉回归）。
- **安全铁律遵守声明**：Phase A 全程**只取 registry/GitHub/OSV 元数据**，**未 `npm install` 任何包、未下载/解包 tarball、未执行任何包代码或安装脚本**。
