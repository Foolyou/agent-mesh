# 飞书出站工具通知降扰 — 实现 Spec

> Slug `feishu-tool-display`，分支 `task/feishu-tool-display`，基线 main `ba8644d`。
> **本阶段只出 spec，不写实现。** 下面所有 file:line 均以 builder 实读 `ba8644d` 源码为准。
> 设计文档位置：沿用 `docs/design/`（与 [feishu-rich-outbound.md](./feishu-rich-outbound.md) 同目录），本文件即建议交付位置，合适。

---

## 0. 痛点与根因（实读校正）

**痛点**：router 一轮里工具调用越多，飞书"叮"得越多——每个工具调用都触发一条新出站消息。

**根因（lead 描述 + 实读校正）**：`feishu-channel.ts:775` 收到 `tool_call` / `tool_call_update` → `onRouterToolCall(rt, u)`（`feishu-channel.ts:876`）→ 调 `rt.sender.streamSegmentBreak(toolSegmentMeta(u))`（`feishu-channel.ts:886`）。

> ⚠️ **校正 lead 给的 `sender.ts:157`**：`sender.ts:157` 是**文本兜底** sink `LarkSender.streamSegmentBreak`。但**默认出站路径是 CardKit 的 `CardSender`**（`index.ts:97-98`：`outbound.cardkit !== false` 时用 CardSender，LarkSender 仅作其 fallback）。真正每轮生效的是 **`card-sender.ts:291` `CardSender.streamSegmentBreak`**。两条 sink 的 segment-break 都"封旧卡/旧消息、开新卡/新消息"，所以无论走哪条，**每个工具调用 → seal 当前卡 + 新建一张 interactive 卡（新 `im.v1.message.create`）= 飞书按新消息推送通知**。同一张卡 in-place 流式更新（`cardElement.content` push）**不会**重新通知（`card-sender.ts:583-592`）。

**降扰核心**：工具调用**不再封新消息**，统一渲染进**当轮的那张流式卡**（in-place `content` 更新），不再 per-tool 新消息。

---

## 1. 现状机制（confirmed，实读）

### 1.1 出站 sink 契约 `OutboundSink`（`feishu-channel.ts:38-59`）
`enqueue / stop / streamUpdate?(full) / streamCommit?() / streamSegmentBreak?(meta?) / whenIdle?() / sendOneShot?()`。`CardSender`（`card-sender.ts`，默认）与 `LarkSender`（`sender.ts`，文本兜底）都实现它。FeishuChannel 通过 `useStreaming(rt)`（`feishu-channel.ts:791`）判断是否走流式。

### 1.2 CardKit 流式卡四步（`card-sender.ts` 头注释 + `doStreamOp` 549-598）
`card.create` → `message.create(msg_type:"interactive")`（**唯一一次产生新消息/通知**）→ `cardElement.content` push（**in-place，不通知**，seq 严格递增，`stableCardKey(cardId,seq)` 幂等）→ `card.settings finalize`（封卡）。一张卡 = 一条飞书消息。

### 1.3 工具调用如何变成"新消息"（核心噪点链路）
- `onRouterToolCall`（`feishu-channel.ts:876-887`）：按 `toolCallId` 去重（`rt.seenToolCalls`，`feishu-channel.ts:880-881`），然后 `streamUpdate(rt.buffer)`（让旧段显示终态）+ `streamSegmentBreak(toolSegmentMeta(u))`。
- `CardSender.streamSegmentBreak`（`card-sender.ts:291-300`）：置 `streamSegmentBreaking=true` + `streamBreakMeta`，驱动 `driveStream`。
- `driveStream`（`card-sender.ts:433-447`）：有 live 卡时 `finalizeCurrentCard("segment_break")`（封卡，`card-sender.ts:722-730`），再把 `currentHint = toolHintFor(meta)` 作为**下一张卡的首行**（`defaultToolHint`，`card-sender.ts:815`：`🔧 调用工具：<name>`）。
- 后续 prose 经 `doStreamOp` 的 `!this.live` 分支 → `card.create + message.create` = **新卡 = 新消息 = 通知**。
- 工具调用后无 prose（纯工具收尾）时：`card-sender.ts:420-430` 在边界把"仅 hint"的卡 materialize 成一张独立卡（也是新消息）。

### 1.4 cosmetic 注解与 turn-text 解耦（关键复用点，`card-sender.ts:692-700`）
`composeDisplay(body)` = `currentHint`（首行 hint，**不计入** turn-text 偏移）`+ body`，或 `pendingContinuation.displayPrefix + body`。`live.sentText` 只记 turn body（`card-sender.ts:166-167` 注释明确"WITHOUT the cosmetic hint prefix"）。**这证明 CardSender 已支持"与 turn-text 偏移解耦的卡内 cosmetic 文本"——本 spec 的工具注解直接复用/泛化这套机制。**

### 1.5 turn 边界 / 兜底 / commit barrier（confirmed）
- 主边界：`agent_activity=idle` → `finalizeTurn`（`feishu-channel.ts:784-786`）。
- 兜底：每个 chunk **和每个 tool_call** 之后 `scheduleStreamFinish(rt)`（`feishu-channel.ts:768、779`）——`streamCommitDebounceMs`（默认 3000）后若无 idle 就 `streamFinish`。**工具调用现在兼任"turn 收尾兜底触发器"**（`feishu-channel.ts:777-779` 注释）。
- 双触发幂等：`streamFinish` 用 `rt.streamTurnActive` 守护（`feishu-channel.ts:828-844`），不会二次 commit。
- commit barrier：`streamCommit()` 在异步 sink 上先返回再异步封卡 → `beginCommitBarrier`（`feishu-channel.ts:850-860`）置 `committing=true` + `commitGen++`，下一轮事件在 `dispatchRouterEvent` 入口被 `queuedEvents` 暂存（`feishu-channel.ts:754-758`），`whenIdle()` resolve 后按序回放（`endCommitBarrier` 862-871）。`commitGen` 让被取代的 barrier resolve 变 no-op。
- replay 不镜像：`replaying` 期间 return（`feishu-channel.ts:744`）；`clearOutboundBuffer`（889-908）清 buffer/queue/`seenToolCalls` 并按需重建 barrier。

### 1.6 配置落点（confirmed）
`outbound` schema：`types.ts:86-103`（`minIntervalMs/streaming/cardkit/streamMinEditIntervalMs/streamCommitDebounceMs/maxEditsPerMessage`）。解析+默认：`config.ts:62-94`。CardSender 选用：`index.ts:79-98`。CardSender 选项：`index.ts:104-135`（注意：**当前没传** `enableToolHint/toolHint`，走 `card-sender.ts:256-257` 默认 `true`/`defaultToolHint`）。`provision.ts:173` 写 `feishu.json` 的 outbound 默认 `{ minIntervalMs: 500 }`。

---

## 2. 目标方案

新增 `outbound.toolDisplay: "collapsed" | "inline" | "off"`，默认 `collapsed`。三档共同核心：**工具调用不再 `streamSegmentBreak`，统一渲染进当轮流式卡，in-place 更新，不再 per-tool 新消息/通知。**

