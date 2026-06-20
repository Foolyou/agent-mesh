// src/channels/i18n/en.ts — the default (and currently only) channel copy bundle (design:
// docs/design/channel-i18n-prompts.md). Single flat file; keys are namespaced by surface
// (`feishu.*` / `card.*`). Generated notifications follow the mail-prompt style aligned with mesh
// send_mail: `[REQ]` = operator/user action required, `[FYI]` = informational/error (no action),
// `[DONE]` = a requested action completed. Mirrored user/agent conversation content is never in here.
//
// Tool-annotation copy (Category B) is NOT here — it is team3-owned (`feishu-tool-display`'s
// `toolDisplayStrings` / `toolDisplayCopy()` in feishu-channel.ts). This bundle never duplicates it.

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

  // ── C. channel→agent injected prompt frames — [REQ] mail-format (the agent is asked to reply). The
  //    `{text}` value is the mirrored user message (Category D) and is interpolated, never rewritten. ──
  "feishu.prompt.group": [
    "[REQ] Feishu message",
    "source: feishu",
    "chat_type: group",
    "instructions: Reply to the user directly. Your reply is sent verbatim to this Feishu group, unless the user explicitly asks you not to reply.",
    "user_message: {text}",
  ].join("\n"),
  "feishu.prompt.p2p": [
    "[REQ] Feishu message",
    "source: feishu",
    "chat_type: private",
    "role: Mesh Assistant",
    "instructions: Reply to the user directly. Your reply is sent verbatim to this Feishu private chat.",
    "user_message: {text}",
  ].join("\n"),
  "feishu.prompt.image": "[the user sent an image]", // the {text} payload of an image-only turn
} satisfies Record<string, string>;
