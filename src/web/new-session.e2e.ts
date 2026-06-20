// New-session-switch e2e over the real backend + mesh-host + ACP client, with the
// deterministic fake codex-acp executable injected through PATH.
// Verifies: live respawn → fresh session id + transcript divider; mesh-wide reset;
// and the stopped-mesh path that only invalidates the persisted id on disk.
// Self-isolating: defaults to a free port + a fresh temp root (no dependency on ~/.agent-mesh-dev).
// Run: bun run src/web/new-session.e2e.ts  (optional overrides: E2E_PORT=.. E2E_ROOT=..)
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { authedReady, e2eAuthRoot, freePort, seedApprovedDevice } from "./e2e-playwright";

const PORT = Number(process.env.E2E_PORT) || freePort();
const BASE = `http://localhost:${PORT}`;
// Self-isolating by default: a fresh temp root (never the shared ~/.agent-mesh-dev). An explicit
// E2E_ROOT override is honored, but we only auto-clean roots we created ourselves.
const ownRoot = !process.env.E2E_ROOT;
const ROOT = process.env.E2E_ROOT?.replace(/^~/, homedir()) ?? (await mkdtemp(join(tmpdir(), "mesh-new-session-root-")));
const e2eToken = await seedApprovedDevice(e2eAuthRoot(ROOT));
const REPO = resolve(import.meta.dir, "..", "..");
const mesh = `new-session-e2e-${process.pid}`;
const work = await mkdtemp(join(tmpdir(), "mesh-new-session-e2e-"));
const fakeStore = join(work, "fake-store");
const bin = join(work, "bin");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let pass = 0;
const fails: string[] = [];
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    fails.push(name);
    console.log(`  ✗ ${name} — ${String(e?.message ?? e).split("\n")[0]}`);
  }
}

async function waitReady(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await authedReady(BASE, e2eToken)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("backend never became ready");
}

const post = (p: string, body?: unknown) =>
  fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${e2eToken}` }, body: body ? JSON.stringify(body) : undefined });
const del = (p: string) => fetch(`${BASE}${p}`, { method: "DELETE", headers: { authorization: `Bearer ${e2eToken}` } });
const recPath = () => join(ROOT, ".agent-mesh", "run", `${mesh}.json`);
const sessionsPath = () => join(ROOT, ".agent-mesh", "run", `${mesh}.sessions.json`);

async function daemonPid(): Promise<number> {
  const rec = JSON.parse(await readFile(recPath(), "utf8"));
  if (!rec.pid) throw new Error("missing daemon pid");
  return rec.pid;
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 8000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(250);
  }
  throw new Error("condition not met before timeout");
}

async function transcriptText(): Promise<string> {
  // Transcript bodies are intentionally NOT in /api/state (gateway.snapshot ships placeholders);
  // read them the same way the client does — via the backfill endpoint.
  const r = await fetch(`${BASE}/api/meshes/${mesh}/agents/r/transcript?limit=500`, { headers: { authorization: `Bearer ${e2eToken}` } });
  if (!r.ok) return "[]";
  return JSON.stringify((await r.json()).items ?? []);
}
async function dividerCount(): Promise<number> {
  return (await transcriptText()).split('"kind":"divider"').length - 1;
}
async function savedSessionId(): Promise<string> {
  const saved = JSON.parse(await readFile(sessionsPath(), "utf8"));
  return saved.agents?.r?.sessionId ?? "";
}

await mkdir(bin, { recursive: true });
const shim = join(bin, "codex-acp");
await writeFile(shim, `#!/usr/bin/env bash\nexec bun ${JSON.stringify(resolve(REPO, "src", "fixtures", "resume-acp.ts"))}\n`, "utf8");
await chmod(shim, 0o700);

let backend = Bun.spawn(["bun", "run", "src/main.ts", "run", "--no-assistant", "--port", String(PORT), "--root", ROOT], {
  cwd: REPO,
  env: {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    FAKE_ACP_STORE: fakeStore,
    MESH_API_PORT: "",
  },
  stdout: "pipe",
  stderr: "pipe",
});

try {
  await waitReady();
  const config = { name: mesh, agents: [{ id: "r", harness: "codex", project: ".", role: "router" }], edges: [] };

  let firstSid = "";
  await step("define + start mesh persists a fresh session id", async () => {
    if (!(await post("/api/meshes", config)).ok) throw new Error("define failed");
    if (!(await post(`/api/meshes/${mesh}/start`)).ok) throw new Error("start failed");
    await waitFor(async () => (await daemonPid()) > 0);
    await waitFor(async () => (await savedSessionId()).length > 0);
    firstSid = await savedSessionId();
  });

  await step("per-agent new session: live respawn → fresh id + transcript divider", async () => {
    if (!(await post(`/api/meshes/${mesh}/agents/r/session`)).ok) throw new Error("new session failed");
    await waitFor(async () => (await dividerCount()) >= 1);
    await waitFor(async () => (await savedSessionId()) !== firstSid && (await savedSessionId()).length > 0);
  });

  await step("mesh-wide new sessions: emits another divider and rotates the id again", async () => {
    const before = await savedSessionId();
    if (!(await post(`/api/meshes/${mesh}/session`)).ok) throw new Error("mesh-wide new session failed");
    await waitFor(async () => (await dividerCount()) >= 2);
    await waitFor(async () => (await savedSessionId()) !== before && (await savedSessionId()).length > 0);
  });

  await step("stopped mesh: per-agent new session only blanks the persisted id (no spawn)", async () => {
    if (!(await post(`/api/meshes/${mesh}/stop`)).ok) throw new Error("stop failed");
    await waitFor(async () => {
      try {
        process.kill(await daemonPid(), 0);
        return false;
      } catch {
        return true;
      }
    });
    if (!(await post(`/api/meshes/${mesh}/agents/r/session`)).ok) throw new Error("stopped new session failed");
    await waitFor(async () => (await savedSessionId()) === "");
    // no daemon should have been spawned by the reset
    let alive = false;
    try {
      process.kill(await daemonPid(), 0);
      alive = true;
    } catch {}
    if (alive) throw new Error("a daemon was resurrected by a stopped-mesh session reset");
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  NEW-SESSION E2E OK");
  }
} finally {
  try { await post(`/api/meshes/${mesh}/stop`); } catch {}
  try { await del(`/api/meshes/${mesh}`); } catch {}
  try { await rm(sessionsPath(), { force: true }); } catch {}
  backend.kill("SIGKILL");
  try {
    const pid = await daemonPid();
    process.kill(pid, "SIGKILL");
  } catch {}
  await rm(work, { recursive: true, force: true });
  if (ownRoot) await rm(ROOT, { recursive: true, force: true });
}
