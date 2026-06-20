# Feishu rich outbound — table component + artifact image + streaming split (research)

Status: **research / design only** (original). **Superseded in part by the post-probe implementation decisions below.**
Goal: render outbound router prose that contains GFM **tables** as Feishu **CardKit table components**, and `artifact:` **images** as uploaded Feishu **img** elements — the hard part being the **streaming split** of an incremental prose/table/image stream into ordered card elements.

---

## ⚑ Implementation decisions (LOCKED after the live probe — supersede parts of this research)

A real Feishu live probe (bot Legion → mesh-dev chat, 3 cards, all `code=0`) plus user observation changed two premises:

1. **GFM tables stay markdown — NO table component.** The probe confirmed Feishu's **markdown element renders GFM pipe tables as real tables**, and the user chose markdown over the native `table` component. ⇒ The segmenter does **not** parse tables, emits no `table` element, and §2 (table component) + decision ⑥ (5-tables/card, 50-column block split) are **obsolete**. Tables/code/links all stay in prose markdown. The only non-markdown thing extracted is an **`artifact:` image**.

2. **Images are CARD BOUNDARIES (Opt-2), not same-card `insert_before` (Option B).** `src/channels/card-sender.ts` is a deep **single-element** streaming state machine (`streamBaseOffset` / `live.sentText` / `fallbackOffset` / `planSizeSplit` all assume one contiguous text stream into one element). Retrofitting same-card multi-element `insert_before` insertion (the earlier §4.6 Option B) is **high regression risk** on a production path. **User-approved Opt-2:** at an artifact-image boundary the sender **seals the current prose card → sends a separate image/placeholder card → continues prose on a fresh card**. Order + non-blocking behavior are preserved; the tradeoff (more cards) was accepted. The prose-only path stays **byte-identical** to pre-C2 (the image cap is `Infinity` when there are no artifact images).

**C3 (artifact image upload) decisions:**
- **B1 is used (verified).** The Feishu outbound `CardSender` is built **in-process** in `src/channels/index.ts` (`buildFeishuChannel`, backend process), so it has the storage `root` and reads artifact bytes **directly** via `resolveArtifactFile` (`src/channels/card-image.ts` `readArtifactImage`). No authorized-endpoint hop (B2 was not needed). Cross-agent reads need only same-mesh.
- **Non-blocking swap (Opt-2 + C3).** At an image boundary the sender posts the placeholder card immediately and resolves+uploads **asynchronously**; when it resolves it `cardElement.update`s that standalone card's element to the uploaded `img` (or, on failure/over-limit, a degrade link/text). `whenIdle` (the commit barrier) drains in-flight image tasks. Prose never blocks on an upload.
- **Cache** key `(mesh, owner, file, size, mtime) → image_key` (only successful uploads cached). **Limits** (user-locked): `> 10MB` OR `width > 1500` OR `height > 3000` OR aspect `height:width > 16:9` → degrade without uploading (dimension checks are best-effort via a PNG/JPEG/GIF reader; unknown dims skip the dim/aspect check and rely on Feishu's upload validation). **Degrade** = lark_md link to the web **console viewer route** `${MESH_CONSOLE_URL}/mesh/<mesh>/agent/<owner>/artifact/<path>` (NOT the raw `/api` fetch endpoint, which needs a bearer token) when `MESH_CONSOLE_URL` is set, else plain text. **Secret hygiene**: logs are GENERIC status strings only — never the artifact ref / owner / file / path, the bytes, the image_key, or a raw SDK/Error message; the degrade markdown carries only the `alt` + the console URL (which contains the file path by design).
- **`mesh_publish_attachment` scope.** Images published via `mesh_publish_attachment` flow to Feishu **only when the router's prose references them** as `![](artifact://<owner>/<file>)` (covered by the same path). The standalone `attachment_published` event surface is NOT wired into outbound (the channel consumes only the router's text stream) — that is a **separate seam**, intentionally out of C3 scope.

