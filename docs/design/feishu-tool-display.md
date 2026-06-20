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
| `collapsed`（默认） | 折叠摘要一行，如 `🔧 调用了 N 个工具` | 轮内累计去重计数 N |
| `inline` | 内联列出每个工具名/标题（沿用 `toolName`），如 `🔧 调用工具：A · B · C` | 轮内累计去重名单 |
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
- **collapsed**：`onRouterToolCall` 累加 `toolCount`，注解 = `🔧 调用了 ${toolCount} 个工具`；每次新工具调一次 `streamToolAnnotation(注解)` → 同卡 in-place 刷新计数。
- **inline**：累加 `toolNames`（去重，取 `toolSegmentMeta(u).toolName`），注解 = `🔧 调用工具：${toolNames.join(" · ")}`；同样 in-place。
- **off**：`onRouterToolCall` 仅做 `seenToolCalls` 去重（保持计数器一致性，便于潜在切档），**不调** `streamToolAnnotation`、**不调** `streamSegmentBreak`、不动卡；prose 照常流。

### 3.3 为何不用方案 B（channel 把注解拼进 `streamUpdate` 文本）
方案 B（`streamUpdate(rt.buffer + "\n\n" + 注解)`，零 sender 改动）问题：注解会被当成 turn-text 计入偏移/rollover/兜底；`streamUpdate` 语义是"全量单调 turn 文本"，prose 在工具后继续增长会排到注解之后→**顺序错乱**；变化的尾缀可能触发"绝不回退到更短显示"的单调守护（`card-sender.ts:605-615`）→ 误 rollover。**仅 collapsed（纯计数尾注、无顺序）勉强可用，inline 不行。** 故推荐 A。

### 3.4 多卡轮的注解归属（size/age rollover）
一轮 prose 超长会 size/age rollover 成多卡。**注解只跟随当前 live（尾）卡**：
- **因 size/timeout/segment rollover 被封的"头卡"不带注解**——头卡的 display 用 **body-only** 组合（纯 prose + 现有结构修复 `closeFence`/continuation），注解推迟到续卡。这样：(a) 头卡 size 预算只按 body 算（不受注解影响）；(b) 注解不会在多张卡上重复。
- 注解在续卡上随 body 一起重新组合渲染；turn 提交（finalize）时落在最后一张 live 卡上。
- 实现要点：seal 路径（`sizeRollOver` `card-sender.ts:604-661`、`sealLiveAndContinue` 663-690、`finalizeCurrentCard` 722-730 用于 segment/image 边界）组合头卡显示时**走 body-only compose**（不加注解后缀）；只有"非 seal 的常规 live 编辑"和"turn 提交的最后一张卡"才加注解。详见 §3.5。

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
- **单调显示守护不破**（`card-sender.ts:605-615`：绝不把 live 卡改写成更短）：body 单调增长 + 注解单调增长（计数升 / 名单增），故 `composeDisplay` 单调增长。唯一边界——body 自己补上闭合 ``` 那一刻 display-only close 消失：因 body 至少增加了 ``` 的字节，净显示仍 ≥ 之前，守护不触发（列入 §8 测试 13 边界）。

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

1. **collapsed — 一轮多工具不产生多条新消息**：注入 `prose, tool_call×3(交错 update), prose, idle`。断言 `send`（interactive 新消息）次数 == 纯 prose 驱动的卡数（不随工具递增）；`content` 更新里出现 `🔧 调用了 3 个工具`（N 正确、去重正确）。
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
15. **size/timeout rollover 带注解不丢、不重复、不破 continuation**：长 body（含一段跨卡 code fence）+ 工具 + 触发 size rollover（和单独一例 `maxCardAgeMs` timeout rollover）。断言：(a) 注解只出现在**最后一张 live/最终卡**，前序被封头卡**不含注解**（不重复）；(b) turn finalize 后注解**存在且正确**（不丢）；(c) 跨卡 fence 的 `closeFence`/`reopen`（`pendingContinuation`）仍正确，注解未污染 continuation（reopen 前缀不含注解）。

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
- **R6 文案与 i18n**：`🔧 调用了 N 个工具` / `🔧 调用工具：A · B · C` 措辞与分隔符；飞书 channel 现有文案均中文（与 `defaultToolHint` 一致），确认沿用中文、暂不做 i18n？
- **R7 per-binding 覆盖**：本次仅全局，后续再加 per-binding。确认。

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

**未跑的 gate**：本阶段纯 spec、无实现改动，**未运行** `bun test` / tsc（无代码改动，不涉回归）。§8/§9 的命令是实现阶段门禁，本文档未执行。
