# UI 重设计工具箱盘点 + 现状结构快评

> 发现性调研报告（slug: `ui-redesign-toolkit`，分支 `task/ui-redesign-toolkit`，基线 main `4b2affa`）。
> **本文档只调研、盘点、截图、出建议；不含任何 UI/功能代码改动。** 截图用 `--fake` 服务器在 headless Chromium 中实拍，存于 `$AGENT_MESH_ARTIFACTS/`，未入库。
>
> 目标读者：prdmgr / 用户，用于决策后续 `src/web/` 桌面端 + 移动端整体重设计的推进方式。

---

## 0. TL;DR

- **流程类 skill**（决定"怎么做"）：`superpowers:brainstorming`（重设计前必跑，锁需求/方向）→ `superpowers:writing-plans`（把方向落成可执行计划）→ `frontend-design`（审美方向、排版、避免模板感）。
- **度量/验证工具**（已在仓库内，是本项目最强资产）：`src/web/client/contrast.ts`（WCAG 对比度数学 + 4 个阈值常量）、`a11y-audit.ts`（用私有 `PAIRS` 对各主题调色板做静态对比度打表，约 76 行）、`a11y.e2e.ts`（桌面 1440×900 下逐 8 主题、对固定 `SELECTORS` 测真实渲染对比度）。重设计必须把这套当回归门禁用（移动端布局回归另见 `browser.e2e.ts`）。
- **截图/测量**：Playwright（仓库已装 `playwright@1.60`）+ MCP `browser_*` 工具 + 仓库内 `e2e-playwright.ts` 设备鉴权脚手架。这是给重设计做"前后对比"和像素回归的现成手段。
- **DesignSync + `/design-sync`**：可把本地组件库与 claude.ai 的 Design System 项目双向同步——若重设计要建正式设计系统/组件预览库，这是落地通道（需用户的 claude.ai 登录授权）。
- **skill-creator**：把重设计中沉淀的可复用流程（如"截图回归 + a11y 门禁"）固化成本仓自有 skill。
- **已知重设计需求**（prdmgr 提出）：全局"消息/通知中心"入口——把散落各处的系统类通知（harness 升级、前端自更新 `UpgradePrompt` 等）收拢到一个全局入口，作为"功能堆砌→信息架构"的典型 IA 案例，随重设计一并规划、**不做临时 bolt-on**。详见 §2.5。
- **现状快评结论**：当前 UI 是**功能完整但信息密度过载、层级扁平**的"控制台"风格——桌面端三栏全部塞满、移动端靠底部 tab 折叠、视觉语言高度终端化（等宽字体 + 全大写标签 + 磷光绿）。重设计的核心不是换皮，而是**重排信息架构 + 建立清晰的视觉层级与响应式策略**。详见 §2。

---

## 1. 设计 SKILL / 工具清单

每项含：**是什么 / 怎么用 / 在本次重设计中的作用 / 局限**。分四类。

### A. 流程类 skill（决定"怎么做"，优先级最高）

#### A1. `superpowers:brainstorming`
- **是什么**：在任何创造性工作（新功能、新组件、改行为）之前强制运行的需求/意图/方向探索流程。
- **怎么用**：进入 plan mode 前先调用；它会引导澄清"重设计要解决谁的什么问题、约束、成功标准"，产出共识再动手。
- **在本次重设计中的作用**：**重设计的第一步**。整体重设计是典型的高歧义创造性任务（"重设计"本身没有客观正确答案），必须先用它把"我们到底要什么样的 UI、为谁、放弃什么"谈清楚，否则后续全是返工。需要 prdmgr/用户参与的开放问题（§3）正是这一步的输入。
- **局限**：它只产出方向与共识，不产出像素或代码；输出质量取决于用户参与度。不能替代实际设计稿。

