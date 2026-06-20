# channel-i18n-prompts — channel i18n framework + English mail-prompt copy

Status: **spec / checkpoint-1 (no implementation code)** · branch `task/channel-i18n-prompts` · base `b7a7593`

Two goals: (1) a real channel i18n framework (default `en`, extensible bundles, `{n}` interpolation,
global-default locale resolution with a config switch reserved, per-binding later); (2) convert the
Feishu channel's **generated** system/notification copy from the current Chinese conversational style to
terse English **mail-prompt** style (`[REQ]`/`[FYI]`/`[DONE]`) aligned with mesh `send_mail`. Mirrored
user/agent conversation content is **never** altered.

## Files read + grep approach

Read: `src/channels/feishu-channel.ts` (all user-visible string sites), `card-sender.ts` (tool hint +
card fallback title), and scanned `controller.ts`, `provision.ts`, `index.ts`, `gating.ts`, `config.ts`.

Grep approach (run against `src/channels`, excluding `*.test.ts`):
- `grep -rnP '[\x{4e00}-\x{9fff}]'` — every Han-character line (the conversational copy to convert).
- `grep -rn '\.enqueue('` — every outbound reply to a Feishu chat (the user-visible surface).
- `grep -rn 'toolDisplayStrings\|defaultToolHint\|🔧'` — the tool-annotation copy (team3 overlap).

Findings: **all** user-visible outbound copy is Chinese and lives in **two files only** —
`feishu-channel.ts` and `card-sender.ts`. `controller.ts`/`provision.ts`/`index.ts` emit no user-visible
replies (infra/logs only). `gating.ts` returns booleans, not copy. **team3's `toolDisplayStrings` does
NOT exist on `b7a7593` yet** — `defaultToolHint` is still inline Chinese.

## Inventory (generated system copy vs mirrored content)

### A. User-visible system replies/notifications — **convert** (primary scope)

| key (proposed) | file:line | current (zh) | interpolation |
|---|---|---|---|
| `feishu.cmd.status` | feishu-channel.ts:647 | `mesh "{mesh}" 当前状态：{status}` | mesh, status |
| `feishu.cmd.startAlready` | :651 | `mesh "{mesh}" 已在运行。` | mesh |
| `feishu.cmd.startDone` | :655 | `已启动 mesh "{mesh}"。` | mesh |
| `feishu.cmd.stopAlready` | :659 | `mesh "{mesh}" 已经是 stopped。` | mesh |
| `feishu.cmd.stopDone` | :663 | `已停止 mesh "{mesh}"。` | mesh |
| `feishu.cmd.restartDone` | :668 | `已重启 mesh "{mesh}"。` | mesh |
| `feishu.cmd.newSessionRunning` | :674 | `已为 mesh "{mesh}" 开启新 session。` | mesh |
| `feishu.cmd.newSessionStopped` | :675 | `已清空 mesh "{mesh}" 的 session；下次启动将使用新会话。` | mesh |
| `feishu.cmd.failed` | :681 | `命令执行失败：{error}` | error |
| `feishu.mesh.autostartFailed` | :700 | `目标 mesh "{mesh}" 自动启动失败：{error}` | mesh, error |
| `feishu.deliver.failed` | :427 | `消息已收到，但投递到 mesh "{mesh}" 失败：{error}` | mesh, error |
| `feishu.image.disabled` | :438 | `收到一张图片，但当前未启用图片处理。` | — |
| `feishu.image.unprocessable` | :443,465 | `收到一张图片但无法处理。` | — |
| `feishu.image.downloadFailed` | :460 | `收到一张图片但下载失败。` | — |
| `feishu.assistant.disabled` | :500 | `助手未启用。` | — |
| `feishu.assistant.busy` | :508,548 | `助手正在处理其他请求，请稍后再试。` | — |
| `feishu.assistant.failed` | :559 | `消息已收到，但助手处理失败，请稍后再试。` | — |
| `feishu.auth.failed` | :591 | `授权失败，请稍后再试或联系管理员。` | — |
| `feishu.auth.required` | :1042-1048 (`authCodeReply`) | `你尚未获授权...` + code + operator hint | code |
| `feishu.cmd.help` | :1158-1166 (`meshCommandHelp`) | `mesh "{mesh}" 可用命令：` + 5 lines | mesh |
| `card.fallbackTitle` | card-sender.ts:1052 | `Agent 回复` | — |

