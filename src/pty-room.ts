import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { booleanArg, parseArgs, stringArg } from "./args";
import { defaultMailboxPath, readMailboxEvents, resolveMailboxPath } from "./mailbox";
import { spawnScriptPty } from "./pty-backend";
import { buildWorkPacket } from "./work-packet";

const { values } = parseArgs();

const agentCommand = stringArg(values, "agent", "bun run src/mock-agent.ts");
const agentName = stringArg(values, "agent-name", "MockAgent");
const role = stringArg(values, "role", "Prototype Agent");
const task = stringArg(values, "task", "Report staged progress through the Agent Room mailbox.");
const taskId = stringArg(values, "task-id", randomUUID());
const mailboxPath = stringArg(values, "mailbox", defaultMailboxPath());
const rawLogPath = stringArg(values, "raw-log", ".mesh/pty.raw.log");
const autoExit = booleanArg(values, "auto-exit");
const cwd = process.cwd();

await mkdir(dirname(resolve(cwd, rawLogPath)), { recursive: true });
await mkdir(dirname(resolveMailboxPath(mailboxPath)), { recursive: true });

console.log(`Agent Room PTY prototype`);
console.log(`agent: ${agentName} (${role})`);
console.log(`command: ${agentCommand}`);
console.log(`task id: ${taskId}`);
console.log(`mailbox: ${resolveMailboxPath(mailboxPath)}`);
console.log(`raw log: ${resolve(cwd, rawLogPath)}`);
console.log(`pty backend: script -qfec`);
console.log("");

const pty = await spawnScriptPty({
  command: agentCommand,
  cwd,
  env: {
    AGENT_NAME: agentName,
    AGENT_ROOM_TASK_ID: taskId,
    AGENT_ROOM_MAILBOX: mailboxPath,
  },
  rawLogPath,
  onData: (data) => {
    process.stdout.write(data);
  },
});

let closed = false;

function writeToPty(data: string | Uint8Array): void {
  pty.write(data);
}

pty.exited.then((exitCode) => {
  closed = true;
  console.log(`\nPTY exited with code=${exitCode}`);
  process.exit(exitCode);
});

const workPacket = buildWorkPacket({
  agentName,
  role,
  taskId,
  task,
  mailboxPath,
});

setTimeout(() => {
  try {
    writeToPty(`${workPacket}\n`);
  } catch (error) {
    console.error(error);
  }
}, 350);

if (process.stdin.isTTY && !autoExit) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (data) => {
    if (data.length === 1 && data[0] === 3) {
      pty.kill();
      return;
    }
    try {
      writeToPty(data);
    } catch (error) {
      console.error(error);
    }
  });
}

if (autoExit) {
  const timer = setInterval(async () => {
    if (closed) {
      clearInterval(timer);
      return;
    }

    const events = await readMailboxEvents(mailboxPath);
    const finished = events.some((event) => event.taskId === taskId && event.type === "result");
    if (!finished) {
      return;
    }

    clearInterval(timer);
    console.log("\nDetected mailbox result event; stopping PTY session.");
    pty.kill();
  }, 250);
}