#### A2. `superpowers:writing-plans`
- **是什么**：把 spec/需求拆成多步可执行计划的 skill（带评审检查点）。
- **怎么用**：brainstorming 锁定方向后，用它把"重设计"拆成有序、可独立验收的 commit/任务序列（如：①设计 token 重整 → ②信息架构重排 → ③桌面布局 → ④移动布局 → ⑤组件细化 → ⑥a11y 回归）。
- **在本次重设计中的作用**：把一个"大泥球"拆成本 mesh 的 task 分支序列，配合现有 task/<slug> 工作流串行推进；天然契合"文件范围重叠不并行"的约束。
- **局限**：计划质量依赖输入 spec 清晰度；对纯视觉探索（要不要这么排）帮助有限，那部分靠 frontend-design + 截图迭代。

#### A3. `frontend-design`（anthropics/skills）
- **是什么**：构建/重塑 UI 时的审美方向指导——排版、视觉层级、避免"模板默认值"的雷同感、做有意图的设计选择。
- **怎么用**：在落具体布局/样式时调用，作为审美 checklist 和方向参考（字体搭配、间距节奏、强调色克制使用等）。
- **在本次重设计中的作用**：当前 UI 视觉语言很"工程师默认"（全大写 + 等宽 + 高密度），重设计若想要"有意图、不像模板"的观感，这是核心参考。尤其在"保留终端硬核气质" vs "更易读的现代控制台"之间做美学取舍时。
- **局限**：是 flexible（启发式）skill，不是硬规则；给方向不给定案，仍需人来拍板具体值。不涉及可访问性数学（那归 contrast.ts）。

#### A4. `skill-creator`
- **是什么**：创建/改进/评测 skill 的元工具。
- **怎么用**：把重设计中反复用到的流程固化成本仓 skill。最值得固化的是**"web 截图回归 + a11y 门禁"**（见 B/C 类工具），让以后任何 UI 改动都能一键产出前后对比 + 对比度报告。
- **在本次重设计中的作用**：不直接参与设计，但能把本次趟出来的"截图脚手架 + 验证流程"沉淀为可复用资产，降低后续 UI 迭代成本。
- **局限**：投入产出比取决于流程复用频率；一次性任务不值得固化。

### B. 仓库内度量/验证工具（本项目最强资产，重设计的回归门禁）

> 这三件是本仓自研、用于在重设计期间防止可访问性回退的核心。运行均在私有 worktree 内直接 `bun run <文件>`。**以下描述以 builder 本轮实读代码为准（已核对 main `4b2affa` 的源码）。**

#### B1. `src/web/client/contrast.ts` — WCAG 对比度数学/常量工具
- **是什么**：纯 WCAG 2.1 对比度数学与阈值常量，**不含任何色对契约**。导出：常量 `AA_TEXT=4.5` / `AA_LARGE=3.0` / `AAA_TEXT=7.0` / `UI_COMPONENT=3.0`；函数 `hexToRgb`、`blend(fg,alpha,bg)`（合成半透明）、`relativeLuminance`、`contrastRatio(a,b)`、`fmtRatio`；类型 `RGB`。**没有 `AUDIT_PAIRS`、没有 `evalPair`、没有 `resolveColor`/`ColorSpec`/`PairResult`**（这些是早前调研稿的误述，已修正）。
- **怎么用**：作为共享数学库被 `a11y-audit.ts`（`import { contrastRatio, fmtRatio, AA_TEXT, UI_COMPONENT }`）、`a11y.e2e.ts` 及 `contrast.test.ts`（单测，`bun test`）import。重设计时它提供"算两色对比度/判阈值"的底座。
- **在本次重设计中的作用**：任何新配色用它算 WCAG 比值、对照四个阈值常量；是审计/e2e 的数学底座，但**它本身不知道 UI 画了哪些色对**（那由 B2 的私有 PAIRS 决定）。
- **局限**：假设 sRGB，不支持广色域；`contrastRatio` 不含 alpha，调用方须先 `blend()` 合成；只是数学工具，不构成门禁——门禁逻辑在 B2/B3 与单测里。