| 档位 | 卡内渲染 | 计数/标题 |
|---|---|---|
| `collapsed`（默认） | 折叠摘要一行，如 `🔧 Called N tool(s)`（英文，default locale en） | 轮内累计去重计数 N |
| `inline` | 内联列出每个工具名/标题（沿用 `toolName`），如 `🔧 Tools: A · B · C`（` · ` 分隔） | 轮内累计去重名单 |
| `off` | 完全不渲染工具 **UI** | 仍消费事件做去重 + 收尾判断，仅不渲染 |

三档都**保留** `scheduleStreamFinish`（兜底）、`seenToolCalls` 去重、commit barrier、replay、幂等。

### 2.1 核心不变量（INVARIANT — 须写死并附测试）

> **INV-1（finalize-fallback 解耦）**：finalize-fallback 与"开新消息"**彻底解耦**。工具调用的职责从"封旧卡 + 开新消息"降为**唯一一件事——调度/触发当前 turn 的 finalize**（`scheduleStreamFinish`）。即：
> - 工具调用**不再开任何新消息/新卡**（不再 `streamSegmentBreak`）；
> - 工具调用**仍调度当前 turn 的 finalize 兜底**（`feishu-channel.ts:779` 的 `scheduleStreamFinish`），使"工具收尾 + idle 丢失"的轮仍能交付、不拖到下一轮、不粘 buffer；
> - 这条对 **collapsed / inline / off 三档一致成立**——finalize 触发与"是否渲染工具 UI"完全正交。
>
> **INV-2（off 仍消费事件）**：`off` **只抑制工具 UI 渲染**，不抑制事件消费。`off` 下 `onRouterToolCall` 仍：① 走 `seenToolCalls` 去重、② 通过 `dispatchRouterEvent` 触发 `scheduleStreamFinish` 做收尾/turn-end 判断（INV-1）。`off` ≠ "丢弃工具事件"，仅 ≠ "渲染工具"。
>
> 两条不变量都有**专门测试**（§8 测试 11/12）守护，防止后续重构把 finalize 兜底误绑回"开新消息"或让 off 退化成"吞掉事件导致收尾判断丢失"。

---

## 3. 渲染方案：注解如何 in-place 进当轮卡，不开新消息

**推荐方案 A（sender 渲染 cosmetic 注解，泛化 §1.4 的 `currentHint`）**，对比见 §3.3。

### 3.1 数据流（A）
1. **Channel 拥有 mode→字符串映射 + 计数**：`BindingRuntime` 新增每轮工具状态（见 §4）。`onRouterToolCall` 去重后更新状态，composeAnnotation→交给 sender。
2. **Sender 渲染**：`CardSender` 新增 `toolAnnotation?: string`（cosmetic，**不计入** `streamBaseOffset/live.sentText` / continuation 扫描），在 `composeDisplay` 里作为 body 的**尾部块**追加——但**必须先把 body 当前未闭合的结构（code fence）显示性地闭合**，再渲染注解（详见 §3.5）：
   ```
   composeDisplay(body) =
     [continuation prefix] + body
     + (toolAnnotation ? structuralClose(body) + "\n\n" + toolAnnotation : "")
   // structuralClose(body) = body 末尾若有未闭合 fence 则补一行 fence marker（display-only，
   //                          不写回 sentText）；table 无需 close；无开放结构则为空。
   ```
   （`currentHint` 仍是首行 prefix；二者不同时出现——见 §10 R5，工具路径不再用 currentHint。`structuralClose` 复用 `continuationAfter(body).openFence` + `fenceMarkerOf` 推导，与现有 `appendCloseFence` 的 display-only 语义一致，`card-sender.ts:670-687`。）
3. **in-place 更新**：注解变化时驱动一次 `cardElement.content` push（同卡，seq 递增）→ 飞书**不通知**。
4. **新增 sink 方法** `OutboundSink.streamToolAnnotation?(text: string | undefined)`：channel 调它把"当前轮工具注解字符串"推给 sender；`undefined`/`off` 不调或清空。`LarkSender`（文本兜底）实现为 no-op（降级文本不显示工具——见 §10 R3 限制）。

### 3.2 三档映射
> 文案（R6，**已改为英文 + 集中 i18n-ready helper**）：所有注解字符串集中在模块级 `toolDisplayStrings`（按 locale 索引，default `en`），调用点（`composeToolAnnotation`）只查表、不内联硬编码；加语言 = 加表项，不改调用点（非完整 i18n 框架）。
- **collapsed**：`onRouterToolCall` 累加 `toolCount`，注解 = `toolDisplayCopy().collapsed(toolCount)` → `🔧 Called N tool(s)`（n===1→`tool` 否则 `tools`）；每次新工具调一次 `streamToolAnnotation(注解)` → 同卡 in-place 刷新计数。
- **inline**：累加 `toolNames`（去重，取 `toolSegmentMeta(u).toolName`），注解 = `toolDisplayCopy().inline(toolNames)` → `🔧 Tools: ${toolNames.join(" · ")}`；同样 in-place。
- **off**：`onRouterToolCall` 仅做 `seenToolCalls` 去重（保持计数器一致性，便于潜在切档），**不调** `streamToolAnnotation`、**不调** `streamSegmentBreak`、不动卡；prose 照常流。

### 3.2.1 运行计数组：跨卡边界累计，仅按 prose 段 / 真实 turn 结束分组（live 反馈修正）
> 真机反馈：一轮里工具批次碎成 `🔧 Called 6 tools → 3 → 1 → 1`。根因：工具执行有 >`streamCommitDebounceMs`(默认 3s) 的间隙时，**fallback 计时器**会 `streamFinish` 封卡并**重置 `toolCount/toolNames/seenToolCalls`**，使下一批从 0 重数。

**修正：工具计数组（dedupe+count+names）只在"组真正结束"时重置，绝不在单纯封卡时重置。**
- **组结束 = 真实 turn 边界**（idle / 新 turn agent_turn-started / prompt-resolve / pre-prompt / replay / teardown）**或新 prose 段**。
- **不重置**：fallback 计时器封卡（`streamFinish(rt, endsGroup=false)`，仅交付卡、不动计数）、size/timeout rollover（在 sender 内、根本不碰 channel 的计数）。
- 落点：`streamFinish(rt, endsGroup=true)` 默认重置；唯独 fallback 回调传 `false`。`resetToolGroup(rt)` 统一清三件套。
- **按 prose 段分组**：新可见 prose 到达且当前组已有工具（`rt.toolCount > 0`）→ `streamSealSegment()` 把当前卡**封成该段的最终卡（保留其注解）**+ `resetToolGroup`，新 prose 的工具从 1 重新计。
- **效果**：无 prose 间隔的连续工具批次累计成一个运行计数（`6→3→1→1` ⇒ 跨卡累计到 `Called 11 tools`，最后一卡显示总数）；prose 段之间各自成组。
- **sender 侧 `streamSealSegment()`**：`proseSeal` 标志 → driveStream 顶部优先封当前卡（`finalizeCurrentCard("segment_break")`，**保留注解**=该段最终卡）+ 清 `toolAnnotation`，续卡接管。`finalizeCurrentCard` 据 reason 区分：rollover 系（size/timeout/image）**strip**注解（组继续，§3.4），`turn_commit`/`segment_break` **保留**注解（组结束）。
- **INV-1 不破**：fallback 仍 finalize（卡仍交付，工具收尾轮不卡死）——只是不重置计数。off 不受影响（off 下 `toolCount` 恒 0，永不触发 prose-seal）。
- **已知局限**：因 INV-1 要求 fallback 封卡，>3s 间隔的批次仍落在不同卡上（各显示累计中的运行计数，最后一卡=总数），而非合并成单卡单条。要真正合并成一张卡需重审"tool-only 轮是否走 fallback finalize"（与 INV-1/现有测试冲突，留待 prdmgr）。

