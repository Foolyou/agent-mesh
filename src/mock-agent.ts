import { sendMailboxEvent } from "./mailbox";

const agentName = process.env.AGENT_NAME || "MockAgent";
const taskId = process.env.AGENT_ROOM_TASK_ID || "default";
const mailboxPath = process.env.AGENT_ROOM_MAILBOX || ".mesh/mailbox.ndjson";

let buffer = "";
let running = false;

function prompt(): void {
  process.stdout.write("\nmock-agent> ");
}

async function handleWorkPacket(packet: string): Promise<void> {
  if (running) {
    process.stdout.write("\nAlready working; queued input is ignored in this mock.\n");
    return;
  }

  running = true;
  process.stdout.write("\nReceived Agent Room work packet through PTY.\n");

  await sendMailboxEvent({
    mailboxPath,
    from: agentName,
    taskId,
    type: "stage",
    phase: "planning",
    body: "I received the PTY work packet and will report progress through the mailbox file.",
  });

  await Bun.sleep(250);
  process.stdout.write("Planning complete. Writing mailbox progress instead of relying on terminal output.\n");

  await sendMailboxEvent({
    mailboxPath,
    from: agentName,
    taskId,
    type: "stage",
    phase: "working",
    body: [
      "Prototype behavior check:",
      "- PTY input delivery works.",
      "- Agent can emit structured events to mailbox.",
      "- Runner can stop based on mailbox result instead of fragile terminal parsing.",
    ].join("\n"),
  });

  await Bun.sleep(250);

  await sendMailboxEvent({
    mailboxPath,
    from: agentName,
    taskId,
    type: "result",
    phase: "final",
    body: [
      "Mock agent completed the task.",
      "",
      "Result:",
      "The mailbox file can act as the reliable async output channel while the PTY remains the interactive runtime body.",
    ].join("\n"),
  });

  process.stdout.write("Final result written to mailbox.\n");
  running = false;
  prompt();
}

process.stdout.write("Mock Agent CLI started in PTY mode.");
prompt();

process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  buffer += chunk;

  const endMarker = "<<<AGENT_ROOM_WORK_PACKET_END>>>";
  if (!buffer.includes(endMarker)) {
    return;
  }

  const packet = buffer.slice(0, buffer.indexOf(endMarker) + endMarker.length);
  buffer = buffer.slice(buffer.indexOf(endMarker) + endMarker.length);
  handleWorkPacket(packet).catch((error) => {
    console.error(error);
  });
});

setInterval(() => {}, 1 << 30);