#### B2. `src/web/a11y-audit.ts` — 静态调色板审计（约 76 行）
- **是什么**：人类可读的可访问性审计脚本（约 76 行）。文件内有一个**私有 `PAIRS: Pair[]`** 数组（本文件自己定义的"该测哪些 (前景,背景) 色对"清单，**不是 contrast.ts 导出的共享契约**），对**每个内置主题的调色板**用 `contrastRatio` 打表（比值/阈值/通过）。**不做 `theme.css` 变量 lint，也不做硬编码颜色字面量 lint**（早前调研稿误述，已删）。
- **怎么用**：`bun run src/web/a11y-audit.ts`（**当前没有 `a11y:palette` 这个 package script**）。输出各主题色对的对比度表。
- **在本次重设计中的作用**：重设计调色板/主题时的**即时反馈**——改完 token 立刻按 PAIRS 看哪对不达标。比 e2e 快，适合迭代中频繁跑。
- **局限**：PAIRS 是本文件私有、手工维护的清单，新增色对要手动加进来；只算调色板数值，不检测真实渲染 DOM（那是 B3 的活）。

#### B3. `src/web/a11y.e2e.ts` — 桌面真实渲染下的主题对比度检查（约 175 行）
- **是什么**：在 Playwright Chromium 里**逐个内置主题**（源码 `THEMES` = phosphor/amber/ice/paper/mono/frost/sage/linen，共 **8 个**）渲染真实 app，对一组**固定的选择器清单 `SELECTORS: Check[]`** 测计算后颜色的对比度——**不是爬遍每个文本节点**。SELECTORS 聚焦 canvas/app 表面：含文本项（如 `.canvas-top .ttl`、`.canvas-window-head .agent-id/.sub`）和非文本 UI 项（如 `.canvas-window` 的 `border-top-color`、`.canvas-edge`/`.canvas-edge.active` 的 `stroke`）。**页面视口固定 1440×900（桌面）。没有 390×844 移动视口，也没有 board 标签 chip 的专门检查**（早前调研稿误述，已删）。
- **怎么用**：`bun run src/web/a11y.e2e.ts`（自带 `--fake` server；**当前没有 `a11y:e2e`/`a11y` package script**）。
- **在本次重设计中的作用**：捕捉静态审计算不出的**真实渲染态问题**（计算后颜色 + canvas 描边/边框）。重设计改 canvas/app 表面后，这是"真实渲染下 8 主题仍达标"的回归门禁。
- **局限**：只测 `SELECTORS` 列出的固定表面（漏测项需手动加进 SELECTORS）；桌面单视口，**移动端可访问性不在此覆盖**；颜色数学注入页面，页面若崩可能静默 false-green。

> **B 类小结（修正后）**：本仓现有的 a11y 资产是 **WCAG 数学库（B1）+ 私有 PAIRS 静态调色板审计（B2）+ 桌面 8 主题固定选择器渲染检查（B3）+ `contrast.test.ts` 单测**。**当前没有**跨文件共享的 `AUDIT_PAIRS` 契约、没有 theme.css lint、没有移动端 a11y e2e——这些都是**后续可提的增强**（见 §3 / 开放问题），不可写成现状。重设计期间把现有这套当回归门禁：每个布局/配色 commit 后跑 `bun test` + `bun run src/web/a11y-audit.ts` + `bun run src/web/a11y.e2e.ts`，不倒退已达标项。

### C. 浏览器 / 截图 / 测量工具

#### C1. Playwright（仓库已装 `playwright@1.60`）+ `src/web/e2e-playwright.ts` 脚手架
- **是什么**：仓库 devDependency 的 Playwright + 自研 e2e 工具：`launchChromium()`、`freePort()`、`provisionE2eAuth()`（隔离 MESH_ROOT + 注入已批准设备 token，绕过 device-auth 门禁的**合法**方式）、`authedContext()`、`authedReady()`。
- **怎么用**：写一次性脚本 import 这些 helper → 起 `--fake` server → 注入 token → 导航 → `page.screenshot()`。本报告的截图就是这么拍的（脚本用完即删，未入库）。现成范例：`src/web/browser.e2e.ts` 的 `shot()` 把图写到 `/tmp/mesh-shots`。
- **在本次重设计中的作用**：**重设计的"眼睛"**——做改前/改后对比图、多视口（桌面 1440×900 / 移动 390×844）批量截图、布局几何断言（如 `browser.e2e.ts` 里 `assertMobileDetailLayout` 已在断言移动端不横向溢出）。可作为像素回归基础。
- **局限**：需先过 device-auth（用 `provisionE2eAuth` 解决）；fake server 的数据是脚本化 demo，覆盖不到真实多 agent/长 transcript 的极端态；截图是诊断非断言，hang 了要容错。

