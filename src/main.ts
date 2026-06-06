// Entrypoint: boot the hardwired demo mesh and render the read-only TUI.
// Press 'd' to run a live demo (mail + a permission probe you approve by key),
// Tab to switch agent, 1-9 to decide a pending permission, q to quit.
import { ControlPlane } from "./control-plane";
import { DEMO_MESH } from "./config";
import { Tui } from "./tui/app";

const cp = new ControlPlane(DEMO_MESH);

let demoRunning = false;
async function runDemo() {
  if (demoRunning) return;
  demoRunning = true;
  try {
    // 1) inter-agent mail
    await cp.prompt(
      "codex-1",
      "Use the send_mail tool to send 'hello from codex' to the agent 'opencode-1', then stop.",
    ).catch(() => {});
    // 2) a permission probe: codex goes read-only, then asks to write -> the
    //    request surfaces in the TUI for the human to approve with a number key.
    await cp.agent("codex-1").setMode("read-only").catch(() => {});
    cp.prompt(
      "codex-1",
      "You are in read-only mode. Create a file named demo.txt containing 'hi'. Request approval to do so, and once approved, create it.",
    ).catch(() => {});
  } finally {
    demoRunning = false;
  }
}

const tui = new Tui(cp, runDemo);
tui.start();

process.on("SIGINT", () => {
  tui.stop();
  cp.stop().finally(() => process.exit(0));
});

await cp.start();
