// Smoke: AcpAgentConnection against a real harness.
// Usage: bun run src/acp/client.smoke.ts [codex|opencode|claude]
import { resolve } from "node:path";
import { AcpAgentConnection } from "./client";
import { resolveHarness } from "../harness";
import type { HarnessId } from "./types";

const id = (process.argv[2] ?? "codex") as HarnessId;
const spec = resolveHarness(id);
// codex defaults to xhigh reasoning (slow); drop to low for the smoke.
const args = id === "codex" ? [...spec.args, "-c", "model_reasoning_effort=low"] : spec.args;
const cwd = resolve(process.cwd(), "test_mesh_0");

let sawMessage = false;
const conn = new AcpAgentConnection({
  id,
  command: spec.command,
  args,
  cwd,
  onUpdate: (u) => {
    if (u?.sessionUpdate === "agent_message_chunk" && u?.content?.text) {
      sawMessage = true;
      process.stdout.write(u.content.text);
    }
  },
});

const timeout = setTimeout(() => {
  console.error("\n[smoke] TIMEOUT");
  conn.kill();
  process.exit(1);
}, 120_000);

try {
  await conn.start();
  await conn.initialize();
  await conn.newSession([]);
  console.log(`[smoke] ${id} session ready; prompting...`);
  const res = await conn.prompt("Reply with one short sentence confirming you are running. No tools.");
  console.log(`\n[smoke] stopReason=${(res as any).stopReason} sawMessage=${sawMessage}`);
  clearTimeout(timeout);
  conn.kill();
  process.exit(sawMessage ? 0 : 1);
} catch (err) {
  console.error("[smoke] error", err);
  clearTimeout(timeout);
  conn.kill();
  process.exit(1);
}