#### C2. Playwright MCP `browser_*` 工具（**若当前会话注入/可用**）
- **是什么**：若当前会话注入了 Playwright MCP server，则有一组浏览器自动化工具：`browser_navigate / browser_take_screenshot / browser_snapshot / browser_resize / browser_click / browser_evaluate / browser_console_messages` 等。**这是会话态能力，非仓库长期稳定资产**——是否可用取决于该会话/harness 是否连了这个 MCP（builder 本轮的截图实际走的是 C1 脚本，未用 MCP 截图）。
- **怎么用**：交互式驱动一个浏览器——`browser_resize` 切视口、`browser_evaluate` 注入 localStorage token 后 reload 过鉴权门、`browser_snapshot` 取无障碍树（比截图更适合让 agent 理解结构）、`browser_take_screenshot` 出图。
- **在本次重设计中的作用**：适合**探索式**核查单个页面/交互（"这个 hover 态长啥样""这个 modal 的 tab 顺序对不对"），以及用 `browser_snapshot` 让 agent 读懂 DOM 语义结构。与 C1 的脚本化批量互补：C1 批量回归，C2 单点交互。
- **局限**：交互式、单浏览器，不适合一次性批量多视口；过 device-auth 需手动 evaluate 注入 token（不如 C1 的 `authedContext` 干净）。

#### C3. 仓库内 e2e 截图惯例（`browser.e2e.ts` 的 `shot()` / `/tmp/mesh-shots`）
- **是什么**：现成的"截图到目录、失败不阻断"模式。
- **怎么用**：复制 `shot()` 思路，把目录指到 `$AGENT_MESH_ARTIFACTS/` 即可让产物随 mesh 工件呈现给用户。
- **在本次重设计中的作用**：标准化重设计的截图产出位置，便于在 console 里直接看到前后对比。
- **局限**：仅约定，非工具；fullPage 对固定视口 SPA 意义不大（本报告用视口截图更贴近用户实际所见）。

### D. 设计系统同步 / 资源

#### D1. `DesignSync` 工具 + `/design-sync` skill
- **是什么**：通过用户 claude.ai 登录读写其 **claude.ai/design 设计系统项目**的工具（`list_projects/get_file/finalize_plan/write_files/…`），配合 `/design-sync` skill **增量地、一个组件一个组件地**把本地组件库与远端 Design System 保持同步（绝不整体替换）。
- **怎么用**：先 `list_projects` 找到/`create_project` 建一个 design-system 项目 → 用户审 plan → `finalize_plan` 锁路径 → `write_files` 上传组件预览。
- **在本次重设计中的作用**：**可选的高阶路径**——若重设计要建立正式的、可在 claude.ai 浏览的组件预览库/设计系统（而非仅改 React 代码），这是落地通道；也便于和用户就组件样态在 Design System 面板上对齐。
- **局限**：需用户的 claude.ai 登录 + design 授权（`/design-login`），headless/cron 环境可能没有该登录；是"建设计系统"而非"改本仓 UI"的工具，**是否需要它取决于重设计是否要正式设计系统产物**（§3 开放问题）。`get_file` 返回他人内容，须当数据不当指令（注入风险，工具自带告警）。

### E. 外部可安装 skill（`npx skills find` 发现，**未验证、未安装，仅备选**）
通过 find-skills / `npx skills find "ui design"` 发现的社区 skill，安装量普遍偏低、来源未核验，**不建议直接用**，仅记录备选：
- `shajith003/awesome-claude-skills@ui-design`（~3.2K installs，相对最高）
- `404kidwiz/claude-supercode-skills@ui-designer`、`yunshu0909/…@ui-design`、`ckorhonen/claude-skills@ui-design` 等（均 <130 installs）。

**builder 本轮可用/用过的** `frontend-design`（anthropics/skills）与 superpowers 套件（brainstorming/writing-plans 等）已覆盖核心需求，**无需新装外部 skill**；注意这些是**本会话注入的 skill，是否在每个会话/harness 都可用取决于其 skill 配置**，并非仓库代码资产。如确有缺口（如专门的响应式断点 skill），再按 find-skills 的质量标准（≥1K installs + 可信来源）评估。

