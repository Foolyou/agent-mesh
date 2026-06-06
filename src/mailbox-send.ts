import { parseArgs, stringArg } from "./args";
import { sendMailboxEvent, type MailboxEventType } from "./mailbox";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

const { values } = parseArgs();
const bodyFromArg = values.body;
const body =
  typeof bodyFromArg === "string" && bodyFromArg.length > 0
    ? bodyFromArg
    : await readStdin();

const event = await sendMailboxEvent({
  mailboxPath: stringArg(values, "mailbox", process.env.AGENT_ROOM_MAILBOX || ".mesh/mailbox.ndjson"),
  from: stringArg(values, "from", process.env.AGENT_NAME || "unknown-agent"),
  taskId: stringArg(values, "task-id", process.env.AGENT_ROOM_TASK_ID || "default"),
  type: stringArg(values, "type", "stage") as MailboxEventType,
  phase: stringArg(values, "phase", ""),
  body,
});

console.log(`mailbox event sent: ${event.type}/${event.phase || "none"} ${event.id}`);