### 3.3 为何不用方案 B（channel 把注解拼进 `streamUpdate` 文本）
方案 B（`streamUpdate(rt.buffer + "\n\n" + 注解)`，零 sender 改动）问题：注解会被当成 turn-text 计入偏移/rollover/兜底；`streamUpdate` 语义是"全量单调 turn 文本"，prose 在工具后继续增长会排到注解之后→**顺序错乱**；变化的尾缀可能触发"绝不回退到更短显示"的单调守护（`card-sender.ts:605-615`）→ 误 rollover。**仅 collapsed（纯计数尾注、无顺序）勉强可用，inline 不行。** 故推荐 A。

### 3.4 多卡轮的注解归属（size/age rollover）
一轮 prose 超长会 size/age rollover 成多卡。**注解只跟随当前 live（尾）卡，绝不在多卡重复**：
- **任何 NON-`turn_commit` 的 seal（size/timeout rollover、image 边界、segment break）= 头卡 → 不带注解。** 注解推迟到续卡；`turn_commit`（最后一张卡）才保留注解——那就是尾卡。
- **关键修正（reviewer 返工）**：若一张卡在被封为头卡前**已经显示过注解**（`live.sentAnnotation !== undefined`），仅靠"seal 路径走 body-only compose"不够——卡上已渲染的注解不会自动消失。必须在 finalize **之前**对该头卡做**一次 body-only 的 `content` 重绘**（去掉注解后缀，必要时补 close fence），把注解从头卡抹掉，再 finalize；续卡再重新渲染注解。这是一次**有意的 seal 边界显示缩短**（仅此一次、非 mid-stream 单调路径），失败仅 cosmetic（body 已显示，不 giveUp/不重发）。
  - 落点：`sealLiveAndContinue`（size/timeout rollover）先 body-only 重绘+strip 注解再 finalize；`finalizeCurrentCard(reason)` 对 `reason !== "turn_commit"` 且 `sentAnnotation !== undefined` 也做同样 strip（覆盖 image 边界等直接 finalize 的路径）。strip 成功后 `live.sentAnnotation = undefined`。
- 续卡随 body 重新组合渲染注解（`toolAnnotation` 未清，仍是当前轮状态）；turn 提交时落在最后一张 live 卡上。
- 头卡 size 预算只按 body 算（注解已推迟到续卡），不受注解影响。详见 §3.5。

### 3.5 工具注解与 Markdown 结构修复 / size budget 的交互（reviewer 返工，核心）

> 现有 CardSender 是 **prefix + body** 模型：`planSizeSplit(body, maxCardBytes, splitStart())` 只按 `displayPrefix + body` 预算（`card-sender.ts:908-916`，`prefixBytes + byteLen(body) <= budget`）；`splitStart()` 只给 `displayPrefix/openFence/tableHeader`（704-709）；`composeDisplay` 只处理 prefix（696-700）；fence 的 close/reopen 修复都围绕 prefix + body。直接在 body 后**裸追加 suffix** 会引入三个 bug，必须在 spec 钉死规避：

**问题 1 — 注解字节未进 size 预算 → 可能超 `maxCardBytes` → card update 失败/fallback。**
**修法**：把注解（含其 `structuralClose` + `"\n\n"` 分隔）的字节纳入 size 预算。推荐**接口方向**（reviewer 建议）：把 display 组合从 *prefix-only* 泛化为 **prefix + body + suffix**，并同步扩展 size planner：
- 给 `planSizeSplit` 增加 `suffixBytes`（或 `displaySuffix: string`）参数，在预算里与 `prefixBytes` 一同扣减：`prefixBytes + byteLen(body) + suffixBytes <= budgetBytes`，line-boundary 命中判定（977 行）同样加上 `suffixBytes`。
- `splitStart()` 增加 `suffixBytes`（= `byteLen(structuralClose(body) + "\n\n" + toolAnnotation)`，注解缺省为 0），供 planner 预算。
- **等效最小改法**（备选，无签名变更）：调用处传入 `planSizeSplit(body, maxCardBytes - suffixDisplayBytes, splitStart())` 做等效预算扣减。推荐前者（显式 suffix 参数，语义清晰、便于测试）。
- 结果：临近 `maxCardBytes` 时**先 size split**（注解推迟到续卡，见 §3.4），注解永不把当前卡推过预算。

**问题 2 — body 处于未闭合 code fence 时，裸 suffix 会渲染进代码块；`appendCloseFence(composeDisplay(...))` 还会把 closing fence 放到注解之后。**
**修法**：注解**必须在所有开放结构之外渲染**。`composeDisplay` 当注解存在时，先 `structuralClose(body)`（body 末尾未闭合 fence → 补一行 fence marker，display-only、不动 `sentText`；table 无需 close），再空行 + 注解（见 §3.1 公式）。同时**修正 seal 路径的组合顺序**：现有 `appendCloseFence(this.composeDisplay(headText/sentText), closeFence)`（`card-sender.ts:616/676`）在头卡上调用——因头卡走 **body-only compose（§3.4，不含注解）**，`appendCloseFence` 仍只作用于 body 的 close，顺序不变、无回归。注解只出现在不需要 `appendCloseFence` 外层 close 的 live/最终卡上，且其 `structuralClose` 已自带 body 的结构闭合。

**问题 3 — open fence 的 live 显示：临时 close fence + 渲染注解，且不得改变 `sentText/offset`。**
**修法（落实 reviewer 第 4 点）**：
- live 卡 body 末尾在 fence 内时，注解前的 `structuralClose(body)` 临时补 close fence——**纯 display，`live.sentText` 仍是裸 body**（与 `sealLiveAndContinue` 的 close-fence "append-only、never touch sentText" 同构，`card-sender.ts:675-686`）。
- **同一卡内继续同一 body 无需 reopen**：每次 `content` 编辑都全量重算 `composeDisplay(newBody)`，display-only 的 close 每次重新推导，body 增长后自然覆盖；reopen 只发生在**跨卡 rollover**，由现有 body 的 `pendingContinuation` 机制负责（`card-sender.ts:660/689`），**注解不参与 continuation reopen**。
- **mid-stream 单调显示守护不破**（`card-sender.ts:605-615`：mid-stream 绝不把 live 卡改写成更短）：mid-stream body 单调增长 + 注解单调增长（计数升 / 名单增），故 mid-stream 编辑单调增长。**例外：seal 边界的 body-only strip（§3.4）是有意的一次性缩短**——它发生在卡即将 finalize、续卡接管之时（不是 mid-stream），把注解从头卡移到尾卡；这是该卡生命周期的最后一次 `content` 编辑，UX 上等价于"注解换到下一张卡"，可接受。唯一 mid-stream 边界——body 自己补上闭合 ``` 那一刻 display-only close 消失：因 body 至少增加了 ``` 的字节，净显示仍 ≥ 之前，守护不触发（列入 §8 测试 13 边界）。

**不变式补充**：注解是纯 cosmetic 后缀，**永不进入** `live.sentText`、`streamBaseOffset`、`continuationAfter` 扫描、`planSizeSplit` 的 `body` 实参（只进它的 *budget*）。turn-text 偏移/fallback/replay 会计全部只看裸 body。

