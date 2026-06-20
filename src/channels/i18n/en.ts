// src/channels/i18n/en.ts — the default (and currently only) channel copy bundle (design:
// docs/design/channel-i18n-prompts.md). Single flat file; keys are namespaced by surface
// (`feishu.*` / `card.*` / `tool.*`). Generated notifications follow the mail-prompt style aligned with
// mesh send_mail: `[REQ]` = operator/user action required, `[FYI]` = informational/error (no action),
// `[DONE]` = a requested action completed. Mirrored user/agent conversation content is never in here.
//
// NOTE: call sites are migrated in C2 (feishu) / C3 (card + agent prompts). The `tool.*` entries are
// TEMPORARY placeholders — team3's `feishu-tool-display` (`toolDisplayStrings`) is the canonical home for
// tool-annotation copy; C3 folds these into it (or references it) so there is no permanent duplication.

export const en = {
  // ── A. Feishu command replies (mail-prompt; status lines included per approved decision) ──
  "feishu.cmd.status": "[FYI] Mesh status\nmesh: {mesh}\nstatus: {status}",
  "feishu.cmd.startAlready": "[FYI] Mesh already running\nmesh: {mesh}",
  "feishu.cmd.startDone": "[DONE] Mesh started\nmesh: {mesh}\nstatus: running",
  "feishu.cmd.stopAlready": "[FYI] Mesh already stopped\nmesh: {mesh}",
  "feishu.cmd.stopDone": "[DONE] Mesh stopped\nmesh: {mesh}\nstatus: stopped",
  "feishu.cmd.restartDone": "[DONE] Mesh restarted\nmesh: {mesh}\nstatus: running",
  "feishu.cmd.newSessionRunning": "[DONE] New sessions started\nmesh: {mesh}",
  "feishu.cmd.newSessionStopped": "[DONE] Sessions cleared\nmesh: {mesh}\nnote: next start uses fresh sessions",
  "feishu.cmd.failed": "[FYI] Command failed\nerror: {error}",
  "feishu.cmd.help": [
    "[FYI] Commands for mesh {mesh}",
    "/mesh status — show status",
    "/mesh start — start the bound mesh",
    "/mesh stop — stop the bound mesh",
    "/mesh restart — restart the bound mesh",
    "/mesh new-session — new session for all agents",
  ].join("\n"),

  // ── A. Feishu lifecycle / delivery / image / assistant notices ──
  "feishu.mesh.autostartFailed": "[FYI] Mesh auto-start failed\nmesh: {mesh}\nerror: {error}",
  "feishu.deliver.failed": "[FYI] Message received, delivery failed\nmesh: {mesh}\nerror: {error}",
  "feishu.image.disabled": "[FYI] Image received, image handling is disabled",
  "feishu.image.unprocessable": "[FYI] Image received, could not be processed",
  "feishu.image.downloadFailed": "[FYI] Image received, download failed",
  "feishu.assistant.disabled": "[FYI] Assistant is not enabled",
  "feishu.assistant.busy": "[FYI] Assistant is busy\nnote: try again shortly",
  "feishu.assistant.failed": "[FYI] Message received, the assistant failed\nnote: try again shortly",
  "feishu.auth.failed": "[FYI] Authorization failed\nnote: try again or contact an operator",

  // ── A. Authorization enrollment (the only [REQ] — the user must get an operator to approve) ──
  "feishu.auth.required":
    "[REQ] Authorization required\ncode: {code}\naction: ask an operator to run `mesh channels feishu approve {code}`",

  // ── card surface ──
  "card.fallbackTitle": "Agent reply",

  // ── C. Agent-facing prompt scaffolding (migrated in C3; plain English instruction, NOT mail-tagged) ──
  "feishu.prompt.group":
    "An authorized user message from a Feishu group chat. Reply to the user directly; your reply is sent back to that Feishu group verbatim, unless the user explicitly asks you not to reply.\n\nUser message: {text}",
  "feishu.prompt.p2p":
    "An authorized user message from a Feishu private chat. You are the Mesh Assistant; reply to the user directly; your reply is sent back verbatim.\n\nUser message: {text}",
  "feishu.prompt.image": "The user sent an image.",

  // ── B. Tool annotation — TEMPORARY placeholders pending team3's toolDisplayStrings (emoji team3-owned) ──
  "tool.hint": "🔧 Calling tool",
  "tool.hintNamed": "🔧 Calling tool: {toolName}",
} satisfies Record<string, string>;