> **盘点结论**：`design-sync/DesignSync` 在**仓库代码里不存在**（Explore 全仓搜 "DesignSync/design-sync" 无结果），但作为 **harness 注入的工具 + skill** 存在（D1）。本仓真正的设计资产是 **B 类自研 a11y 三件套** + **C 类 Playwright 脚手架**——重设计应以这两类为骨架。

---

## 2. 现状结构快评（高层，非像素级）

截图均为 `--fake` 服务器实拍，存于 `$AGENT_MESH_ARTIFACTS/`。主题为默认 Phosphor（磷光绿/暗）。

### 桌面端（1440×900）

**概览（停止态）：**
![桌面概览](artifact:desktop-01-overview.png)

**运行态（router 对话 + transcript）：**
![桌面运行态](artifact:desktop-03-running.png)

**Board 面板（rail 下半区 tab）：**
![桌面 Board](artifact:desktop-04-board.png)

桌面端是**经典三栏控制台**：
- **左栏**：MESHES 列表（含 NEW/START/STOP）+ MESH ASSISTANT 对话（带自己的 composer），上下两块挤在窄栏里。
- **中栏**：CONVERSATION（router/codex-1/opencode-1 的 tab 条 + 每 agent 控制行 model/effect/NEW SESSION/FULL + transcript + composer）。
- **右栏**：上半 TOPOLOGY（节点列表 + 拓扑图），下半是 ACTIVITY | MAIL | BOARD | HISTORY 四 tab 的 rail。

### 移动端（390×844）

**列表态：**
![移动列表](artifact:mobile-01-list.png)

**详情态（含 permission 提示 + 底部 CHAT/MAP/LOG tab）：**
![移动详情](artifact:mobile-02-detail.png)

移动端是 **master-detail + 底部 tab**：列表页（MESHES + MESH ASSISTANT）→ 点 mesh 滑入详情；详情底部用 **CHAT | MAP | LOG** 三 tab 折叠桌面端的三栏内容。`browser.e2e.ts` 已断言移动详情不横向溢出、composer 钉在底部。

### 结构性问题（高层，按层面）

**① 信息架构（IA）—— 扁平且重叠**
- 桌面把**至少 6 类信息**（mesh 列表、助手对话、agent 对话、拓扑、board、activity/mail/history）平铺在一屏三栏里，**没有主次**——所有东西同时争夺注意力，新用户不知道先看哪。
- "MESH ASSISTANT 对话"和"CONVERSATION（router）对话"是**两个并存的聊天入口**，概念上易混（助手 vs router 都是"和 AI 说话"），但视觉上没区分清主从。
- rail 下半把 ACTIVITY/MAIL/BOARD/HISTORY 四个**性质很不同**的东西（实时事件流 / agent 间邮件 / 任务看板 / 权限历史）塞进一组 tab，分类逻辑弱。
- **系统类通知散落、无统一入口**：当前系统级消息**内联散布**在多处——`UpgradePrompt` 前端自更新横幅（`App.tsx:34`，`.upgrade-banner`，server build 变更时顶部弹出）、`Toaster` 瞬时 toast（`App.tsx:20`，mutation/harness 列表失败等）、harness 升级提示（`/api/harnesses` 的 `runningAgentsUsingOldVersion` + HARNESSES modal 内）。它们**各自为政、出现位置不一致、瞬时 toast 易错过、且无历史可回看**。这是"功能堆砌→信息架构"最典型的待收拢点，已被 prdmgr 列为已知重设计需求（详见 §2.5）。

**② 布局 —— 密度过载、栏宽失衡**
- 左栏既要放 mesh 列表又要放助手全对话（含 composer），**垂直空间严重不够**，助手区在有内容时会很挤。
- 右栏上下硬切（拓扑 / rail），两块都偏小；拓扑图在窄栏里尺寸受限。
- 桌面端**留白极少**，几乎所有像素都被控件填满——这是"工具堆砌"最直接的观感来源。
- 顶栏塞了 brand/连接态/助手态/主题/语言/HARNESSES/FEISHU/RELOAD 一长串，移动端被压缩到图标/截断（见 mobile-01 顶部 "a:" 截断 + 一排图标）。