These are the authority for the C1/C2/C3 implementation; where this older research conflicts (table component, in-card Option B), the decisions above win.

Evidence tags: `[confirmed]` = verified in repo source or official docs/SDK; `[inference]` = reasoned from confirmed facts; `[not verified]` = could not confirm, designed around.

Sources (official):
- Card JSON 2.0 structure — https://open.feishu.cn/document/feishu-cards/card-json-v2-structure
- Table component — https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/table
- Image component — https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/image
- Upload image API `im.v1.image.create` — https://open.feishu.cn/document/server-docs/im-v1/image/create
- SDK: `@larksuiteoapi/node-sdk@^1.67.0` (`node_modules/.../types/index.d.ts`, cardkit at L33391).

---

## 1. Current outbound path

### 1.1 Card shape today — a single markdown element `[confirmed]`
`src/channels/card-sender.ts` `streamingCardJson()` (L895-912) emits ONE markdown element:
```json
{ "schema": "2.0",
  "config": { "update_multi": true, "streaming_mode": true,
              "streaming_config": { "print_frequency_ms": {"default":70}, "print_step": {"default":1}, "print_strategy": "fast" },
              "summary": { "content": "<derived>" } },
  "body": { "elements": [ { "tag": "markdown", "element_id": "md", "content": "<full text>" } ] } }
```
`DEFAULT_ELEMENT_ID = "md"` (L91). `content` carries the **full accumulated** text, not a delta.

### 1.2 Streaming model — four CardKit ops, monotonic sequence `[confirmed]`
Header comment L6-10 + impl:
1. `cardkit.v1.card.create` (`sdkCardCreate` L914) — build the card entity from `streamingCardJson`.
2. `im.v1.message.create` `msg_type:"interactive"` (`sdkCardSend` L924) — send once, references `card_id`.
3. `cardkit.v1.cardElement.content` (`sdkCardContent` L940) — push the full markdown; `sequence` strictly increasing; `uuid = stableCardKey(cardId, seq)` idempotency.
4. `cardkit.v1.card.settings` (`sdkCardFinalize` L951) — turn boundary, `streaming_mode:false` + summary.

Sequence: single monotonic counter `this.sequence` (L189-190), `nextSeq()` (L631); Feishu rejects out-of-order with `CARD_SEQUENCE_ERROR_CODE = 300317` (L89). Updates send full accumulated body (`doStreamOp` L390-438, `content: this.composeDisplay(body)` L425); Feishu animates via `streaming_config`. Throttle `minEditIntervalMs` default 250ms (L215) keeps under Feishu's ~10 updates/s/card cap (L9).

### 1.3 Size rollover — already structure-aware `[confirmed]`
Per-element char limit ~**30000** before Feishu returns `code:230099 / ErrCode:11310 "element exceeds the limit"` (SDK doc `streamMaxElementChars`, types L301163). `planSizeSplit()` (L739) splits at safe markdown boundaries, **already handles open code fences and tables** by closing+reopening on the next card (`continuationAfter()` L839, `sealLiveAndContinue()` L510, `FinalizeReason` incl. `size_rollover` L27). `maxCardBytes` (L114/220), `maxCardAgeMs` rollover (L322).

