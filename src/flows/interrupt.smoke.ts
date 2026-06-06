// Task 8 smoke (point 5): the Router interrupts a member; control plane issues
// session/cancel and the member's in-flight turn settles.
import { ControlPlane } from "../control-plane";
import { DEMO_MESH } from "../config";

const cp = new ControlPlane(DEMO_MESH);
let codexStreaming = false;
let interruptSeen = false;
let interruptAt = 0;
let codexSettled = false;
let codexStop = "";
let settledAt = 0;

cp.on((e) => {
  if (e.kind === "update" && e.agent === "codex-1") {
    const k = (e.update as any)?.sessionUpdate;
    if (k === "agent_message_chunk" || k === "agent_thought_chunk" || k === "tool_call") codexStreaming = true;
  }
  if (e.kind === "update" && e.agent === "router") {
    const k = (e.update as any)?.sessionUpdate;
    if (k === "tool_call" || k === "tool_call_update") console.log(`[router tool] ${JSON.stringify(e.update).slice(0, 220)}`);
    if (k === "agent_message_chunk") process.stdout.write(String((e.update as any)?.content?.text ?? ""));
  }
  if (e.kind === "interrupt" && e.target === "codex-1") {
    interruptSeen = true;
    interruptAt = Date.now();
    console.log(`[interrupt] router -> codex-1 (${e.reason ?? ""})`);
  }
});

const timeout = setTimeout(() => {
  console.error("[interrupt-smoke] overall timeout");
  cp.stop();
  process.exit(1);
}, 180_000);

await cp.start();

// Long task on codex-1; do NOT await.
const codexPromise = cp
  .prompt(
    "codex-1",
    "Run the shell command `sleep 40` and wait for it to complete. Do not do anything else until it finishes; then say 'slept'.",
  )
  .then((r) => {
    codexSettled = true;
    settledAt = Date.now();
    codexStop = (r as any).stopReason ?? "?";
  })
  .catch((err) => {
    codexSettled = true;
    settledAt = Date.now();
    codexStop = "error:" + String(err);
  });

// Wait until codex is actively producing output.
const streamDeadline = Date.now() + 60_000;
while (!codexStreaming && Date.now() < streamDeadline) await Bun.sleep(300);
console.log(`[interrupt-smoke] codex streaming=${codexStreaming}; driving router to interrupt...`);

// Drive the router (claude) to call the interrupt tool.
await cp
  .prompt(
    "router",
    "Use the interrupt tool now to interrupt the agent with id 'codex-1'. Pass target='codex-1' and reason='stop'. Call the tool immediately.",
  )
  .catch((e) => console.error("[interrupt-smoke] router prompt error", String(e)));

// Wait for codex's in-flight turn to settle after the interrupt.
const settleDeadline = Date.now() + 30_000;
while (!codexSettled && Date.now() < settleDeadline) await Bun.sleep(300);
await codexPromise.catch(() => {});

clearTimeout(timeout);
const settledAfterInterrupt = interruptSeen && codexSettled && settledAt >= interruptAt;
console.log(
  `[interrupt-smoke] interruptSeen=${interruptSeen} codexSettled=${codexSettled} stopReason=${codexStop} settledAfterInterrupt=${settledAfterInterrupt}`,
);
await cp.stop();
process.exit(interruptSeen && codexSettled ? 0 : 1);
