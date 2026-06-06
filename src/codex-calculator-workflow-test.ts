import { appendFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs, stringArg } from "./args";
import { readMailboxEvents, resolveMailboxPath } from "./mailbox";
import { spawnScriptPty } from "./pty-backend";

type WorkflowStep = {
  stepId: string;
  title: string;
  instruction: string;
  verify: () => Promise<void>;
};

const { values } = parseArgs();
const cwd = process.cwd();
const agentName = stringArg(values, "agent-name", "CodexCalculator");
const taskId = stringArg(values, "task-id", randomUUID());
const mailboxPath = stringArg(values, "mailbox", ".mesh/codex-calculator-workflow-mailbox.ndjson");
const rawLogPath = stringArg(values, "raw-log", ".mesh/codex-calculator-workflow.raw.log");
const promptLogPath = stringArg(values, "prompt-log", ".mesh/codex-calculator-workflow-prompts.ndjson");
const appDir = stringArg(values, "app-dir", ".mesh/calculator-workflow");
const codexCommand = stringArg(
  values,
  "agent",
  `codex --cd "${cwd}" --ask-for-approval never --sandbox workspace-write`,
);

const appRoot = resolve(cwd, appDir);

async function readAppFile(path: string): Promise<string> {
  return readFile(resolve(appRoot, path), "utf8");
}

async function requireFile(path: string): Promise<string> {
  const fullPath = resolve(appRoot, path);
  await stat(fullPath);
  return readFile(fullPath, "utf8");
}

function assertIncludes(content: string, needle: string, label: string): void {
  if (!content.includes(needle)) {
    throw new Error(`${label} missing required text: ${needle}`);
  }
}