**③ 视觉语言 —— 高度终端化、层级靠"全大写 + 颜色"撑**
- 通体等宽字体 + 全大写标签（MESHES/CONVERSATION/TOPOLOGY/ACTIVITY…）+ 磷光绿强调：硬核 retro 气质鲜明，但**全大写削弱可读性**、层级几乎只靠字号微差和颜色区分，缺乏现代 UI 的留白/分组/卡片层级。
- 状态全靠小圆点（ready/running 绿点）+ 短词，信息密度高但**扫读成本高**。
- 移动详情同屏出现 permission 横幅 + 对话 tab + transcript + 底部 tab，**一屏四层**，信息拥挤。

**④ 响应式策略 —— 靠"折叠"而非"重排"**
- 移动端基本是把桌面三栏**塞进底部 tab**（CHAT/MAP/LOG），属于"塞得下"而非"为移动重新设计"；交互路径变深（要在底 tab 间反复切换才能看全 mesh 状态）。
- 顶栏在移动端退化为截断文字 + 图标排，**可发现性差**（HARNESSES/FEISHU 等入口在小屏不直观）。

> **快评定性**：当前 UI 是**功能驱动、密度优先的"专家控制台"**——对重度用户（如本 mesh 的开发者自己）高效，但 IA 扁平、视觉层级弱、移动端靠折叠。重设计的真问题是**"为谁、在什么设备、优先完成什么任务"重新定义 IA 与层级**，而不是换配色。**优点要保留**：信息密集的硬核气质、已达标的 WCAG AA、清晰的 mesh→agent→对话主线。

---

## 2.5 已知重设计需求：全局"消息/通知中心"（prdmgr 提出）

> 这是 prdmgr/用户已明确的一条重设计需求，**作为"从功能堆砌转向信息架构"的典型 IA 案例**记入本调研，供后续重设计一并规划。**当前不实现**。

**需求**：要一个**全局"消息/通知中心"入口（按钮）**，把现在散落各处的**系统类通知**——harness 升级提示、前端自更新提示（`UpgradePrompt`），以及未来同类系统消息——**收拢到一个统一的全局入口**，而不是内联散布在各页面。

**① 定位**：它是一个**应用级（全局）的系统消息聚合面板**，与某个具体 mesh / agent / 对话无关。区别于：
- **对话内容**（router/agent transcript、MESH ASSISTANT）——业务消息，不进通知中心；
- **mesh 内事件**（rail 的 ACTIVITY/MAIL/HISTORY）——属某个 mesh 的局部事件流，层级低于全局；
- 通知中心收拢的是**跨 mesh、应用层的系统/运维类消息**：版本/升级（前端自更新 `UpgradePrompt`、harness `runningAgentsUsingOldVersion`）、连接/服务状态、以及未来的系统级告警。
它天然属于**顶栏的全局控件区**（与 HARNESSES/FEISHU/RELOAD/主题/语言同级），建议带**未读计数/状态点**，点开是一个可回看历史的列表/抽屉。

**② 作为 IA 的一部分被规划**：这正是 §2① 指出的"系统通知散落、无统一入口"问题的解。它**必须在重设计的信息架构阶段（§3 阶段 1）被一并规划**——确定：哪些消息归全局通知中心、哪些留在 mesh 局部、顶栏全局控件区如何容纳这个入口（顶栏已偏挤，见 §2②，移动端尤其需要重排）、未读/历史/已读态如何表达。不能在现有顶栏上**临时挂一个按钮（bolt-on）**，否则只会加重顶栏拥挤。

**③ 与各页面内联提示的关系**：通知中心**不是要消灭所有内联提示**，而是建立**主从/分工**：
- **高紧急、需即时阻断当前任务**的（如必须刷新才能继续的前端自更新）——可保留一个**轻量内联横幅**，但其内容**同时归档进通知中心**，可事后回看；
- **非阻断、信息性**的（harness 有新版本、某操作结果）——**优先收进通知中心**，减少内联打断；瞬时 toast 可作为"一闪而过 + 落入通知中心历史"的双通道，解决当前 toast 易错过、无历史的问题。
- 原则：**内联提示负责"此刻必须知道"，通知中心负责"汇总 + 可回看"**；同一条系统消息不应只存在于易逝的内联层。

