// E2E: mesh MCP tools (send_mail/check_mail/mesh_status/…) must survive EVERY
// respawn path — fresh start, single new-session, resume after a daemon kill,
// and mesh-wide new-all-sessions. Regression guard for the bug where a once-built
// MCP transport rejected a respawned agent's initialize with "Server already
// initialized", leaving the agent tool-less.
//
// Uses a real backend + mesh-host + ControlPlane on the dev port/root, with a
// deterministic MCP-aware fake codex-acp (src/fixtures/mcp-probe-acp.ts) injected
// via PATH. The probe connects to the injected mesh-services server with the real
// MCP SDK client and reports its live tool list on every prompt.
//
// Run: E2E_PORT=10020 E2E_ROOT=~/.agent-mesh-dev bun run src/web/mcp-tools-respawn.e2e.ts
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { authedReady, e2eAuthRoot, seedApprovedDevice } from "./e2e-playwright";

const PORT = Number(process.env.E2E_PORT) || 10020;
const BASE = `http://localhost:${PORT}`;
const ROOT = process.env.E2E_ROOT?.replace(/^~/, homedir()) ?? join(homedir(), ".agent-mesh-dev");
const e2eToken = await seedApprovedDevice(e2eAuthRoot(ROOT));
const REPO = resolve(import.meta.dir, "..", "..");
const mesh = `mcp-tools-e2e-${process.pid}`;
const work = await mkdtemp(join(tmpdir(), "mesh-mcp-tools-e2e-"));
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
    try { if ((await authedReady(BASE, e2eToken)).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error("backend never became ready");
}

const state = async () => (await fetch(`${BASE}/api/state`, { headers: { authorization: `Bearer ${e2eToken}` } })).json();
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

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 12000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(250);
  }
  throw new Error("condition not met before timeout");
}

async function transcriptText(agent: string): Promise<string> {
  const s = await state();
  return JSON.stringify(s.perMesh?.[mesh]?.transcripts?.[agent]?.items ?? []);
}

let nonceSeq = 0;
const nextNonce = () => `n${process.pid}x${++nonceSeq}`;
const dividerCount = async (agent: string) => (await transcriptText(agent)).split('"kind":"divider"').length - 1;

// A new-session/new-all respawn settles asynchronously after the POST returns
// (the "new session" divider lands a beat later). Wait for it so the probe
// prompt reaches the freshly respawned connection, not the dying one.
async function awaitDivider(agent: string, action: () => Promise<void>): Promise<void> {
  const before = await dividerCount(agent);
  await action();
  await waitFor(async () => (await dividerCount(agent)) > before, 12000);
}

// Send a nonce-tagged probe prompt to an agent (after performing any respawn
// `action` first), then wait for the matching PROBE answer and assert the mesh
// tools are present and mesh_status round-trips. Nonce correlation survives the
// transcript reset that new-session/new-all trigger. Throws on PROBE_FAIL.
async function expectToolsAfter(agent: string, action: () => Promise<void>, isRouter = false): Promise<void> {
  await action();
  const nonce = nextNonce();
  await post(`/api/meshes/${mesh}/agents/${agent}/prompt`, { text: `probe ${nonce}` });
  try {
    await waitFor(async () => {
      const tx = await transcriptText(agent);
      return tx.includes(`PROBE n=${nonce} `) || tx.includes(`PROBE_FAIL n=${nonce} `);
    }, 15000);
  } catch (e) {
    console.log(`    [debug ${agent} nonce=${nonce}] transcript tail: ${(await transcriptText(agent)).slice(-500)}`);
    throw e;
  }
  const tx = await transcriptText(agent);
  if (tx.includes(`PROBE_FAIL n=${nonce} `)) {
    const at = tx.indexOf(`PROBE_FAIL n=${nonce} `);
    throw new Error(`MCP handshake failed for ${agent}: ${tx.slice(at, at + 180)}`);
  }
  const at = tx.indexOf(`PROBE n=${nonce} `);
  const seg = tx.slice(at, at + 240);
  for (const t of ["mesh_status", "send_mail", "check_mail", "steer_mail"]) {
    if (!seg.includes(t)) throw new Error(`${agent} missing tool ${t} after respawn: ${seg}`);
  }
  if (isRouter && !seg.includes("interrupt")) throw new Error(`router ${agent} missing interrupt tool: ${seg}`);
  if (!seg.includes("statusOk=true")) throw new Error(`${agent} mesh_status round-trip failed: ${seg}`);
}

await mkdir(bin, { recursive: true });
const shim = join(bin, "codex-acp");
await writeFile(shim, `#!/usr/bin/env bash\nexec bun ${JSON.stringify(resolve(REPO, "src", "fixtures", "mcp-probe-acp.ts"))}\n`, "utf8");
await chmod(shim, 0o700);

const backend = Bun.spawn(["bun", "run", "src/main.ts", "backend", "--no-assistant", "--port", String(PORT), "--root", ROOT], {
  cwd: REPO,
  env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, MESH_API_PORT: "" },
  stdout: "pipe",
  stderr: "pipe",
});

try {
  await waitReady();
  const config = {
    name: mesh,
    agents: [
      { id: "r", harness: "codex", project: ".", role: "router" },
      { id: "m", harness: "codex", project: ".", role: "member" },
    ],
    edges: [{ from: "r", to: "m" }],
  };

  let firstPid = 0;
  await step("fresh start: router + member both get the full mesh toolset", async () => {
    if (!(await post("/api/meshes", config)).ok) throw new Error("define failed");
    if (!(await post(`/api/meshes/${mesh}/start`)).ok) throw new Error("start failed");
    await waitFor(async () => (await daemonPid()) > 0);
    firstPid = await daemonPid();
    await expectToolsAfter("r", async () => {}, true);
    await expectToolsAfter("m", async () => {});
  });

  await step("single new-session (forceFresh respawn) keeps the router's tools", async () => {
    await expectToolsAfter("r", async () => {
      await awaitDivider("r", async () => {
        if (!(await post(`/api/meshes/${mesh}/agents/r/session`)).ok) throw new Error("new session failed");
      });
    }, true);
  });

  await step("resume after daemon kill (session/load respawn) keeps tools for both agents", async () => {
    process.kill(firstPid, "SIGKILL");
    await sleep(600);
    if (!(await post(`/api/meshes/${mesh}/start`)).ok) throw new Error("restart failed");
    await waitFor(async () => { try { return (await daemonPid()) !== firstPid; } catch { return false; } });
    await expectToolsAfter("r", async () => {}, true);
    await expectToolsAfter("m", async () => {});
  });

  await step("mesh-wide new-all-sessions keeps tools for every agent", async () => {
    await awaitDivider("r", async () => {
      if (!(await post(`/api/meshes/${mesh}/session`)).ok) throw new Error("new-all sessions failed");
    });
    await waitFor(async () => (await dividerCount("m")) >= 1);
    await expectToolsAfter("r", async () => {}, true);
    await expectToolsAfter("m", async () => {});
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) { console.log("  FAILED:", fails.join(", ")); process.exitCode = 1; }
  else console.log("  MCP-TOOLS-RESPAWN E2E OK");
} finally {
  try { await post(`/api/meshes/${mesh}/stop`); } catch {}
  try { await del(`/api/meshes/${mesh}`); } catch {}
  try { await rm(sessionsPath(), { force: true }); } catch {}
  backend.kill("SIGKILL");
  try { process.kill(await daemonPid(), "SIGKILL"); } catch {}
  await rm(work, { recursive: true, force: true });
}