function assertClose(actual: number, expected: number, label: string): void {
  if (Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${label} expected ${expected}, got ${actual}`);
  }
}

async function importCore(): Promise<Record<string, unknown>> {
  const url = pathToFileURL(resolve(appRoot, "calculator-core.mjs"));
  url.searchParams.set("cacheBust", `${Date.now()}`);
  return import(url.href);
}

const steps: WorkflowStep[] = [
  {
    stepId: "calculator",
    title: "Build Calculator",
    instruction: [
      `Build a static browser calculator app in ${appDir}.`,
      "",
      "Create these files:",
      "- index.html",
      "- styles.css",
      "- app.js",
      "- calculator-core.mjs",
      "- README.md",
      "",
      "Functional requirements:",
      "- The page title or main heading must contain: Agent Room Calculator",
      "- The calculator must support digits, decimal input, clear, backspace, equals, +, -, *, /, and parentheses.",
      "- Keyboard input should work for digits/operators/Enter/Escape/Backspace.",
      "- calculator-core.mjs must export function calculateExpression(expression).",
      "- calculateExpression must support expressions like 7 + 5 * 2 and (12.5 - 2.5) / 2.",
      "- Do not use eval or Function.",
      "- Include this marker string somewhere in app source or README: AGENT_ROOM_STEP_CALCULATOR_CORE_COMPLETE",
      "",
      "After implementation, inspect the created files and run a small self-check of calculateExpression.",
    ].join("\n"),
    verify: async () => {
      const html = await requireFile("index.html");
      const css = await requireFile("styles.css");
      const app = await requireFile("app.js");
      const coreText = await requireFile("calculator-core.mjs");
      const readme = await requireFile("README.md");

      assertIncludes(`${html}\n${readme}`, "Agent Room Calculator", "calculator app");
      assertIncludes(`${html}\n${app}\n${coreText}\n${readme}`, "AGENT_ROOM_STEP_CALCULATOR_CORE_COMPLETE", "calculator marker");
      assertIncludes(coreText, "calculateExpression", "calculator-core.mjs");
      assertIncludes(`${html}\n${css}\n${app}`, "Backspace", "calculator UI");

      const core = await importCore();
      const calculateExpression = core.calculateExpression;
      if (typeof calculateExpression !== "function") {
        throw new Error("calculator-core.mjs must export calculateExpression");
      }
      assertClose(Number(calculateExpression("7 + 5 * 2")), 17, "calculateExpression precedence");
      assertClose(Number(calculateExpression("(12.5 - 2.5) / 2")), 5, "calculateExpression parentheses");
    },
  },
  {
    stepId: "dark-mode",
    title: "Add Dark Mode",
    instruction: [
      `Continue the existing calculator app in ${appDir}.`,
      "",
      "Add dark mode without removing the calculator behavior.",
      "",
      "Requirements:",
      "- Add a visible theme toggle button with id theme-toggle.",
      "- Use CSS variables or equivalent theme styles for light and dark themes.",
      "- Persist the user's theme in localStorage key agent-room-calculator-theme.",
      "- Apply the theme on page load.",
      "- Include this marker string somewhere in app source or README: AGENT_ROOM_STEP_DARK_MODE_COMPLETE",
      "",
      "After implementation, inspect index.html, styles.css, app.js, and ensure calculateExpression still works.",
    ].join("\n"),
    verify: async () => {
      const html = await requireFile("index.html");
      const css = await requireFile("styles.css");
      const app = await requireFile("app.js");
      const all = `${html}\n${css}\n${app}`;

      assertIncludes(all, "theme-toggle", "dark mode toggle");
      assertIncludes(all, "agent-room-calculator-theme", "theme persistence");
      assertIncludes(all, "AGENT_ROOM_STEP_DARK_MODE_COMPLETE", "dark mode marker");
      assertIncludes(css.toLowerCase(), "dark", "dark theme CSS");

      const core = await importCore();
      const calculateExpression = core.calculateExpression;
      if (typeof calculateExpression !== "function") {
        throw new Error("calculateExpression disappeared after dark mode step");
      }
      assertClose(Number(calculateExpression("8 / 2 + 3")), 7, "calculateExpression after dark mode");
    },
  },
  {
    stepId: "unit-conversion",
    title: "Add Unit Conversion",
    instruction: [
      `Continue the existing calculator app in ${appDir}.`,
      "",
      "Add a unit conversion panel while preserving calculator and dark mode behavior.",
      "",
      "Requirements:",
      "- Add a converter panel with ids unit-input, unit-from, unit-to, unit-output.",
      "- calculator-core.mjs must export function convertUnit(value, fromUnit, toUnit).",
      "- convertUnit must support these unit keys exactly: m, km, ft, mi, kg, lb, c, f.",
      "- It must correctly convert 1 km to 1000 m and 0 c to 32 f.",
      "- Update the UI to call convertUnit when conversion inputs change.",
      "- Keep the theme toggle and localStorage key from the dark mode step.",
      "- Include this marker string somewhere in app source or README: AGENT_ROOM_STEP_UNIT_CONVERTER_COMPLETE",
      "",
      "After implementation, inspect the full app and run small self-checks for calculateExpression and convertUnit.",
    ].join("\n"),
    verify: async () => {
      const html = await requireFile("index.html");
      const css = await requireFile("styles.css");
      const app = await requireFile("app.js");
      const coreText = await requireFile("calculator-core.mjs");
      const all = `${html}\n${css}\n${app}\n${coreText}`;

      for (const id of ["unit-input", "unit-from", "unit-to", "unit-output"]) {
        assertIncludes(all, id, `unit converter ${id}`);
      }
      assertIncludes(all, "theme-toggle", "dark mode preserved");
      assertIncludes(all, "agent-room-calculator-theme", "theme persistence preserved");
      assertIncludes(all, "AGENT_ROOM_STEP_UNIT_CONVERTER_COMPLETE", "unit converter marker");
      assertIncludes(coreText, "convertUnit", "calculator-core.mjs");

      const core = await importCore();
      const calculateExpression = core.calculateExpression;
      const convertUnit = core.convertUnit;
      if (typeof calculateExpression !== "function") {
        throw new Error("calculateExpression disappeared after unit conversion step");
      }
      if (typeof convertUnit !== "function") {
        throw new Error("calculator-core.mjs must export convertUnit");
      }
      assertClose(Number(calculateExpression("2 * (3 + 4)")), 14, "calculateExpression after unit conversion");
      assertClose(Number(convertUnit(1, "km", "m")), 1000, "convertUnit km to m");
      assertClose(Number(convertUnit(0, "c", "f")), 32, "convertUnit c to f");
    },
  },
];

await mkdir(dirname(resolve(cwd, mailboxPath)), { recursive: true });
await rm(resolve(cwd, mailboxPath), { force: true });
await rm(resolve(cwd, rawLogPath), { force: true });
await rm(resolve(cwd, promptLogPath), { force: true });
await rm(appRoot, { recursive: true, force: true });
await mkdir(appRoot, { recursive: true });

console.log("Codex PTY calculator workflow test");
console.log(`command: ${codexCommand}`);
console.log(`task id: ${taskId}`);
console.log(`mailbox: ${resolveMailboxPath(mailboxPath)}`);
console.log(`app dir: ${appRoot}`);
console.log(`raw log: ${resolve(cwd, rawLogPath)}`);
console.log(`prompt log: ${resolve(cwd, promptLogPath)}`);
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

function buildStepPrompt(step: WorkflowStep): string {
  return [
    `Agent Room PTY gated workflow. You are ${agentName}.`,
    `Task id: ${taskId}. Step id: ${step.stepId}.`,
    "Terminal output is observational only; the mailbox file is the reliable completion channel.",
    "You are only receiving the current stage. Do not assume or ask for future stages.",
    "Work in the existing repo, but write this workflow's product artifacts only under the requested .mesh app directory.",
    "",
    step.instruction,
    "",
    "When this step is complete, send exactly one result event by running this command:",
    `bun run src/mailbox-send.ts --mailbox "${mailboxPath}" --from "${agentName}" --task-id "${taskId}:${step.stepId}" --type result --phase "${step.stepId}" --body "Completed ${step.stepId} after updating and inspecting ${appDir}."`,
    "Do not send the mailbox result until the file operation and your inspection/self-check are complete.",
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

async function logPrompt(step: WorkflowStep, prompt: string): Promise<void> {
  const record = {
    ts: new Date().toISOString(),
    taskId,
    stepId: step.stepId,
    title: step.title,
    prompt,
  };
  await appendFile(resolve(cwd, promptLogPath), `${JSON.stringify(record)}\n`, "utf8");
}

async function waitForResult(stepId: string, timeoutMs = 300_000): Promise<void> {
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

try {
  for (const step of steps) {
    console.log(`\nSending ${step.stepId} (${step.title}) to existing Codex PTY session...`);
    await waitForTuiReady();
    const prompt = buildStepPrompt(step);
    await logPrompt(step, prompt);
    await submitPrompt(prompt);
    await waitForResult(step.stepId);
    await step.verify();
    console.log(`Host verification passed for ${step.stepId}.`);
  }

  console.log("\nCalculator workflow completed through the same Codex PTY session.");
} finally {
  pty.kill();
}

const exitCode = await pty.exited;
console.log(`PTY exited with code=${exitCode}`);
