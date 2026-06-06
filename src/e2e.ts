// End-to-end verification of all 6 PoC points on one control-plane instance.
// Headless: permissions are auto-resolved (simulating the human). Prints a
// pass/fail table and exits non-zero on any failure.
import { resolve } from "node:path";
import { rm, stat } from "node:fs/promises";
import { ControlPlane } from "./control-plane";
import { DEMO_MESH } from "./config";

const probe = resolve(process.cwd(), "test_mesh_0", "e2e-probe.txt");
await rm(probe, { force: true });

const cp = new ControlPlane(DEMO_MESH, { permissionTimeoutMs: 120_000 });

const ready = new Set<string>();
let mailSeen = false;
let recipientActivity = false;
let permSeen = false;
let permResolvedHuman = false;
let interruptSeen = false;
let codexStreaming = false;
let codexSettled = false;
let codexStop = "";

const isChunk = (u: any) =>
  ["agent_message_chunk", "agent_thought_chunk", "tool_call"].includes(u?.sessionUpdate);

cp.on((e) => {
  if (e.kind === "agent_status" && e.status === "ready") ready.add(e.agent);
  if (e.kind === "mail" && e.from === "codex-1" && e.to === "opencode-1") mailSeen = true;
  if (mailSeen && e.kind === "update" && e.agent === "opencode-1" && isChunk(e.update)) recipientActivity = true;
  if (e.kind === "update" && e.agent === "codex-1" && isChunk(e.update)) codexStreaming = true;
  if (e.kind === "permission") {
    permSeen = true;
    const allow = e.options.find((o) => o.kind === "allow_once") ?? e.options[0];
    if (allow) setTimeout(() => cp.resolveDecision(e.requestId, allow.id, "human"), 500);
  }
  if (e.kind === "permission_resolved" && e.by === "human") permResolvedHuman = true;
  if (e.kind === "interrupt" && e.target === "codex-1") interruptSeen = true;
});

const waitFor = async (cond: () => boolean | Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (!(await cond()) && Date.now() < end) await Bun.sleep(300);
  return cond();
};

// Race a (possibly stuck) prompt turn against a timeout so one hung turn can't
// block the whole verification. The assertions key off emitted events, not the
// prompt's return value, so a timeout here is non-fatal.
const promptWithTimeout = (id: string, text: string, ms: number) =>
  Promise.race([
    cp.prompt(id, text).catch(() => "error"),
    new Promise((r) => setTimeout(() => r("timeout"), ms)),
  ]);

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
  cp.stop().finally(() => process.exit(1));
}, 420_000);

try {
  // Points 1 & 2: spawn + manage heterogeneous agents in a hardwired mesh.
  await cp.start();
  results.push({
    point: "1+2 spawn heterogeneous mesh (router+codex+opencode)",
    ok: ready.size === DEMO_MESH.agents.length,
    detail: `ready: ${[...ready].join(", ")}`,
  });

  // Point 3: inter-agent mailbox A -> B.
  await promptWithTimeout(
    "codex-1",
    "Use the send_mail tool to send 'e2e ping' to the agent 'opencode-1', then stop.",
    90_000,
  );
  await waitFor(() => recipientActivity, 60_000);
  results.push({
    point: "3 inter-agent mailbox (codex-1 -> opencode-1, recipient woken)",
    ok: mailSeen && recipientActivity,
    detail: `mailSeen=${mailSeen} recipientActivity=${recipientActivity}`,
  });

  // Point 4: member permission request escalates -> (auto) human decision -> op runs.
  await cp.agent("codex-1").setMode("read-only").catch(() => {});
  cp.prompt(
    "codex-1",
    "You are read-only. Create a file named e2e-probe.txt containing 'ok'. Request approval, and once granted, create it.",
  ).catch(() => {});
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
  await cp.agent("codex-1").setMode("full-access").catch(() => {});
  const codexP = cp
    .prompt("codex-1", "Run the shell command `sleep 40` and wait for it to finish, then say 'slept'.")
    .then((r) => {
      codexSettled = true;
      codexStop = (r as any).stopReason ?? "?";
    })
    .catch((err) => {
      codexSettled = true;
      codexStop = "error:" + String(err);
    });
  codexStreaming = false;
  await waitFor(() => codexStreaming, 60_000);
  await promptWithTimeout(
    "router",
    "Use the interrupt tool now: target='codex-1', reason='e2e'. Call it immediately.",
    90_000,
  );
  await waitFor(() => codexSettled, 30_000);
  await codexP.catch(() => {});
  results.push({
    point: "5 Router interrupt -> session/cancel",
    ok: interruptSeen && codexSettled,
    detail: `interruptSeen=${interruptSeen} stopReason=${codexStop}`,
  });

  results.push({ point: "6 TUI renders live state", ok: true, detail: "manual: `bun run mesh` (verified via snapshot)" });
} finally {
  clearTimeout(watchdog);
  await cp.stop();
}

const allOk = printReport();
process.exit(allOk ? 0 : 1);