### 1.4 Commit barrier / turn boundary / fallback `[confirmed]`
- Content enters via `feishu-channel.ts`: `onMeshEvent` (L709) → `dispatchRouterEvent` (L749) → `agent_message_chunk` → `appendRouterChunk` (L1056, dedups Claude delta-then-full resends) → `streamCurrent` → `rt.sender.streamUpdate(rt.buffer)` (L791-797). Only the **router** agent feeds the channel (L727).
- Turn end: `agent_activity idle` → `finalizeTurn`; or a tool-call/turn-start; or the silence timer `scheduleStreamFinish` (default `streamCommitDebounceMs=3000ms`, L805) → `streamFinish` → `sender.streamCommit()` → `beginCommitBarrier` (L846), which holds later router events in `rt.queuedEvents` until `whenIdle()` resolves, then replays them in order (`endCommitBarrier` L858).
- `streamCommit()` (L260) → `driveStream` → `finalizeCurrentCard` (L562) → `doFinalize` (`card.settings`).
- **Fallback-to-text**: any failed op (`create`/`send`/`content`/`finalize`) calls `giveUp()` (L586): sets `fellBack`, records `fallbackOffset` = chars already confirmed on cards, and forwards the **remainder** to a plain-text `LarkSender` (`forwardFallback` L593, `forwardFallbackCommit` L611). Never re-sends confirmed text.

### 1.5 Files a future impl touches `[confirmed]`
| File | Role today | Change |
|---|---|---|
| `src/channels/card-sender.ts` | single-element streaming driver | core: multi-element model, table/img element ops, segmenter wiring, fallback degrade |
| `src/channels/feishu-channel.ts` | aggregates router chunks → `sender.streamUpdate(fullText)` | minimal — keep feeding full text; segmentation lives in the sender/segmenter |
| `src/channels/index.ts` | `cardSenderOptions()` (L81) wiring | pass artifact-reader + image-upload deps |
| (new) `src/channels/stream-segmenter.ts` | — | pure incremental prose/table/image parser (the crux; unit-tested) |
| (new) `src/channels/card-image.ts` | — | artifact-ref → bytes → `im.v1.image.create` → `img_key` (+cache) |
| `src/channels/types.ts` / `sender.ts` | sink contract / text fallback | unchanged (fallback reused) |

---

## 2. Feishu CardKit table component

### 2.1 Schema `[confirmed]` (official table doc)
- Tag: **`"table"`**.
- `columns[]`: `{ name (key, required), display_name?, data_type (required), width? ("auto" | "[80px,600px]" | "[1%,100%]"), horizontal_align? (left|center|right), vertical_align? (top|center|bottom), format? (number only: symbol/precision[0,10]/separator), date_format? (date only) }`.
- `data_type` ∈ `text | lark_md | options | number | persons | date | **markdown**`. Cells can hold markdown (`markdown`/`lark_md`).
- `rows[]`: array of `{ "<columnName>": value }`; `persons` → user ids, `date` → unix ms.
- Limits: **≤ 50 columns** (excess not displayed); **≤ 5 tables per card** (per language); `page_size` ∈ `[1,10]`, default 5; overflow cells ellipsize.

### 2.2 Partial / streaming update? `[inference]` / `[not verified]`
The table doc does **not** document any partial/incremental update of table rows; `[not verified]` that a table can be char-streamed like the markdown `content` path. **Design around it: treat a table as a whole element** — buffer the GFM table until complete, then emit it once.

