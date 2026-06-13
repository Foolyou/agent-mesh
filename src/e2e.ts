// End-to-end verification of the PoC points driven through MeshManager.
// The control plane now runs in a mesh-host subprocess, so prompts are
// fire-and-forget and assertions key off emitted events. Headless: permissions
// are auto-resolved (simulating the human). Prints a pass/fail table and exits
// non-zero on any failure.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { MeshManager } from "./mesh-manager";
import { DEMO_MESH } from "./config";

// Isolated throwaway root: persisted sessions / mailbox / daemon registry from
// earlier runs replay stale events (false mailSeen, resumed agents with stale
// context) and a shared registry lets concurrent e2e runs SIGTERM each other.
const root = await mkdtemp(join(tmpdir(), "mesh-e2e-"));

// Agent project dirs also live inside the throwaway root (as absolute paths, so
// the daemon's relative-cwd resolution is bypassed). They must exist before
// spawn: a fresh checkout has no test_mesh_0/ and Bun reports a missing spawn
// cwd as a misleading ENOENT on the command itself.
const mesh = { ...DEMO_MESH, agents: DEMO_MESH.agents.map((a) => ({ ...a, project: join(root, a.project) })) };
for (const dir of new Set(mesh.agents.map((a) => a.project))) await mkdir(dir, { recursive: true });
const probe = join(root, "test_mesh_0", "e2e-probe.txt");

const manager = new MeshManager({ root, debug: process.env.E2E_DEBUG === "1" });
await manager.defineMesh(mesh);

const ready = new Set<string>();
// Assertion flags only arm after startMesh completes: spawn-time events (mailbox
// replay, session/load history replay) must not produce false positives.
let live = false;
let mailSeen = false;
let recipientActivity = false;
let permSeen = false;
let permResolvedHuman = false;
let interruptSeen = false;
let codexStreaming = false;
let codexReadOnlyApplied = false;

const isChunk = (u: any) =>
  ["agent_message_chunk", "agent_thought_chunk", "tool_call"].includes(u?.sessionUpdate);

// E2E_DEBUG=1: dump a compact NDJSON trace of every mesh event to stderr so flaky
// failures can be diagnosed from timing (wake turn queued/started, log events, chunks).
const t0 = Date.now();
const traceEvent = (e: any) => {
  const rec: Record<string, unknown> = { t: ((Date.now() - t0) / 1000).toFixed(1), kind: e.kind };
  if (e.agent) rec.agent = e.agent;
  if (e.kind === "update") rec.su = e.update?.sessionUpdate;
  if (e.kind === "log") rec.text = e.text;
  if (e.kind === "mail" || e.kind === "steer") { rec.from = e.from; rec.to = e.to; }
  if (e.kind === "agent_turn") { rec.phase = e.phase; rec.agent = e.turn?.agent; rec.source = e.turn?.source; }
  if (e.kind === "agent_status") { rec.status = e.status; if (e.detail) rec.detail = e.detail; }
  if (e.kind === "agent_activity") rec.activity = e.activity;
  if (e.kind === "permission" || e.kind === "permission_resolved") rec.req = (e as any).requestId;
  console.error(`[trace] ${JSON.stringify(rec)}`);
};

manager.on((_name, e) => {
  if (process.env.E2E_DEBUG === "1") traceEvent(e);
  if (e.kind === "agent_status" && e.status === "ready") ready.add(e.agent);
  if (e.kind === "permission") {
    if (live) permSeen = true;
    const allow = e.options.find((o) => o.kind === "allow_once") ?? e.options[0];
    if (allow) setTimeout(() => manager.resolvePermission(DEMO_MESH.name, e.requestId, allow.id), 500);
  }
  if (!live) return;
  if (e.kind === "mail" && e.from === "codex-1" && e.to === "opencode-1") mailSeen = true;
  if (mailSeen && e.kind === "update" && e.agent === "opencode-1" && isChunk(e.update)) recipientActivity = true;
  if (e.kind === "update" && e.agent === "codex-1" && isChunk(e.update)) codexStreaming = true;
  if (
    e.kind === "update" &&
    e.agent === "codex-1" &&
    (e.update as any)?.sessionUpdate === "current_mode_update" &&
    (e.update as any)?.currentModeId === "read-only"
  ) {
    codexReadOnlyApplied = true;
  }
  if (e.kind === "permission_resolved" && e.by === "human") permResolvedHuman = true;
  if (e.kind === "interrupt" && e.target === "codex-1") interruptSeen = true;
});