---

## 4. 三档 `onRouterToolCall` 改法

**改前**（`feishu-channel.ts:876-887`）：去重 → `streamUpdate(buffer)` → `streamSegmentBreak(meta)`。

**改后**（伪码，`this.toolDisplay` 来自配置）：
```
onRouterToolCall(rt, u):
  if not useStreaming(rt): return
  id = toolCallId(u)
  if id: if seenToolCalls.has(id) return; seenToolCalls.add(id)
  else if sessionUpdate != "tool_call": return        // 无 id 的 update 当续传，不重复计
  // —— 不再调用 streamSegmentBreak（INV-1：工具不开新消息）——
  if toolDisplay == "off": return                       // INV-2：已消费(上面 seenToolCalls 去重)；
                                                         //   收尾判断由 dispatchRouterEvent 的 scheduleStreamFinish 负责；
                                                         //   仅跳过 UI 渲染。prose 照常流。
  rt.toolCount++                                         // 轮内累计
  if toolDisplay == "inline":
    name = toolSegmentMeta(u).toolName
    if name and not rt.toolNames.includes(name): rt.toolNames.push(name)
  if rt.buffer.trim(): rt.sender.streamUpdate(rt.buffer) // 先刷最新 prose
  rt.sender.streamToolAnnotation?(composeToolAnnotation(rt, toolDisplay))
```
- **去重**：`seenToolCalls` 原样保留（`tool_call`+多次 `tool_call_update` 同 id 只计一次）。
- **`scheduleStreamFinish` 不动**：仍在 `dispatchRouterEvent`（`feishu-channel.ts:779`）于 `onRouterToolCall` 之后无条件调用——**三档都靠它保兜底**。
- **`BindingRuntime` 新增**：`toolCount: number`、`toolNames: string[]`（与 `seenToolCalls` 同生命周期）。
- **状态重置**：凡 `seenToolCalls.clear()` 处都加 `toolCount=0; toolNames=[]` 并清 sender 注解——即 `streamFinish`（`feishu-channel.ts:841`）、`flush`（925）、`clearOutboundBuffer`（901）。sender 侧 `resetTurn()` 清 `toolAnnotation`。

---

## 5. finalize-fallback 如何保留（三档都必须保住 — 落实 INV-1）

工具调用现在**只**兼任 turn 收尾兜底触发器（INV-1：不再开新消息）。三档下都要保证"**工具后无后续文本 + idle 丢失也能 finalize**"，避免回复晚一轮 / 粘 buffer。

- **触发器不变（INV-1）**：`dispatchRouterEvent` 在处理 `tool_call`/`tool_call_update` 后仍调 `scheduleStreamFinish(rt)`（`feishu-channel.ts:775-780`）——这是 channel 行为，**与是否 segment-break / 是否渲染 UI 完全正交**，原样保留。解耦后："开新消息"这一职责被剥离，只剩"调度当前 turn finalize"。
- **collapsed / inline 的纯工具收尾轮**：轮内只有工具、无 prose。兜底 fire → `streamFinish` → `streamCommit` → `driveStream` 走 commit 分支。此时 body 空但 `toolAnnotation` 非空：**泛化现有"仅 hint 卡" materialize 路径**（`card-sender.ts:420-430` 的 `!this.live && currentHint !== undefined`）使其同样覆盖 `toolAnnotation !== undefined`，从而 materialize 一张"仅注解"的卡（一条消息）并封卡。→ 工具轮仍有交付，不拖到下一轮。
- **off 的纯工具收尾轮**：无注解、无 body → finalize 时无卡可开 → 安静收尾（这正是 off 的语义）。需确保：`rt.buffer` 本就为空（工具不写 buffer），`streamFinish` 空 commit、`resetTurn` 干净、不把任何东西粘到下一轮。
- **幂等**：`streamFinish` 的 `streamTurnActive` 守护不变（兜底 fire 与迟到 idle 不二次 commit）。

---

## 6. 不破坏 commit barrier / 去重 / replay / 幂等

| 机制 | 保留策略 |
|---|---|
| `committing/queuedEvents/commitGen` | **不变**。tool 事件仍走 `dispatchRouterEvent`，barrier 期间照样入队回放。改动**减少**异步 commit（工具不再 `streamCommit/segmentBreak`），barrier 触发仍只来自 turn 边界 `streamFinish`→`beginCommitBarrier`。 |
| `seenToolCalls` 去重 | **不变**，仍按 `toolCallId` 去重；新增 `toolCount/toolNames` 与它同清。 |
| replay 不镜像 | **不变**；`clearOutboundBuffer` 额外清 `toolCount/toolNames` + sender `toolAnnotation`（与 `seenToolCalls.clear()` 同处，`feishu-channel.ts:901`）。 |
| 幂等 key | **不变**。卡内注解更新仍是 `content()` op，`stableCardKey(cardId, seq)` 单调；**无新 `message.create` ⇒ 无新 send uuid ⇒ 无新通知**。 |
| `streamSegmentBreak` 机制 | 工具路径不再触发它（全仓仅 `onRouterToolCall` 调用过——`feishu-channel.ts:886`）。`currentHint/toolHint/enableToolHint`/segment_break 分支随之**休眠**；本次**保留不删**（小 diff、可逆），见 R5。 |

---

## 7. 配置 schema 落点

1. **`types.ts:86-103`** outbound 接口加：
   ```ts
   /** 工具调用在卡内的呈现：collapsed=折叠计数 / inline=列出工具名 / off=不显示。默认 collapsed。
    *  三档都不再为工具调用开新消息（降扰核心）。缺省/旧配置无此字段时等同 collapsed。 */
   toolDisplay?: "collapsed" | "inline" | "off";
   ```
2. **`config.ts:62-94`** 解析：`const toolDisplay = (out.toolDisplay === "inline" || out.toolDisplay === "off") ? out.toolDisplay : "collapsed";`（**任何非法/缺省值 → collapsed**），写入返回的 `outbound`。
3. **线程**：`cfg.outbound.toolDisplay` →
   - `FeishuChannel` 构造（新增私有 `toolDisplay`，参照 `streamCommitDebounceMs` 的读法 `feishu-channel.ts:207`）：决定 `onRouterToolCall` 行为。
   - sender 侧只需 `streamToolAnnotation` + 注解卡路径，**不需要知道 mode**（channel 拼好字符串），故 `index.ts:104-135` 基本不动（除非选择把 mode 也下传，不必要）。
4. **缺省/旧配置**：无字段 ⇒ collapsed（§7.2 兜底）。`provision.ts:173` 可选地把默认 outbound 写成 `{ minIntervalMs: 500, toolDisplay: "collapsed" }`（非必需，缺省已等同）。
5. **per-binding 覆盖**：**列为后续**。本次仅全局 `outbound.toolDisplay`。（`FeishuMeshBinding`，`types.ts:109+`，将来可加 per-binding `toolDisplay` 覆盖全局。）

---

## 8. 测试计划

新增/扩展 `card-sender.test.ts` + `feishu-channel.test.ts`（+ `config.test.ts`）。核心断言点 = **统计 sender 的 `create`/`send`（= 新消息）次数**，而非肉眼看卡。