### B. Tool annotation — **team3 `feishu-tool-display` owns this** (absorb, don't duplicate)

| key | file:line | current (zh) | interpolation |
|---|---|---|---|
| `tool.hintNamed` | card-sender.ts:815 | `🔧 调用工具：{toolName}` | toolName |
| `tool.hint` | card-sender.ts:815 | `🔧 正在调用工具` | — |

### C. Agent-facing prompt scaffolding — **NOT user-visible** (decision needed, see Uncertainties)

These are sent to the agent (`promptRouter`/assistant) as instructions, never shown to the Feishu user.
They are channel-generated Chinese, so candidates for English-ization, but they are NOT mail-prompt
notifications (they're instructions). Proposed keys `feishu.prompt.*`:

| file:line | current (zh) |
|---|---|
| feishu-channel.ts:1110-1116 (`feishuUserPrompt`) | `来自飞书授权群聊的用户消息...` + `用户消息：{text}` |
| :979-985 (`feishuAssistantPrompt`) | `来自飞书私聊的已授权用户消息...` + `用户消息：{text}` |
| :475,513 | `用户发送了一张图片。` (image-turn prompt) |

### D. Mirrored conversation content — **DO NOT alter**

The streamed user message text and agent reply chunks (`appendRouterChunk`, the buffered card body). Out
of scope by rule.

### Important: KEEP the Chinese **input** aliases

`parseMeshCommand` (feishu-channel.ts:1146-1154) accepts Chinese command aliases for INPUT recognition
(`帮助/状态/启动/停止/关闭/重启/新会话`). These are how a Chinese-speaking user TYPES a command — they are
**not output copy**. They must STAY (removing them breaks Chinese command entry). Only OUTPUT copy is
converted.

## i18n design

- **Placement**: `src/channels/i18n/` — `index.ts` (the `t()` + registry + locale state) and `en.ts`
  (the default bundle). Add `zh.ts` etc. later by registering in `bundles`.
- **Bundle**: a flat `Record<string, string>` keyed by the namespaced keys above (`feishu.*`, `tool.*`,
  `card.*`). Multi-line copy (help, auth) is a single `"line\nline"` string. Flat keys keep lookup and
  the missing-key test trivial.
- **Interpolation**: `{name}` tokens replaced from a params object —
  `tpl.replace(/\{(\w+)\}/g, (_, k) => params?.[k] ?? "")`. Supports the `{n}` form the goal names.
  Unknown token → empty string (never throws). (Backslash-escape `\{` reserved if ever needed; not now.)
- **Lookup**: `t(key, params?, locale?)` → active bundle → `en` fallback → the key string itself if
  absent (and a `console.warn` in dev). `locale?` is reserved for per-binding later; today callers pass
  none and get the global default.
- **Locale resolution**: module-level `currentLocale = "en"` + `setLocale(locale)` (the reserved config
  switch). `bundles: Record<Locale, Bundle>` with `en` always present and the fallback. Per-binding
  locale is a later extension via the `t(..., locale)` arg + a binding→locale map (reserved, not built).
- **Fallback behavior**: missing key in the active locale → look up in `en` → if still missing, return
  the literal key (dev-warn). A present key with a missing param interpolates that token to empty. So a
  partial/foreign bundle never crashes a reply.

## Mail-prompt style guide

Generated notifications use a leading tag + terse, declarative, `key: value` structured body — aligned
with mesh `send_mail`:
- **`[REQ]`** — the operator/user must DO something (approve a code, run a command).
- **`[FYI]`** — informational state/notice/error with no required action.
- **`[DONE]`** — a requested action completed.

Rules: one-line title after the tag; subsequent `key: value` lines for structured detail; no emoji in
notifications (emoji stays only in the tool hint, team3's call); never echo secrets; keep the mirrored
user/agent text untouched.

### Before / after (Category A)

```
status            zh: mesh "{mesh}" 当前状态：{status}
                  en: [FYI] Mesh status\nmesh: {mesh}\nstatus: {status}
start (done)      zh: 已启动 mesh "{mesh}"。
                  en: [DONE] Mesh started\nmesh: {mesh}\nstatus: running
start (already)   zh: mesh "{mesh}" 已在运行。
                  en: [FYI] Mesh already running\nmesh: {mesh}
stop (done)       zh: 已停止 mesh "{mesh}"。
                  en: [DONE] Mesh stopped\nmesh: {mesh}\nstatus: stopped
stop (already)    zh: mesh "{mesh}" 已经是 stopped。
                  en: [FYI] Mesh already stopped\nmesh: {mesh}
restart (done)    zh: 已重启 mesh "{mesh}"。
                  en: [DONE] Mesh restarted\nmesh: {mesh}\nstatus: running
new-session (run) zh: 已为 mesh "{mesh}" 开启新 session。
                  en: [DONE] New sessions started\nmesh: {mesh}
new-session(stop) zh: 已清空 mesh "{mesh}" 的 session；下次启动将使用新会话。
                  en: [DONE] Sessions cleared\nmesh: {mesh}\nnote: next start uses fresh sessions
command failed    zh: 命令执行失败：{error}
                  en: [FYI] Command failed\nerror: {error}
autostart failed  zh: 目标 mesh "{mesh}" 自动启动失败：{error}
                  en: [FYI] Mesh auto-start failed\nmesh: {mesh}\nerror: {error}
deliver failed    zh: 消息已收到，但投递到 mesh "{mesh}" 失败：{error}
                  en: [FYI] Message received, delivery failed\nmesh: {mesh}\nerror: {error}
image disabled    zh: 收到一张图片，但当前未启用图片处理。
                  en: [FYI] Image received, image handling is disabled
image unprocess.  zh: 收到一张图片但无法处理。
                  en: [FYI] Image received, could not be processed
image dl failed   zh: 收到一张图片但下载失败。
                  en: [FYI] Image received, download failed
assistant off     zh: 助手未启用。
                  en: [FYI] Assistant is not enabled
assistant busy    zh: 助手正在处理其他请求，请稍后再试。
                  en: [FYI] Assistant is busy\nnote: try again shortly
assistant failed  zh: 消息已收到，但助手处理失败，请稍后再试。
                  en: [FYI] Message received, the assistant failed\nnote: try again shortly
auth failed (p2p) zh: 授权失败，请稍后再试或联系管理员。
                  en: [FYI] Authorization failed\nnote: try again or contact an operator
auth required     zh: 你尚未获授权使用本群的 mesh。/ 请把下面的授权码发给管理员... / {id} / （管理员执行：...）
                  en: [REQ] Authorization required\ncode: {code}\naction: ask an operator to run `mesh channels feishu approve {code}`
help              zh: mesh "{mesh}" 可用命令： + 5 lines
                  en: [FYI] Commands for mesh {mesh}
                      /mesh status — show status
                      /mesh start — start the bound mesh
                      /mesh stop — stop the bound mesh
                      /mesh restart — restart the bound mesh
                      /mesh new-session — new session for all agents
card title        zh: Agent 回复   →   en: Agent reply   (a card title, NOT a notification: no tag)
```

(The two lead-seeded examples — auth-required `[REQ]` and lifecycle `[DONE] Mesh started … status:
running` — are reproduced verbatim above.)

### Category C (agent-facing; only if approved) — English instruction, NOT mail-tagged

```
feishuUserPrompt   en: An authorized user message from a Feishu group chat. Reply to the user directly;
                       your reply is sent back to that Feishu group verbatim, unless the user explicitly
                       asks you not to reply.\n\nUser message: {text}
feishuAssistantPrompt en: An authorized user message from a Feishu private chat. You are the Mesh
                       Assistant; reply to the user directly; your reply is sent back verbatim.\n\nUser message: {text}
image-turn prompt  en: The user sent an image.
```

## Team3 coordination (`feishu-tool-display` → `toolDisplayStrings`)

team3 is centralizing tool-annotation strings as default-English `toolDisplayStrings`. To avoid two
sources of truth for the same copy:
- **Sequencing (team3 lands first, assumed)**: our framework does NOT redefine the tool strings. After
  team3 lands, our migration *references* `toolDisplayStrings` for the `tool.*` surface — either the
  i18n `tool.hint`/`tool.hintNamed` keys re-export team3's constants, or `defaultToolHint` is already
  team3's and we leave it (already English, already centralized) and simply ensure it's reachable via
  `t()` if a locale ever needs to override it.
- **Conflict file**: both tasks touch `card-sender.ts` (`defaultToolHint`). Strategy: we rebase onto the
  main that includes team3; we OWN Category A (general channel copy) and DROP Category B from our bundle,
  pointing at team3's constants. Our PR's `card-sender.ts` delta is then only `card.fallbackTitle`
  (`Agent 回复` → `Agent reply`), minimizing overlap.
- **If team3 has NOT landed when we implement**: we add a temporary `tool.*` bundle entry (English) plus a
  migration note to fold it into `toolDisplayStrings` when team3 lands; team3's becomes the canonical
  home (no permanent duplication).

## Migration plan (per-commit STOP)

- **C1 — i18n core**: `src/channels/i18n/{index.ts,en.ts}` (`t`/`setLocale`/registry + the en bundle for
  Category A) + unit tests (interpolation incl. `{n}`, missing-param→empty, missing-key→en→key fallback,
  locale switch). No call-site changes (zero behavior change).
- **C2 — migrate feishu-channel.ts (Category A)**: route every command reply / image error / assistant
  notice / `authCodeReply` / `meshCommandHelp` through `t()`. KEEP the Chinese input aliases in
  `parseMeshCommand`. Snapshot tests assert the English mail-prompt output per command/notice.
- **C3 — card-sender + team3 absorb + (optional) Category C**: `card.fallbackTitle` → `Agent reply`;
  wire the tool hint to team3's `toolDisplayStrings` (or temp `tool.*` + migration note); convert
  Category C agent prompts iff approved.

## Tests

- **i18n unit**: `{n}`/`{mesh}` interpolation; unknown token → empty; missing key → en fallback → key;
  `setLocale` switches and falls back to en for absent keys.
- **lookup coverage**: every key referenced by a `t(...)` call exists in `en` (a compile-time-ish test
  enumerating the keys, or a runtime scan).
- **no-leftover-Chinese guard**: scan `feishu-channel.ts` + `card-sender.ts` for `[一-鿿]`,
  asserting none remain EXCEPT the whitelisted input aliases in `parseMeshCommand` (and comments).
- **Feishu command/status snapshots**: drive `handleCommand` for help/status/start/stop/restart/
  new-session (+ already-running / already-stopped) and `authCodeReply` → assert the exact English
  mail-prompt strings.
- **interpolation in situ**: a status reply with a real `{mesh}`/`{status}` renders correctly.

## Uncertainties / decisions for the lead

1. **Category C (agent-facing prompts)**: convert to English (recommended, for consistency — the agent
   reasons in the user's language regardless) or leave as-is (they're not user-visible)? They would be
   plain English instructions, NOT mail-tagged.
2. **Chinese input aliases** in `parseMeshCommand`: KEEP (recommended) — confirm.
3. **Mail-tag taxonomy**: the `[REQ]`/`[FYI]`/`[DONE]` assignment above is my proposal; errors are `[FYI]`
   (no required action) and only auth-required is `[REQ]`. This is the taste-sensitive part — please
   review the table.
4. **Live status lines** (`status: running` / `status: stopped` in start/stop/restart): include
   (matches the seeded example) or keep terser without them?
5. **Emoji**: keep 🔧 in the tool hint (Category B / team3) — their call; notifications carry no emoji.
6. **Bundle granularity**: one flat `en.ts` for all channel keys vs split per concern (`feishu`/`tool`/
   `card`). Proposed: single flat file, namespaced keys.