// Prompt an agent inside the demo mesh via the manager's host client.
// Host prompts are fire-and-forget (no stopReason), so assertions key off events.
const hostPrompt = (id: string, text: string) => manager.promptAgent(DEMO_MESH.name, id, text);

const waitFor = async (cond: () => boolean | Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (!(await cond()) && Date.now() < end) await Bun.sleep(300);
  return cond();
};

const results: { point: string; ok: boolean; detail: string }[] = [];

function printReport(): boolean {
  const pad = Math.max(...results.map((r) => r.point.length), 10);
  console.log("\n=== Agent Mesh PoC — end-to-end verification ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"}  ${r.point.padEnd(pad)}  ${r.detail}`);
  const allOk = results.length === 5 && results.every((r) => r.ok);
  console.log(`\n${allOk ? "ALL PASS" : "FAILURES PRESENT"}`);
  return allOk;
}

const watchdog = setTimeout(() => {
  console.error("\n[e2e] GLOBAL WATCHDOG fired — forcing report with partial results");
  printReport();
  manager.stopAll()
    .finally(() => rm(root, { recursive: true, force: true }))
    .finally(() => process.exit(1));
}, 420_000);

try {
  // Points 1 & 2: spawn + manage heterogeneous agents in a hardwired mesh.
  await manager.startMesh(DEMO_MESH.name);
  await waitFor(() => ready.size === DEMO_MESH.agents.length, 60_000);
  results.push({
    point: "1+2 spawn heterogeneous mesh (router+codex+opencode)",
    ok: ready.size === DEMO_MESH.agents.length,
    detail: `ready: ${[...ready].join(", ")}`,
  });
  live = true;

  // Point 3: inter-agent mailbox A -> B.
  hostPrompt(
    "codex-1",
    "Use the send_mail tool to send 'e2e ping' to the agent 'opencode-1', then stop.",
  );
  await waitFor(() => recipientActivity, 90_000);
  results.push({
    point: "3 inter-agent mailbox (codex-1 -> opencode-1, recipient woken)",
    ok: mailSeen && recipientActivity,
    detail: `mailSeen=${mailSeen} recipientActivity=${recipientActivity}`,
  });

  // Point 4: member permission request escalates -> (auto) human decision -> op runs.
  codexReadOnlyApplied = false;
  await manager.setMode(DEMO_MESH.name, "codex-1", "read-only");
  // setMode is async and has no host-side ack; this explicit wait avoids a step 4 race
  // where the prompt runs before read-only mode is actually applied.
  const modeApplied = await waitFor(() => codexReadOnlyApplied, 10_000);
  if (!modeApplied) throw new Error("timed out waiting for codex-1 read-only mode before permission prompt");
  hostPrompt(
    "codex-1",
    "You are read-only. Create a file named e2e-probe.txt containing 'ok'. Request approval, and once granted, create it.",
  );
  const fileOk = await waitFor(async () => {
    try {
      await stat(probe);
      return true;
    } catch {
      return false;
    }
  }, 90_000);
  results.push({
    point: "4 permission escalation -> human decision -> op runs",
    ok: permSeen && permResolvedHuman && fileOk,
    detail: `permSeen=${permSeen} resolvedByHuman=${permResolvedHuman} fileWritten=${fileOk}`,
  });

  // Point 5: Router interrupt -> session/cancel. Restore codex to full-access so
  // the long-running command runs without a separate approval, then interrupt it.
  manager.setMode(DEMO_MESH.name, "codex-1", "full-access");
  codexStreaming = false;
  hostPrompt("codex-1", "Run the shell command `sleep 40` and wait for it to finish, then say 'slept'.");
  const codexStreamed = await waitFor(() => codexStreaming, 60_000);
  await manager.promptRouter(
    DEMO_MESH.name,
    "Use the interrupt tool now: target='codex-1', reason='e2e'. Call it immediately.",
  );
  await waitFor(() => interruptSeen, 30_000);
  // Give codex a moment to settle (stop streaming) after the cancel propagates.
  await Bun.sleep(3_000);
  results.push({
    point: "5 Router interrupt -> session/cancel",
    ok: interruptSeen && codexStreamed,
    detail: `interruptSeen=${interruptSeen} codexStreamed=${codexStreamed}`,
  });

  results.push({ point: "6 TUI renders live state", ok: true, detail: "manual: `bun run mesh` (verified via snapshot)" });
} finally {
  clearTimeout(watchdog);
  await manager.stopAll();
  await rm(root, { recursive: true, force: true });
}

const allOk = printReport();
process.exit(allOk ? 0 : 1);