**④ 随重设计一并设计，不做临时 bolt-on**：明确**不在当前阶段单独实现**。它涉及顶栏重排、全局 vs 局部消息的 IA 归类、未读/历史数据模型——这些都应在真正重设计时**与整体 IA、顶栏、移动端响应式策略统一设计**，否则会变成又一个"堆"上去的功能，与本次重设计要解决的"功能堆砌"问题自相矛盾。

> 实现锚点（供后续阶段参考，非现在改）：现有系统消息源已集中在 `store.ts`（`getUpgrade()`、`getToasts()`）与 `/api/harnesses` 的 `runningAgentsUsingOldVersion`；通知中心可在这些既有数据源之上聚合，无需新建采集层——这降低了后续实现成本，但 IA/视觉仍须随重设计统一定。

---

## 3. 重设计推进路径建议

建议**串行、分 commit、每阶段过 a11y 门禁**，套用现有 task/<slug> 工作流（文件范围重叠不并行）。

**阶段 0 — 对齐方向（`superpowers:brainstorming`，需用户/prdmgr 参与）**
锁定：目标用户、主力设备、要优先完成的核心任务、保留 vs 放弃的视觉气质、成功标准。**不动代码**。产出 = 共识文档。

**阶段 1 — 信息架构重排（纸面/线框，不写最终样式）**
基于阶段 0，重画 IA：助手 vs router 对话的主从关系、rail 四 tab 的重新归类、桌面三栏的主次、**全局"消息/通知中心"入口的位置与全局 vs 局部消息归类（见 §2.5，必须在本阶段一并规划，不留作 bolt-on）**。可用 `frontend-design` 找审美方向，用 DesignSync（若决定建设计系统）或纯 Markdown/线框定稿。**产出 = 线框 + IA 决策**，过 prdmgr/用户评审。

**阶段 2 — 设计 token / 视觉系统**
若调色板/字体要变：先动 `themes.ts`（`BUILTIN_THEMES`）+ `theme.css` 的 token，**每步过 `bun run src/web/a11y-audit.ts` + `bun run src/web/a11y.e2e.ts` + `bun test`**（现有 B 类门禁），并在 `a11y-audit.ts` 的私有 `PAIRS` 里手工补登新色对。保持 WCAG AA 全绿不倒退。（后续可考虑把 `PAIRS` 提为跨文件共享契约、加 theme.css lint——见开放问题，**当前不是现状**。）

**阶段 3 — 桌面布局重构**
按新 IA 重排三栏/分组；用 C1 Playwright 脚本出**改前/改后对比图**（1440×900），用 `browser.e2e.ts` 的几何断言守住不溢出。

**阶段 4 — 移动布局重设计**
从"折叠桌面"转向"为移动重排"；用 `browser.e2e.ts` 的 `assertMobileDetailLayout`（移动几何断言：不横向溢出、composer 钉底）守护，出移动对比图。注意 `a11y.e2e.ts` **目前只覆盖桌面 1440×900**，移动端无对比度 e2e——重设计若要移动 a11y 门禁需**新增**（属增强，非现状）。

**阶段 5 — 组件细化 + 回归固化**
细化各组件态（hover/disabled/选区/permission 横幅等）；用 `skill-creator` 把"截图回归 + a11y 门禁"固化为本仓 skill，供日后 UI 迭代复用。

**全程门禁**：每阶段 commit 后 `bun test`（含 contrast.test.ts）+ `bun run src/web/a11y-audit.ts` + `bun run src/web/a11y.e2e.ts` + 多视口截图对比。（如想把这三条简化成 `bun run a11y` 之类短命令，须**先在 package.json 新增对应 scripts**——当前不存在。）

### 需要 prdmgr / 用户拍板的开放问题