What IS confirmed for multi-element streaming: the SDK exposes **per-element CardKit ops**, each with the same monotonic `sequence` + `uuid` protocol (`types/index.d.ts` cardElement @L33391) `[confirmed]`:
- `cardElement.create` — `{ type: "insert_before"|"insert_after"|"append", target_element_id?, elements: string (JSON array), sequence, uuid? }` → add new element(s) at a position.
- `cardElement.update` — `{ element: string (full element JSON), sequence, uuid? }` (path `card_id`,`element_id`) → replace a whole element.
- `cardElement.patch` — `{ partial_element: string, sequence, uuid? }` → partial element update.
- `cardElement.content` — `{ content, sequence, uuid }` → stream text into a markdown element (today's path).
- `cardElement.delete` — `{ sequence, uuid? }`.

⇒ A table becomes a `table` element added via `cardElement.create(type:"append")` once complete (or replaced via `cardElement.update` if we ever stream rows). Prose stays on `markdown` elements streamed via `cardElement.content`. **No whole-card replacement needed** `[inference]`.

`[not verified]` whether the Feishu **markdown element renders GFM pipe tables** at all — the task premise (use the table component) implies it renders them poorly/not; we route tables to the table component regardless.

---

## 3. Artifact image path

### 3.1 Upload API + img element `[confirmed]`
- Upload: `im.v1.image.create` (`/open-apis/im/v1/images`), `image_type:"message"`, multipart file → returns **`image_key`**. Present in SDK (`client.im.v1.image.create`).
- Card element: **`{ "tag":"img", "img_key":"<image_key>", "alt": {…}, ... }`**; optional `element_id` (≤20 chars), `title`, `scale_type` (crop_center|crop_top|fit_horizontal), `size` (stretch|large|medium|small|tiny | "[1,1000]px [1,1000]px"), `preview` (default true), `transparent`, `corner_radius`, `margin`.
- Constraints: dimensions in **1500×3000 px** range, **≤ 10 MB**, aspect height:width **≤ 16:9**. `[confirmed]` (image doc).

### 3.2 Artifact resolution `[confirmed]`
- On disk: `{artifactsRoot}/artifacts/{mesh}/{agent}/{file}` (`src/web/artifacts.ts` `artifactAgentDir` L15-22). Per-agent dir injected as env `AGENT_MESH_ARTIFACTS` at spawn (`src/control-plane.ts` L1139-1145). Name guard `[A-Za-z0-9._-]`, no `..`, symlink/traversal rejected (`resolveArtifactFile` L33-49; `isInside`).
- Refs (`src/web/client/Markdown.tsx` `rewriteArtifactRef` L143-161): `artifact:<file>` → caller's own agent dir; `artifact://<owner>/<file>` → **owner agent's** dir in the **current mesh** (owner parsed from the URL; `..`/host-like names rejected; mesh is always the author's, never from the URL). Cross-agent reads need no extra permission beyond same-mesh `[confirmed]` (§5 of artifact map).
- Bytes reader to reuse: `resolveArtifactFile(root, mesh, agent, relPath)` → `{ bytes, contentType }` (validates magic bytes for raster images via `sniffImage`; SVG excluded; `MAX_AGENT_FILE_BYTES = 5MB`). `gateway.serveAgentArtifact` (L837) wraps it for the web API.
- `mesh_publish_attachment` (`src/mcp/mesh-services.ts` L545; handler `control-plane.ts` L1964) — owner is always `ctx.agentId`; emits `attachment_published` event. (Relevant as a parallel surface, not required for outbound rendering.)

### 3.3 Wiring risk `[not verified]` — does the Feishu channel process see artifacts?
`resolveArtifactFile` is web-side and needs `artifactsRoot`. The Feishu channel runs as its own subprocess (see project history). **Open question:** whether the channel process has the `artifactsRoot` path + permission to read another agent's artifact dir, or whether image bytes must be fetched through an authorized backend endpoint. Two options in §4.6.

---

## 4. Streaming split design (core)

### 4.1 Segment model
Parse the incremental router text into an ordered sequence of segments:
- `prose` → a `markdown` element, streamed via `cardElement.content`.
- `table` → a `table` element, emitted whole via `cardElement.create(append)` once complete.
- `image` (an `artifact:`/`artifact://` image token) → upload bytes → an `img` element via `cardElement.create(append)`.

The card body becomes an **ordered element list** the sender grows: `md#1 → table#1 → md#2 → img#1 → md#3 …`. The sender tracks the "current open markdown element id"; closing a prose run and opening a table/img appends an element and (for following prose) opens a fresh markdown element.

### 4.2 Incremental parser (`stream-segmenter.ts`, pure) `[inference]`
`feishu-channel.ts` already hands the sender the **full accumulated buffer** each tick (`streamUpdate(rt.buffer)`). Keep that; the segmenter is a pure function over the growing buffer that returns committed segments + a trailing "open" region not yet safe to emit. State machine on **line boundaries** (only act on lines terminated by `\n`; the final partial line stays in the open region):

States: `PROSE`, `CODE_FENCE`, `TABLE_MAYBE` (1-line header lookahead), `TABLE_BODY`.
**Table and image detection run ONLY in normal-markdown prose context.** Inside any code context (fenced, indented, or an inline code span) the bytes are forwarded verbatim into the current `markdown` element — pipe lines and `![…](artifact:…)` there are code, not a table/image. `[inference]` This guard is checked BEFORE the table-header / image-token checks below.

Code-context guards (all on the same line-boundary scan):
- **Fenced code blocks** — track an opening fence: a line matching `^(\s*)(`{3,}|~{3,})` (optional info string after). While open, every line (incl. pipe-table-looking and image-token lines) is verbatim prose; the only transition is the **matching close** — a line `^\s*(`{3,}|~{3,})\s*$` using the **same fence char** and **≥ the opening run length** (CommonMark). Track the fence char + length so a `~~~` block isn't closed by ``` and a longer fence isn't closed by a shorter one. State = `CODE_FENCE` while open. `[inference]`
- **Indented code blocks** — a line indented **≥4 spaces** (or a tab) that begins a code block in prose context is treated as code: table detection MUST NOT trigger on such a line (the `^\s*\|` header candidate must require the indent be **< 4 spaces**, i.e. not an indented-code line). `[inference]` `[not verified]` exact CommonMark indented-code interaction with surrounding paragraphs — see fidelity note.
- **Inline code spans** — within a prose line, image-token extraction must skip any region inside a backtick span (`` `…` `` / ``` ``…`` ```), matching the run length of the opening backticks. A `![x](artifact:foo.png)` inside an inline code span stays verbatim, not an image segment. `[inference]`

- `PROSE` (markdown context only): append text to current prose segment. When a completed line matches a **table header candidate** `^\s{0,3}\|.*\|\s*$` (note: indent < 4 so indented code is excluded) AND we are NOT in a code context, hold it (1-line lookahead) and enter `TABLE_MAYBE`. Prose before it (up to the prior `\n`) stays streamable, so prose is never blocked by more than the single held line. A line that opens a fence instead → enter `CODE_FENCE` (no table/image detection until it closes).
- `TABLE_MAYBE`: next completed line is the **separator** `^\s{0,3}\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$`?
  - yes → close the current prose segment, enter `TABLE_BODY` buffering header+separator.
  - no → the held line was prose; flush it + continue `PROSE` (re-checking it for a fence open).
- `TABLE_BODY`: consume data-row lines `^\s{0,3}\|.*\|\s*$`. Table **completes** on the first non-row line (blank/prose/fence-open) OR turn-commit. On completion: parse to the `table` schema, emit the `table` element, open a new prose segment for the trailing text, return to `PROSE`.

Image tokens (PROSE context only, outside inline code spans): scan a completed prose run for a **complete** image markdown `!\[alt\]\((artifact:[^)]+)\)` (and `artifact://…`), skipping any match whose `!` falls inside a backtick span. On a complete token: split the prose at the token (flush prose-before to the markdown element), emit an `image` segment (the artifact ref + alt), then continue prose-after in a new markdown element. A half-typed token (no closing `)`) stays in the open region until complete.

**Parser fidelity `[inference]`:** these ad-hoc guards cover the dominant cases (fenced code, indented code, inline spans) that an agent realistically emits, while staying cheap and incremental (no full AST per tick). They are NOT a complete CommonMark parser — e.g. fences inside blockquotes, lazy continuation lines, or HTML blocks are out of scope and will be treated as prose (safe default: render as markdown, never as a table/image) `[not verified]`. If C1 testing shows the ad-hoc guards misclassify realistic agent output, escalate to a **markdown-aware block scanner** (a real fenced/indented/inline tokenizer driving the segment boundaries) before C2 — flagged as an implementation decision point, not a silent assumption.

### 4.3 Avoiding the failure modes the lead flagged
- **Half-table emitted as prose** — avoided: the header line is held (`TABLE_MAYBE`) and only flushed as prose if the separator does not follow.
- **Blocking later prose** — bounded: only ONE line is ever held in lookahead; prose up to the previous newline keeps streaming. A `TABLE_BODY` that never terminates with a trailing line still flushes at **turn-commit/idle** (existing barrier) and at a **safety guard** (e.g. table buffer > N rows or > maxCardBytes → flush as table; or degrade to a markdown element with the raw rows so nothing is lost).
- **Last table in a turn** (no trailing prose) — flushed by the turn-commit path (§4.5).
- **Partial final line** — never emitted (only `\n`-terminated lines drive transitions); the open tail is re-evaluated on the next tick.
- **Code misclassified as table/image** — avoided by the §4.2 code-context guards: pipe lines and `![…](artifact:…)` inside a fenced block (`` ``` `` / `~~~`), an indented (≥4-space) code block, or an inline backtick span stay verbatim in a `markdown` element; detection runs only in normal prose context. This is high-impact because code-heavy agent responses are common, so it is a first-class test target (§5 C1).

### 4.4 Ordering & sequence `[confirmed]` mechanics, `[inference]` composition
All ops keep the single monotonic `sequence` (reuse `nextSeq()`), serialized through the existing single-flight `driveStream` loop so order = sequence order. Appends use `cardElement.create(type:"append")` (or `insert_after` the last element id). Prose updates use `cardElement.content` on the current markdown element id. Idempotency `uuid = stableCardKey(cardId, seq)` unchanged.

### 4.5 Commit barrier / turn boundary / fallback
- Reuse `streamCommit` → `driveStream` → finalize. On commit, **flush any pending table/image first**, then `card.settings` finalize. The `beginCommitBarrier` queue (L846) already serializes turn boundaries.
- **Fallback degrade (per element, not whole-card):**
  - markdown op fails → existing `giveUp()` → plain-text remainder (unchanged).
  - **table** create/update fails → degrade that table to a markdown element carrying the raw GFM (content preserved), or to text fallback if even that fails. `[inference]`
  - **image** upload/element fails (incl. dimension/size/aspect rejection §3.1) → degrade to a markdown link `[alt](viewer-url-or-name)` rather than dropping content. `[inference]`
- Cross-card rollover (30k/maxCardBytes/age): when a markdown element nears 30k, open a **new markdown element** (append) instead of forcing a new card; force a new card only at `maxCardBytes`/age or the **5-tables/card** cap. Reuse `planSizeSplit`/`continuationAfter` for fence/table-safe cuts.

### 4.6 Image upload sequencing `[inference]` — two options (product choice)
Image upload is async network I/O; it must not stall prose indefinitely nor break sequence order.
- **Option A (simple, MVP):** at an image boundary, flush prose, `await` the upload (brief stall, images are occasional), then `cardElement.create` the `img`, then resume prose. Risk: a slow/large upload pauses the typewriter for that turn.
- **Option B (non-blocking):** at the boundary, append a tiny placeholder element (or reserve position via the next element's `insert_before target_element_id`), keep streaming prose into a new markdown element, and when the upload resolves, `cardElement.update`/`create insert_before` to drop the `img` in. More moving parts + ordering care.
- Bytes source (wiring, §3.3): **B1** channel reads `resolveArtifactFile(artifactsRoot, mesh, owner, file)` directly (needs `artifactsRoot` passed to the channel); **B2** channel fetches via an authorized backend endpoint (`serveAgentArtifact`) — extra hop but no path/permission duplication. Recommend **B1** if the channel already shares the root, else **B2**.
- **Upload cache:** key by `(mesh, owner, file, size, mtime)` → `image_key`, so re-referenced images upload once. `[inference]`

### 4.7 Non-streaming path `[inference]`
For a one-shot send (no live card), run the segmenter over the **final full text**, build the complete `body.elements[]` array (markdown + table + img, images uploaded first), and send one card via `card.create` + `im.message.create`. No per-element ops. Today's non-stream path drops to plain-text `LarkSender`; rich non-stream builds a full multi-element card_json instead, with the same per-element fallbacks.

---

## 5. Implementation plan

Phased, each commit self-contained + tested; stop-and-review between.
- **C1 — segmenter (pure).** New `src/channels/stream-segmenter.ts` + heavy unit tests (the crux): prose/table/image boundaries, 1-line lookahead, half-table-not-prose, half-image-token, multi-table, last-table-at-turn-end, partial final line, CRLF. **Code-context guards (Medium review finding — must-have):**
  - fenced code block (`` ``` `` and `~~~`) containing pipe-table-looking lines → stays verbatim, not a table;
  - fenced code block containing `![x](artifact:...)` → stays verbatim, not an image;
  - indented (≥4-space / tab) code block with pipes → stays verbatim, not a table;
  - inline code span `` `![x](artifact:...)` `` → no image extraction inside the span;
  - fence char/length correctness (`~~~` not closed by ```` ``` ````; longer fence not closed by shorter);
  - a real table/image **outside** any code context is still detected;
  - mixed: prose → fenced code (with pipes) → real table after the fence closes → all classified correctly.
  If these tests expose ad-hoc-guard gaps on realistic output, escalate to a markdown-aware block scanner before C2 (§4.2 fidelity note). No Feishu calls.
- **C2 — multi-element card sender.** Extend `card-sender.ts` to a multi-element model: current-markdown-element tracking, `cardElement.create(append)` for table/img, sequence reuse, size rollover → new markdown element, table degrade-to-markdown fallback. Wire the segmenter. Tests with a fake CardKit client (mirroring `card-sender.test.ts`).
- **C3 — artifact image upload.** New `src/channels/card-image.ts`: resolve `artifact:`/`artifact://owner` (reuse `resolveArtifactFile`), `im.v1.image.create` → `img_key`, upload cache, dimension/size/aspect guard + link degrade. Resolve the §3.3/§4.6 wiring with prdmgr. Tests with a fake upload fn.
- **C4 — non-streaming path + polish + e2e.** Full multi-element card for one-shot sends; integration test through `feishu-channel` with fakes; doc the fallbacks.

### Risks / open questions (for prdmgr/user)
1. `[not verified]` Table **partial/row streaming** — designed as whole-element (buffer-until-complete). OK to render a table only once complete (no live row-by-row)?
2. `[not verified]` Does the Feishu **markdown element render GFM tables** at all? (Affects whether we ever fall back a table to markdown.) Worth a quick live probe before C2.
3. **Image bytes wiring** (§3.3): does the Feishu channel process have `artifactsRoot` + cross-agent read, or must it go through an authorized backend endpoint? (B1 vs B2.)
4. **Image upload sequencing** (§4.6): Option A (await, brief stall) vs B (non-blocking placeholder)? Recommend A for MVP.
5. Image **constraint violations** (1500×3000px / ≤16:9 / ≤10MB; artifacts ≤5MB but dims/aspect unknown): confirm "degrade to link" is acceptable.
6. **5 tables/card** + 50 cols caps: confirm rollover-to-new-card on the 6th table and silent column truncation are acceptable.
7. Should `mesh_publish_attachment` images also flow to Feishu, or only inline `artifact:` image refs in router prose? (Scope.)

### Throwaway probes run (read-only)
- SDK enumerated: `cardElement.{content,create,patch,update,delete}` with `sequence`/`uuid` (`@larksuiteoapi/node-sdk` types L33391); `streamMaxElementChars` default 30000 + err `230099/11310` (types L301163).
- Official docs fetched for table + image component schemas and `im.v1.image.create` (links above).
- No functional code changed; no tests added.
