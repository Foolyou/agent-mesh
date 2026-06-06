// Task 6 smoke (point 3): codex-1 send_mail -> opencode-1, recipient is woken.
import { ControlPlane } from "../control-plane";
import { DEMO_MESH } from "../config";

const cp = new ControlPlane(DEMO_MESH);
let mailSeen = false;
let recipientActivity = false;

cp.on((e) => {
  if (e.kind === "mail" && e.from === "codex-1" && e.to === "opencode-1") {
    mailSeen = true;
    console.log(`[mail] codex-1 -> opencode-1: ${e.body}`);
  }
  if (
    mailSeen &&
    e.kind === "update" &&
    e.agent === "opencode-1" &&
    ["agent_message_chunk", "agent_thought_chunk"].includes((e.update as any)?.sessionUpdate)
  ) {
    recipientActivity = true;
  }
});

const fail = (msg: string) => {
  console.error(`[mail-smoke] FAIL: ${msg}`);
  cp.stop();
  process.exit(1);
};
const timeout = setTimeout(() => fail("overall timeout"), 150_000);

await cp.start();
await cp.prompt(
  "codex-1",
  "Use the send_mail tool to send the message 'ping from codex' to the agent whose id is 'opencode-1'. After the tool returns, stop.",
);

const deadline = Date.now() + 60_000;
while (!recipientActivity && Date.now() < deadline) await Bun.sleep(500);

clearTimeout(timeout);
console.log(`[mail-smoke] mailSeen=${mailSeen} recipientActivity=${recipientActivity}`);
await cp.stop();
process.exit(mailSeen && recipientActivity ? 0 : 1);
