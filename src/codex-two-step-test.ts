import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs, stringArg } from "./args";
import { readMailboxEvents, resolveMailboxPath } from "./mailbox";
import { spawnScriptPty } from "./pty-backend";

type StepSpec = {
  stepId: string;
  title: string;
  instruction: string;
  expectedText: string;
};

const { values } = parseArgs();
const cwd = process.cwd();
const agentName = stringArg(values, "agent-name", "CodexPTY");
const taskId = stringArg(values, "task-id", randomUUID());
const mailboxPath = stringArg(values, "mailbox", ".mesh/codex-two-step-mailbox.ndjson");
const rawLogPath = stringArg(values, "raw-log", ".mesh/codex-two-step.raw.log");
const artifactPath = stringArg(values, "artifact", ".mesh/codex-two-step-artifact.md");
const codexCommand = stringArg(
  values,
  "agent",
  `codex --cd "${cwd}" --ask-for-approval never --sandbox workspace-write`,
);

const steps: StepSpec[] = [
  {
    stepId: "step-1",
    title: "Part 1",
    expectedText: "STEP 1 COMPLETE",
    instruction: [
      `Create or replace ${artifactPath}.`,
      "Write exactly these two lines:",
      "Agent Room PTY two-step artifact",
      "STEP 1 COMPLETE: mailbox-driven continuation is ready.",
      "",
      "After writing the file, inspect it yourself and then send a mailbox result event for step-1.",
    ].join("\n"),
  },
  {
    stepId: "step-2",
    title: "Part 2",
    expectedText: "STEP 2 COMPLETE",
    instruction: [
      `Continue from the existing file ${artifactPath}.`,
      "Do not replace the first step content.",
      "Append exactly this line:",
      "STEP 2 COMPLETE: continued in the same PTY session after mailbox completion.",
      "",
      "After appending, inspect the full file and then send a mailbox result event for step-2.",
    ].join("\n"),
  },
];

await mkdir(dirname(resolve(cwd, mailboxPath)), { recursive: true });
await rm(resolve(cwd, mailboxPath), { force: true });
await rm(resolve(cwd, rawLogPath), { force: true });
await rm(resolve(cwd, artifactPath), { force: true });

console.log("Codex PTY two-step test");
console.log(`command: ${codexCommand}`);
console.log(`task id: ${taskId}`);
console.log(`mailbox: ${resolveMailboxPath(mailboxPath)}`);
console.log(`artifact: ${resolve(cwd, artifactPath)}`);
console.log(`raw log: ${resolve(cwd, rawLogPath)}`);
console.log("");

let lastOutputAt = Date.now();
const pty = await spawnScriptPty({
  command: codexCommand,
  cwd,
  rawLogPath,
  env: {
    AGENT_NAME: agentName,
    AGENT_ROOM_TASK_ID: taskId,
    AGENT_ROOM_MAILBOX: mailboxPath,
  },
  onData: (data) => {
    lastOutputAt = Date.now();
    process.stdout.write(data);
  },
});

function buildStepPrompt(step: StepSpec): string {
  return [
    `Agent Room PTY continuation test. You are ${agentName}.`,
    `Task id: ${taskId}. Step id: ${step.stepId}.`,
    "Terminal output is observational only; the mailbox file is the reliable completion channel.",
    step.instruction,
    "",
    "When this step is complete, send exactly one result event by running this command:",
    `bun run src/mailbox-send.ts --mailbox "${mailboxPath}" --from "${agentName}" --task-id "${taskId}:${step.stepId}" --type result --phase "${step.stepId}" --body "Completed ${step.stepId} after updating and inspecting ${artifactPath}."`,
    "Do not send the mailbox result until the file operation and your inspection are complete.",
  ].join("\n");
}

async function waitForTuiReady(): Promise<void> {
  const started = Date.now();
  await Bun.sleep(6000);
  while (Date.now() - lastOutputAt < 800 && Date.now() - started < 15_000) {
    await Bun.sleep(200);
  }
}

async function submitPrompt(prompt: string): Promise<void> {
  // Bracketed paste keeps multi-line work packets intact in terminal UIs.
  pty.write("\x1b");
  await Bun.sleep(250);
  pty.write(`\x1b[200~${prompt}\x1b[201~\r`);
  await Bun.sleep(250);
  pty.write("\r");
}

async function waitForResult(stepId: string, timeoutMs = 180_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const events = await readMailboxEvents(mailboxPath);
    const found = events.find(
      (event) =>
        event.taskId === `${taskId}:${stepId}` &&
        event.type === "result" &&
        event.phase === stepId,
    );
    if (found) {
      console.log(`\nMailbox result received for ${stepId}: ${found.id}`);
      console.log(found.body.trimEnd());
      return;
    }
    await Bun.sleep(1000);
  }
  throw new Error(`Timed out waiting for mailbox result for ${stepId}`);
}

async function inspectArtifact(step: StepSpec): Promise<void> {
  const path = resolve(cwd, artifactPath);
  const info = await stat(path);
  const content = await readFile(path, "utf8");
  if (!content.includes(step.expectedText)) {
    throw new Error(`Artifact missing expected text for ${step.stepId}: ${step.expectedText}`);
  }

  console.log(`\nHost inspection after ${step.stepId}: ${info.size} bytes`);
  console.log(content.trimEnd());
}

for (const step of steps) {
  console.log(`\nSending ${step.stepId} to existing Codex PTY session...`);
  await waitForTuiReady();
  await submitPrompt(buildStepPrompt(step));
  await waitForResult(step.stepId);
  await inspectArtifact(step);
}

console.log("\nBoth steps completed through the same Codex PTY session.");
pty.kill();

const exitCode = await pty.exited;
console.log(`PTY exited with code=${exitCode}`);