1. **collapsed — 一轮多工具不产生多条新消息**：注入 `prose, tool_call×3(交错 update), prose, idle`。断言 `send`（interactive 新消息）次数 == 纯 prose 驱动的卡数（不随工具递增）；`content` 更新里出现 `🔧 Called 3 tools`（N 正确、去重正确）。
2. **inline — 同上但列名**：断言注解含三个工具名、仍无 per-tool 新消息。
3. **off — 不渲染工具但仍不新消息**：断言无 `🔧` 注解、无额外 `create/send`，prose-only 卡数不变。
4. **以工具结尾的轮仍 finalize**：`prose, tool_call, （无 idle）` → 推进假时钟过 `streamCommitDebounceMs` → 兜底 fire。collapsed/inline 断言 materialize 一张注解卡（一条消息）并 finalize；off 断言安静收尾、`buffer` 不粘到下一轮（下一轮首 chunk 开新卡、不 concat）。
5. **纯工具收尾轮（无 prose）**：collapsed/inline materialize 仅注解卡；off 无卡。
6. **去重**：`tool_call` + 同 id 多次 `tool_call_update` → 计数只 +1。
7. **replay 不退化**：turn 中途 `replay_started` → `clearOutboundBuffer` 清 `toolCount/toolNames/seenToolCalls/注解`；断言下一轮计数从 0、无 stale。
8. **commit barrier 不退化**：barrier 期间到达的 tool 事件入 `queuedEvents`、`whenIdle` 后按序回放；复跑既有 barrier 测试保持绿。
9. **幂等/seq 不退化**：注解 `content` op 的 `stableCardKey(cardId,seq)` 单调递增；断言无新 send uuid（无新通知）。
10. **回归**：`bun test src/channels`（card-sender / feishu-channel / sender / stream-segmenter / config 全绿）。

**专门守护核心不变量（§2.1）：**

11. **INV-1（finalize-fallback 与"开新消息"解耦）三档一致**：对 collapsed / inline / off **各跑一遍** `prose, tool_call,（无 idle）`，断言：(a) 工具调用期间 sender 的 `streamSegmentBreak` **零调用**、`create/send`（新消息）**不因工具递增**；(b) 假时钟过 `streamCommitDebounceMs` 后 turn **确实 finalize**（`streamFinish` 触发、`streamTurnActive` 复位）；(c) 下一轮首 chunk 开新卡、不与上一轮 concat。即"工具 → 不开新消息 + 仍触发当前 turn finalize"对三档恒成立。用 spy 直接断言 `streamSegmentBreak` 调用数 === 0 以钉死解耦。
12. **INV-2（off 仍消费事件、只抑制 UI）**：off 下注入 `tool_call(id=A) + tool_call_update(id=A) + tool_call(id=B),（无 idle）`，断言：(a) **无任何 `🔧` 注解 / 无额外 `create/send`**（UI 抑制）；(b) `seenToolCalls` 确实记录了 A、B（去重生效——可通过"再来一个 id=A 的 update 不改变任何状态"间接断言）；(c) 兜底 fire 后 turn **正常 finalize**（收尾判断未被 off 吞掉）。即 off ≠ 丢弃事件。

**专门守护注解与结构修复 / size budget 交互（§3.5，reviewer 返工）：**

