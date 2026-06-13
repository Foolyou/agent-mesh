// Real-codex self-awareness e2e. Exercises usage parsing, advertised commands,
// auto-compact thresholding, bare "/compact", and post-compact session usability.
//
// Run:
//   bun run src/web/mesh-self-awareness.e2e.ts
//
// Slow and API-backed. Set MESH_E2E_SKIP_REAL_CODEX=1 to skip in environments
// without a logged-in/usable Codex ACP installation.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane, type ContextUsage } from "../control-plane";
import type { MeshConfig, MeshEvent } from "../acp/types";

const AGENT = "codex-1";
const THRESHOLD = process.env.MESH_E2E_COMPACT_THRESHOLD ?? "70%";
const MAX_FILL_TURNS = Number(process.env.MESH_E2E_COMPACT_FILL_TURNS ?? "8");
const FILL_KB = Number(process.env.MESH_E2E_COMPACT_FILL_KB ?? "96");
const READY_TIMEOUT_MS = Number(process.env.MESH_E2E_READY_TIMEOUT_MS ?? "120000");
const COMPACT_TIMEOUT_MS = Number(process.env.MESH_E2E_COMPACT_TIMEOUT_MS ?? "180000");

type CompactOutcome = Extract<MeshEvent, { kind: "compact_completed" | "compact_failed" }>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function skip(message: string): never {
  console.log(`  SKIP ${message}`);
  process.exit(0);
}

async function waitFor<T>(probe: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs: number, label: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: T | undefined | false;
  while (Date.now() < end) {
    last = await probe();
    if (last) return last;
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (last=${String(last)})` : ""}`);
}

function makeFillPrompt(turn: number): string {
  const line = [
    `// auto-compact e2e turn ${turn}`,
    "export function sample(input: string): string {",
    "  return input.split('').reverse().join('');",
    "}",
    "The preceding code is repeated only to grow the session context.",
  ].join("\n");
  const target = Math.max(1, FILL_KB) * 1024;
  const repeated = line.repeat(Math.ceil(target / line.length)).slice(0, target);
  return [
    "Read the following payload without using tools. Reply with exactly: ACK",
    "```ts",
    repeated,
    "```",
  ].join("\n");
}

function formatUsage(u: ContextUsage | null): string {
  if (!u) return "null";
  return `${u.used}/${u.size} (${(u.percent * 100).toFixed(2)}%)`;
}

if (process.env.MESH_E2E_SKIP_REAL_CODEX === "1") {
  skip("MESH_E2E_SKIP_REAL_CODEX=1");
}
if (!Bun.which("codex-acp")) {
  skip("codex-acp not found on PATH");
}

const root = await mkdtemp(join(tmpdir(), "mesh-self-awareness-"));
const project = join(root, "project");
await mkdir(project, { recursive: true });
await writeFile(join(project, "README.md"), "# mesh self-awareness e2e\n");

const config: MeshConfig = {
  name: "self-awareness-e2e",
  autoCompact: { enabled: true, threshold: THRESHOLD },
  agents: [{ id: AGENT, harness: "codex", role: "router", project, effort: "low" }],
  edges: [],
};

const cp = new ControlPlane(config, {
  mailboxPath: join(root, "mailbox.ndjson"),
  sessionRunDir: join(root, ".agent-mesh"),
  artifactsRoot: join(root, "artifacts"),
  turnFirstSignalTimeoutMs: 0,
});

const events: MeshEvent[] = [];
let latestUsage: ContextUsage | null = null;
let compactStarted: Extract<MeshEvent, { kind: "compact_started" }> | undefined;
let compactOutcome: CompactOutcome | undefined;
let postCompactResponse = "";

cp.on((event) => {
  events.push(event);
  if (event.kind === "compact_started" && event.agent === AGENT) compactStarted = event;
  if ((event.kind === "compact_completed" || event.kind === "compact_failed") && event.agent === AGENT) compactOutcome = event;
  if (event.kind === "update" && event.agent === AGENT) {
    latestUsage = cp.getAgentContextUsage(AGENT);
    const update = event.update as any;
    if (update?.sessionUpdate === "agent_message_chunk" && typeof update.content?.text === "string") {
      postCompactResponse += update.content.text;
    }
  }
});

const startedAt = Date.now();
const report: Record<string, unknown> = { threshold: THRESHOLD, fillKb: FILL_KB, maxFillTurns: MAX_FILL_TURNS };

try {
  await cp.start();
  await waitFor(() => events.some((e) => e.kind === "agent_status" && e.agent === AGENT && e.status === "ready"), READY_TIMEOUT_MS, "codex ready");
  await waitFor(() => cp.getAgentAdvertisedCommands(AGENT).has("compact"), READY_TIMEOUT_MS, "codex advertised compact command");
  report.advertisedCommands = [...cp.getAgentAdvertisedCommands(AGENT)].sort();

  for (let i = 1; i <= MAX_FILL_TURNS && !compactStarted; i += 1) {
    await cp.prompt(AGENT, makeFillPrompt(i));
    latestUsage = cp.getAgentContextUsage(AGENT);
    console.log(`  fill turn ${i}: usage=${formatUsage(latestUsage)}`);
    await Bun.sleep(1000);
  }

  compactStarted = await waitFor(() => compactStarted, COMPACT_TIMEOUT_MS, "compact_started");
  assert(compactStarted.reason === "auto-threshold", `unexpected compact reason: ${compactStarted.reason}`);
  const beforeCompact = latestUsage ?? cp.getAgentContextUsage(AGENT);
  assert(beforeCompact, "missing context usage before compact");
  report.beforeCompact = beforeCompact;

  compactOutcome = await waitFor(() => compactOutcome, COMPACT_TIMEOUT_MS, "compact_completed or compact_failed");
  assert(compactOutcome.kind === "compact_completed", `compact did not complete: ${JSON.stringify(compactOutcome)}`);

  const afterCompact = await waitFor(() => {
    const usage = cp.getAgentContextUsage(AGENT);
    if (!usage) return false;
    return usage.percent < beforeCompact.percent ? usage : false;
  }, COMPACT_TIMEOUT_MS, "context usage decrease after compact");
  report.afterCompact = afterCompact;
  assert(afterCompact.percent <= beforeCompact.percent * 0.8, `context usage did not drop enough: before=${formatUsage(beforeCompact)} after=${formatUsage(afterCompact)}`);

  postCompactResponse = "";
  await cp.prompt(AGENT, "Reply with exactly SELF_AWARENESS_OK.");
  await waitFor(() => /SELF_AWARENESS_OK/i.test(postCompactResponse), 60_000, "post-compact response");
  report.postCompactResponse = postCompactResponse.trim().slice(0, 120);

  console.log("\n  ✓ auto compact started with reason=auto-threshold");
  console.log(`  ✓ usage before compact: ${formatUsage(beforeCompact)}`);
  console.log(`  ✓ usage after compact:  ${formatUsage(afterCompact)}`);
  console.log("  ✓ post-compact prompt received SELF_AWARENESS_OK");
  console.log(`\n  MESH SELF-AWARENESS E2E OK in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  console.log(`  Scenario A data: ${JSON.stringify(report)}`);
} finally {
  await cp.stop().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