1. **目标用户与设备**：主力是桌面重度开发者，还是要把移动端做成一等公民？这决定是"桌面优先 + 移动适配"还是"响应式平权"。
2. **视觉气质取舍**：保留终端硬核风（等宽 + 全大写 + 磷光绿），还是转向更易读的现代控制台（混排字体 + 大小写 + 卡片层级 + 更多留白）？影响 frontend-design 的方向。
3. **助手 vs router 对话的关系**：两个聊天入口是否合并/重新定位主从？这是 IA 重排的关键决策。
4. **rail 四 tab（activity/mail/board/history）的归类**：维持现状、合并、还是拆到不同层级？
5. **是否建立正式设计系统**：要不要用 DesignSync 把组件库同步到 claude.ai/design（需用户 claude.ai 授权），还是只改本仓 React 代码？
6. **重设计范围与节奏**：是一次性整体重做，还是按 §3 阶段渐进迭代（推荐后者，风险可控、每步可验收）？
7. **多主题约束**：当前 `BUILTIN_THEMES` 有 **8 个**（phosphor / amber=Amber CRT / ice / paper=Paper light / mono / frost=Frost light / sage=Sage light / linen=Linen light，含 4 个 light 主题；**无 Sepia**）是否全部保留并随重设计同步更新？8 主题 × a11y 会放大回归工作量。
8. **全局通知中心的边界（已知需求，见 §2.5）**：哪些消息归全局通知中心、哪些留在 mesh 局部 rail？哪些仍保留轻量内联横幅（如必须刷新的前端自更新）？是否需要未读计数 / 已读态 / 历史持久化？入口放顶栏全局控件区，移动端如何容纳？

---

## 附录：验证 / 工具调用记录

- **截图**：私有 worktree 内写一次性 TS 脚本（import `e2e-playwright.ts` 的 `provisionE2eAuth/authedContext/launchChromium`）→ 起 `bun run src/main.ts run --fake --port <p>` → headless Chromium 注入设备 token → `page.screenshot()` 输出到 `$AGENT_MESH_ARTIFACTS/`；脚本用完即删，**未入库，分支只含本 .md**。
- **实际产物**：`desktop-01-overview.png`、`desktop-03-running.png`、`desktop-04-board.png`、`mobile-01-list.png`、`mobile-02-detail.png`（桌面 1440×900，移动 390×844 + isMobile/touch）。HARNESSES/NEW modal 截图尝试因 `getByText` 选择器超时未取到（非阻塞，rail/board/对话已覆盖核心 IA）。
- **代码盘点**：初稿用 Explore 子 agent 通读 `src/web/`；**reviewer 复核发现初稿对 a11y 工具有多处事实误述**（虚构 `AUDIT_PAIRS`/`evalPair`、theme.css lint、a11y.e2e 的 390×844 移动视口与 board chip、不存在的 `a11y:*` scripts）。本轮 builder 已**逐个实读源码核对修正**：`contrast.ts`（`grep` 导出符号，确认仅 4 常量 + 5 函数 + RGB 类型，无 AUDIT_PAIRS/evalPair）、`a11y-audit.ts`（76 行，私有 `PAIRS`，import `{contrastRatio,fmtRatio,AA_TEXT,UI_COMPONENT}`，无 lint）、`a11y.e2e.ts`（175 行，`THEMES` 8 个，固定 `SELECTORS`，视口 1440×900，无 390/844/board chip）、`themes.ts`（`BUILTIN_THEMES` 8 个，无 Sepia）、`browser.e2e.ts`（`assertMobileDetailLayout` 在此）、`package.json`（无 a11y scripts）。
- **skill 发现**：本会话注入的 skill 列表 + `find-skills` + `npx skills find "ui design"`（外部备选，未安装）。
- **DesignSync**：通过 ToolSearch 取得会话注入工具 schema，确认其为 claude.ai/design 同步工具（仓库代码内无同名实现）。
- **未跑的 gate**：本任务为纯调研（仅改本 .md），**未运行** `bun test` / `bun run src/web/a11y-audit.ts` / `bun run src/web/a11y.e2e.ts`（无代码改动，不涉及回归）；上述命令为重设计阶段的推荐门禁，本报告未执行。