13. **未闭合 code fence 时注解在代码块外**：collapsed/inline，body = 以未闭合 ` ``` ` 结尾的片段（如 `"前言\n```js\nconst a=1"`）+ `tool_call`。断言渲染的 card content：(a) 注解 `🔧 …` **不在** code block 内——注解前出现一行闭合 ` ``` `（`structuralClose`）；(b) `live.sentText` 仍是裸 body（不含 close fence/注解），`streamBaseOffset` 不被注解/close 改动；(c) 边界：body 随后自己补上闭合 ` ``` ` 时，显示仍单调不变短（不触发 shrink 守护/误 rollover）。
14. **临近 `maxCardBytes` 时注解不超预算/不 fallback**：构造 body 使 `prefixBytes + byteLen(body) + 注解显示字节` 略超 `maxCardBytes`。断言：(a) 发生 **size split**（头卡 body-only、不含注解），注解落到续卡；(b) 任何单张 card 的 display 字节 **≤ `maxCardBytes`**；(c) **不触发 `giveUp()`/文本 fallback**（content op 全 `ok`）。对照：去掉注解预算的实现会让该 case 超预算——用注解字节占满边界来区分。
15. **size/timeout rollover 带注解：出现次数 === 1、只在尾卡、头卡 body-only（reviewer 返工强化）**：**两个独立用例**——(15a) timeout rollover（`maxCardAgeMs` 老化）、(15b) size rollover（注解显示后 body 增长超预算）。两者都：先 streamUpdate 小 body + streamToolAnnotation 让注解显示在头卡，再触发 rollover。用 `finalDisplays(r)`（取每张卡的**最终** content）断言：(a) 含注解的卡**恰好 1 张**（`filter(includes(ann)).length === 1`，**不重复**）；(b) `finals[0]`（头卡）**不含注解**且仍含其 body（head body-only）；(c) `finals.at(-1)`（尾卡）**含注解**（归属正确、不丢）；(d) 无 fallback（`fb.enqueued` 空）；size 用例额外断言每卡 ≤ `maxCardBytes`。这直接复现并防回归 reviewer 报的"注解在 rollover 前后两卡重复"。

---

## 9. 实现步骤（建议顺序，逐步可测）

1. **config**：`types.ts` 加 `toolDisplay`；`config.ts` 解析+默认 collapsed；`config.test.ts` 补"缺省/非法→collapsed、三值透传"。
2. **channel**：`FeishuChannel` 读 `toolDisplay`；`BindingRuntime` 加 `toolCount/toolNames` 并在三处 reset 点清；按 §4 重写 `onRouterToolCall`（去 segment-break、加注解）；保留 `scheduleStreamFinish`。
3. **sender（含 §3.5 结构/预算交互）**：
   - `OutboundSink` 加 `streamToolAnnotation?`；`CardSender` 加 `toolAnnotation` 状态、`resetTurn` 清。
   - `composeDisplay` 泛化为 **prefix + body + (structuralClose(body) + 注解)**（§3.1 公式）；新增 `structuralClose(body)`（复用 `continuationAfter(body).openFence` + `fenceMarkerOf`，display-only）。
   - **up-to-date 判定纳入注解**：`live.sentText===body && live.sentAnnotation===toolAnnotation` 才算最新。
   - **size 预算纳入注解**：`planSizeSplit` 增加 `suffixBytes`（或 `displaySuffix`）参数并在预算+命中判定里扣减；`splitStart()` 返回 `suffixBytes`（注解的 `structuralClose+"\n\n"+annotation` 字节，缺省 0）。备选：调用处 `maxCardBytes - suffixDisplayBytes` 等效扣减。
   - **seal 路径 body-only**：`sizeRollOver`/`sealLiveAndContinue`/`finalizeCurrentCard`（segment/image 边界）封头卡时走 body-only compose（不含注解），注解推迟到续卡（§3.4）。
   - **仅注解卡 materialize**：泛化 `card-sender.ts:420-430` 的 `!live && currentHint!==undefined` 路径覆盖 `toolAnnotation!==undefined`（纯工具收尾轮，§5）。
   - `LarkSender` 实现 no-op `streamToolAnnotation`（R3）。
4. **tests**：§8 全部（含结构/预算 13-15）；复跑 `bun test src/channels`。
5. **docs**：本 spec 落库；`feishu-rich-outbound.md` 加一句交叉引用（已加）。

> 顺序保证每步独立可验证；config/sender/channel 改动文件不重叠于其他在飞 task（仅 `src/channels/*` + 本 doc）。

---

## 10. 风险点 / 需 prdmgr·用户拍板的开放问题

- **R1 注解位置与顺序**：建议"单条尾部块、不与 prose 交错排序"（契合 collapsed 折叠摘要 / inline 名单的产品意图）。是否需要把工具显示在 prose **之前**或做分隔线？请拍板。
- **R2 多卡轮注解归属**（已细化，见 §3.4/§3.5）：建议**只跟随当前 live/尾卡**，被封头卡 body-only 不带注解（避免重复、头卡按 body 预算）。可接受？
- **R3 文本兜底（CardKit 失败降级）**：建议 `LarkSender.streamToolAnnotation` no-op（降级纯文本不显示工具）。还是要在兜底文本里也补一行计数？
- **R4 off 的纯工具轮安静收尾**：用户会看到"只调了工具的那轮"无任何输出——这正是 off 语义，确认可接受？
- **R5 休眠的 segment-break/`currentHint`/`toolHint`/`enableToolHint`**：建议本次**保留不删**（更小 diff、可逆）。是否要顺手清理为后续单独任务？
- **R6 文案与 i18n**：✅ **已定（覆盖早前"中文不 i18n"）**：默认**英文**——collapsed `🔧 Called N tool(s)`（按 n 简单单复数）、inline `🔧 Tools: A · B · C`（` · ` 分隔）。文案集中在模块级 `toolDisplayStrings`（default locale `en`，i18n-ready：加语言只改表、不改调用点），**不建完整 i18n 框架**。（注：dormant 的 `defaultToolHint` 仍为中文，属保留的旧 segment-break 路径 R5，不在 R6 范围。）
- **R7 per-binding 覆盖**：本次仅全局，后续再加 per-binding。确认。

---

## 11. 真机回归：兜底定时器对"纯工具轮"误封卡（根因 + 修复方案，仅设计，待审）

> slug `feishu-tool-card-seal-regression`，基线 main `09f50d5`（实读核实）。**真机现象**：一轮里每个工具调用各自封成独立卡/新消息、计数累加：`🔧 Called 1 tool` / `Called 2 tools` / … / `Called 5 tools`，每个工具都"叮"。**本节只出根因+修复设计+测试计划，不实现。**
> **根因双确认**：builder（本人，实读 09f50d5）与 reviewer（独立 read-only RCA）**结论一致**，链路无分歧。本轮已**采纳 reviewer 的两点精化**：① 判据从我初版的 `rt.buffer.trim()` 计算改为**显式 `BindingRuntime` 标志 `finalizableProseSinceCommit`**（§11.2，更清晰、零 sender introspection、能表达 streamSealSegment 特例）；② 测试新增**真 CardSender recorder 门禁 T0**（假 sink 漏掉了本 bug，§11.5）；并据此把 off 也统一为"纯工具 fallback 跳过"（§11.4，需更新旧 off 用例）。

### 11.1 根因链路（实读 `feishu-channel.ts@09f50d5` 核实，行号为该版本）
1. 工具事件到达 → `dispatchRouterEvent` 的 tool 分支（801-806）：`onRouterToolCall(rt,u)` 累加计数/刷新注解（in-place），**随后无条件 `scheduleStreamFinish(rt)`（805）** 重排兜底定时器。
2. `scheduleStreamFinish`（840-851）：`streamCommitDebounceMs`（默认 3000ms）静默后回调 **`streamFinish(rt, false)`（848）**。
3. `streamFinish`（868-884）：`rt.sender.streamCommit!()`（877）**封掉当前 live 卡** + `rt.buffer=""`（878）+ `currentMessageId=undefined`（879）+ `beginCommitBarrier`（883）；因 `endsGroup=false` **不**调 `resetToolGroup`（881）→ `toolCount/toolNames/seenToolCalls` **不归零**（这是 tool-count-merge 的有意行为）。
4. 下一个工具 → `onRouterToolCall` 时已无 live 卡（上一卡被封）→ CardSender **另开一张新卡**（=新 `im.v1.message.create`=新"叮"），且因计数未归零，新卡显示**累加值**。
5. 工具执行之间的"思考/执行间隔 >3s"会让步骤 2 的兜底**逐个间隔触发** → 每个间隔封一卡 → 真机 `1/2/3/4/5` 各自一张卡、计数累加。

**结论：prdmgr 的判断属实，已实读核实。** 根因本质 = **兜底定时器（lost-idle 把卡住的"正文"发出去的保护）被纯工具活动的中途停顿误触发**，对一张"只有工具注解、没有未终结正文"的卡做了不该做的封卡。tool-count-merge 解决了"计数重置"，但**没解决"封卡本身"**——所以真机表现为"计数对了，但仍碎成多卡多叮"。（这正是我在 tool-count-merge 交付时 flag 的 remaining risk：INV-1 要求 fallback 封卡，>3s 间隔批次仍落不同卡，须重审。）

### 11.2 "新可终结正文" vs "纯工具活动"的**真实状态判据**（实读字段，非猜测）
> reviewer 独立做了 read-only RCA，与本节根因链路**一致**；其判据建议（显式标志）比我初版的"`rt.buffer.trim()` 计算"更清晰，本节**采纳为最终方案**（见 §11.3），并按 prdmgr 硬要求 grounded 到真实字段。

**真实状态事实（逐字段核实）**：
- **`rt.buffer: string`（仅"正文累加器"，非 CardSender live 状态、非工具 UI）**：由 `appendRouterChunk`（1127-1164）维护——只在收到**新可见 agent_message_chunk 正文**时增长（`textOf(content)` 非空且非重复/全量重发；返回 `true` 才算"新正文"）；**仅**在 `streamFinish`(878)/`flush`(990)/`clearOutboundBuffer`(963)/teardown(1038) 清空为 `""`。其 `trim()!==""` 等价于"有未终结正文"，但它是**派生量**——故采用一个显式标志直接表达该语义更稳（见下）。
- **`rt.currentMessageId?` / `rt.currentMessageStart`**（1132-1163）：是 **ACP message-chunk 的增量/全量重发合并锚（coalescing state），不是飞书卡片/消息 id**；随 commit 一并 `undefined`/复位(879)。澄清以免误读为 Feishu 卡 id。
- **`rt.toolCount`（+`toolNames`/`seenToolCalls`）**：当前运行工具组；`onRouterToolCall` 累加；off 档**提前 return、不累加 → off 下 `toolCount` 恒 0**。
- **`rt.streamTurnActive`**：有未终结内容（`scheduleStreamFinish` 置 true；`streamFinish` 起手 `if(!streamTurnActive) return` 防重复 commit）。
- **CardSender live 状态是私有**（`live.sentText`/`live.sentAnnotation`/`streamPending`/`streamBaseOffset`/`toolAnnotation`/`streamCommitting`）：纯工具卡在 sender 侧表现为 `live.sentText===""`+`live.sentAnnotation!==undefined`（card-sender.ts:632 创建、`composeLiveDisplay("")` annotation-only 775-777）——这是**佐证**，但 **FeishuChannel 不得 introspect CardSender 私有状态**（保持分层）；判据只用 channel 自有字段。

**采纳的判据 — 显式 BindingRuntime 标志 `finalizableProseSinceCommit`**（aka `hasUncommittedProse`/`streamProseDirty`）—— **这是实现的真理之源（source of truth），不是 `rt.buffer.trim()` 派生量**：
- **初始化 = `false`**（BindingRuntime 创建时；channel 自有字段，非 sender 状态）。
- **set = true**：**仅当** `appendRouterChunk` 对**新可见正文** chunk 返回 `true`（chunk 分支 781 命中、prose 自上次 commit 起实质可终结）时置位。**`appendRouterChunk` 返回 `false` 的 chunk（重复/replay/全量重发）不置位；工具 call/update 永不置位。**
- **reset = false**：在 `streamFinish`/`flush`/`clearOutboundBuffer`/teardown/runtime reset 处复位（与 buffer 清空同处）。**绝不**因"工具 fallback 触发并跳过"而复位——跳过路径只 `return`、不动此标志（见 §11.3）。
- **streamSealSegment 特例**：prose-after-tools（chunk 分支 788-792）刚 `streamSealSegment` 封了旧工具卡，但**新可见正文已 append 进 buffer 且尚未提交** → 此时**不要**因 seal 而清 `finalizableProseSinceCommit`（它要保护这段新正文直到被真正 commit）。即：seal 段卡 ≠ 提交新正文。
- 于是：**"纯工具活动、无可终结正文" ⟺ `!finalizableProseSinceCommit`**；**"有新可终结正文" ⟺ `finalizableProseSinceCommit===true`**（lost-idle 保护对象）。
- **`rt.buffer.trim()==="" && rt.toolCount>0` 仅作为解释/测试症状提及**（语义上与本标志等价，便于理解真机表现），**不是实现判据**——实现以本标志为准（不依赖对 buffer 的派生推断、零 sender introspection、能精确表达 streamSealSegment 特例）。

### 11.3 修复方案（仅设计）
**仅改兜底定时器的回调语义**：fallback fire 时，若**纯工具活动且无可终结正文**，**不封卡**（不 `streamCommit`）——保持同一张 live 卡、工具注解继续 in-place 更新，等**真实轮边界**再提交；保留对正文的 lost-idle 保护。

把 `scheduleStreamFinish`（848）的回调从无条件 `streamFinish(rt,false)` 改为按 `finalizableProseSinceCommit`（§11.2）分流（伪码）：
```
// fallback timer callback:
if (!rt.finalizableProseSinceCommit) {
  // 纯工具活动、无未终结正文：保持 live 卡——不 streamCommit、不清 buffer/currentMessage 状态、
  // 不 beginCommitBarrier、不 resetToolGroup。注解卡继续 in-place 更新。
  // 不重排 timer——下一个工具会自然重排(805)；真实边界(idle 810/agent_turn started 残留 finalize/
  // pre-prompt 437/prompt-resolve 576/replay-clear)会 finalizeTurn→streamFinish 提交一次。
  // streamTurnActive 保持 true，真 idle 仍能提交。
  this.tlog(rt, "fallback-skip-toolonly");
  return;
}
this.streamFinish(rt, false); // 有未终结正文 → 照旧交付(lost-idle 保护)
```
- **真实轮边界提交**：`idle`(810-812)、新 turn `agent_turn started`(残留 finalize)、入站 prompt 的 pre-prompt 边界(437)、assistant prompt-resolve(576) —— 均已 `finalizeTurn → streamFinish(endsGroup=true)`，会**把那张累积的工具卡提交一次并重置组**。
- **lost-idle 正文保护不丢**：`finalizableProseSinceCommit===true`（prose+tools，或纯 prose）仍走 `streamFinish` 交付。
- **不重排 timer**：跳过时不再 `scheduleStreamFinish`；下一工具会重排，真边界会提交。代价=纯工具轮若 idle 真丢失，卡会"generating"到下一轮 pre-prompt 才封（可接受：纯中间活动、无正文卡住；真 idle 的常态会及时提交）。**这是开放问题 O1（见 §11.6）**。

> 说明：`streamSegmentBreak`/`proseSeal` 状态**不参与**本判据——它只在"prose-after-tools"（chunk 分支 788-792）触发，与 fallback 无关；fallback 时无 pending segment break。

### 11.4 不破坏清单（逐项核实）
- **INV-1（显式"细化"，非静默破坏）**：INV-1 的**核心**（工具调用不开新消息、与"开新消息"解耦）**保留并强化**。INV-1 重述为：**"lost-idle 正文仍经 fallback 提交（`finalizableProseSinceCommit` 时）；纯工具(no-finalizable-prose)的 fallback **有意推迟**到真实轮边界提交。"** 即早前子断言"纯工具收尾轮经 fallback 提交"被有意改变。对应测试 `feishu-channel.test.ts:853` "a tool_call with no following text finalizes via the fallback timer" **必须更新**（见 §11.5 T4b）。**这是核心语义变化，需 prdmgr 确认**（开放问题 O2）。
- **commit barrier / queuedEvents / commitGen**：跳过分支**不**调 `beginCommitBarrier` → `committing` 保持 false → 后续工具事件正常 dispatch（不入队）；真实边界提交时照旧 begin 一次 barrier。语义不变。
- **seenToolCalls 去重**：`onRouterToolCall` 路径完全不动；去重不变。
- **replay 不镜像**：`clearOutboundBuffer`(963 区) 不变；replay 仍清 buffer+组。
- **idempotency**：卡 op 的 `stableCardKey`/seq 不动；纯工具轮少了多余封卡 → 反而更少 op。
- **off 语义（采纳 reviewer：off 也跳过）**：off 的纯工具轮无正文 → `finalizableProseSinceCommit===false` → fallback **同样跳过、不 commit**（off 本就无 live 卡/无注解，跳过即"消费/去重但不渲染不提交"，符合 reviewer "off consumes/dedupes but no UI/commit on tool-only fallback"）；真 idle 仍提交。**注意**：这比我初版"off 仍 commit"更统一，但 `feishu-channel.test.ts:766`（off 纯工具轮 `advance(3000)` 后断言 `commits()===1`）**必须更新**为"fallback 后 `commits()===0`，idle 后才 `commits()===1`"（见 T5）。off 的去重/`seenToolCalls` 消费不变。
- **tool-count merge**：本修复与 merge **互补**——merge 让计数跨边界不重置，本修复**移除纯工具的多余边界**；二者合力 = 纯工具批次落在**一张** live 卡、计数 in-place 累积。`:780/:797`（跨 fallback 累计）断言注解累积值，跳过封卡后注解仍累积 → **预期保持绿**；但若其暗含"fallback 已 commit"的隐含状态，需按 T1 同步（这些假 sink 用例**漏掉了真机 bug**，原因见 §11.5 注）。
- **rollover 不重复**：纯 sender 内行为（size/timeout rollover 的头卡 strip/尾卡注解），与 channel 兜底改动正交，不受影响。

### 11.5 测试计划（具体场景 + 断言；timer 驱动为硬门禁）
> **关键教训（reviewer 指出）**：现有**假 `streamingSink`**（`feishu-channel.test.ts`）**漏掉了这个真机 bug**——它只记 `commits()`/`annotations`，**不模拟 CardSender 的 live 卡 reset / 新 `create+send`（新消息）**，所以"兜底封卡→下个工具另开新卡"在假 sink 下不可见。因此**必须加一个真 CardSender seam/recorder 测试**（用 `card-sender.test.ts` 的 `cardRecorder`：记 `create`/`send`/`content`/`finalize` + cardId），不能只靠假 sink。

- **T0（硬门禁，真 CardSender recorder）**：channel 接真 `CardSender`（注入 `cardRecorder` + 注入 channel `setTimer`）。序列 `tool c1` → fallback fire → `tool c2` → fallback fire → `tool c3` → `idle`。断言：(a) **只有 1 个 `create`+`send`（=1 张卡/1 条消息，1 个 cardId）**——工具间 fallback **没有**新开卡；(b) `content` 更新依次出现 `Called 1 tool`→`Called 2 tools`→`Called 3 tools`（**同卡 in-place**）；(c) **idle 之前 0 次 `finalize`**；(d) idle 后**恰好 1 次 `finalize`**。这是直接复现真机 1/2/3 多卡多叮并防回归的核心门禁。
- **T1（channel 假 sink 辅助门禁）**：`setupStreaming`（`manualTimers`）：`tool c1`→`advance(3000)`→`tool c2`→`advance(3000)`→`tool c3`→`idle`。断言：两次 `advance` 后 **`commits()===0`**；`annotations.at(-1)==="🔧 Called 3 tools"`；`idle` 后 **`commits()===1`**；`sealSegments()===0`。
- **T2 纯工具跨多次 fallback fire**：`tool×N` 间穿插多次 `advance(3000)`，无 prose、无 idle。断言每次 fallback 后 `commits()` 不增、（真 sender 下）无新 cardId；`annotations` 单调累积到 `Called N tools`。
- **T3 工具后有正文**：`tool c1`→`advance(3000)`(跳过)→`chunk "done"`→`idle`。断言：fallback 后跳过(commits 不增)；prose 到达时 `streamSealSegment` 封旧工具卡 + `resetToolGroup`（`sealSegments()===1`），新 prose 卡；其后 `tool c4` 从 `Called 1 tool` 重新计（新组）；`idle` 提交。
- **T4 lost-idle 正文仍送达（且更新 INV-1 用例）**：
  - T4a：`chunk "hello"`→`advance(3000)`（无 idle）。断言 `finalizableProseSinceCommit===true` → **`commits()===1`**（正文 lost-idle 保护照旧交付）。
  - T4b（**替换旧 `:853` 用例**）：纯 `tool c1`→`advance(3000)`。断言 **`commits()===0`**（纯工具轮不再经 fallback 提交）；随后 `idle` → `commits()===1`。
- **T5 off 档（更新旧 `:766` 用例）**：`toolDisplay:"off"`，`tool c1`→`advance(3000)`。断言 **`commits()===0`**（off 纯工具轮 fallback 也跳过、无 UI 无 commit）、无注解、`seenToolCalls` 已消费(去重)；随后 `idle` → `commits()===1`。
- **T6 不破坏 commit barrier/dedupe/replay/idempotency**：跳过分支**不 begin barrier**（断言兜底跳过后紧接的工具事件**不**进 `queuedEvents`、`committing` 仍 false）；复跑既有 dedupe/replay/idempotency 用例保持绿。

### 11.6 开放问题（需 prdmgr/用户拍板）
- **O1 纯工具轮 + 真 idle 丢失的悬挂**：跳过封卡后，若该轮 idle 真丢失，工具卡会"generating"到下一轮 pre-prompt 才封。可接受（无正文卡住、真 idle 常态会及时提交）？还是要给纯工具轮一个**更长的兜底上限**（如 N×debounce 后才强制封一次）以防长期悬挂？
- **O2 INV-1 子断言变更确认**：纯工具收尾轮不再经 fallback 提交（改等真实边界）——确认接受并据此更新 `feishu-channel.test.ts:853`。
- **O3 判据口径（已与 reviewer 收敛）**：采用 channel 自有的显式标志 **`finalizableProseSinceCommit`**（§11.2），**不** introspect CardSender 私有 live 状态（`live.sentText` 等保持私有）。reviewer 与我一致：保持分层、不双保险。此项视为已定，仅留待 prdmgr 最终点头。

---

## 附录：实际读过的文件（实读核对，未跑实现）

- `docs/design/feishu-rich-outbound.md`（现状 §1.1-1.6、locked decisions、§4 segment 模型）。
- `src/channels/feishu-channel.ts`（全量重点：`OutboundSink` 38-59、`BindingRuntime` 119-146、`onMeshEvent`/`dispatchRouterEvent` 713-788、`useStreaming` 791、`streamCurrent/finalizeTurn` 795-807、`scheduleStreamFinish/streamFinish` 809-844、`beginCommitBarrier/endCommitBarrier` 846-871、`onRouterToolCall` 873-887、`clearOutboundBuffer/scheduleFlush/flush` 889-929、`toolSegmentMeta` 1103-1107）。
- `src/channels/sender.ts`（LarkSender 全量：`streamSegmentBreak` 157、`driveStream/doStreamOp/rollOver/pump`）。
- `src/channels/card-sender.ts`（CardSender 全量重点：seams/常量 29-134、状态 198-244、`streamUpdate/streamSegmentBreak/sendOneShot/streamCommit/whenIdle` 279-332、`driveStream` 349-470、`bodyOf` 473、`emitImageCard/replaceImage/doStreamOp/sizeRollOver/sealLiveAndContinue` 481-690、`composeDisplay/splitStart/toolHintFor/finalizeCurrentCard/doFinalize` 692-734、构造默认 246-269、`defaultToolHint` 815；**本轮返工补读**：`appendCloseFence` 839-842、`byteLen` 845、`CardContinuation/CardSizeSplit` 863-879、`fenceMarkerOf` 882、`planSizeSplit` 908-1003（预算 `prefixBytes+byteLen(body)<=budget`，无 suffix）、`continuationAfter` 1008+）。
- `src/channels/types.ts`（`FeishuChannelConfig.outbound` 67-107）。
- `src/channels/config.ts`（解析/默认 58-101）。
- `src/channels/index.ts`（sink 选用 79-98、`cardSenderOptions` 104-135）。
- `src/channels/provision.ts`（outbound 默认 173）。
- **§11 真机回归本轮（main `09f50d5` 实读）**：`feishu-channel.ts` 的 `dispatchRouterEvent` tool/chunk 分支(770-814)、`scheduleStreamFinish`(840-851)、`resetToolGroup`(853-861)、`streamFinish(rt,endsGroup)`(863-884)、`beginCommitBarrier`(886+)、`finalizeTurn/streamCurrent`(821-833)、pre-prompt 边界(437)、prompt-resolve(576)、`BindingRuntime` 字段(buffer/currentMessageId/currentMessageStart/streamTurnActive/committing/commitGen/queuedEvents/toolCount/toolNames/seenToolCalls)、`appendRouterChunk`(1127-1164 真实 buffer 语义)；`card-sender.ts` 的 `doStreamOp` 创建(632 `sentText/sentAnnotation`)、`composeLiveDisplay`(775-777)、up-to-date 判定(431-434)；`feishu-channel.test.ts` 受影响用例(766 off、780/797 跨 fallback 累计、853 INV-1 纯工具 fallback)。

**未跑的 gate**：本阶段纯设计文档、无实现改动，**未运行** `bun test` / tsc（无代码改动，不涉回归）。§8/§9/§11.5 的命令/用例是实现阶段门禁，本文档未执行。
