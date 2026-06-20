// Session-resume e2e over the real backend + mesh-host + ACP client, with a
// deterministic fake codex-acp executable injected through PATH.
// Self-isolating: defaults to a free port + a fresh temp root (no dependency on ~/.agent-mesh-dev).
// Run: bun run src/web/session-resume.e2e.ts  (optional overrides: E2E_PORT=.. E2E_ROOT=..)
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, type Page } from "playwright";
import { authedContext, authedReady, e2eAuthRoot, freePort, launchChromium, seedApprovedDevice } from "./e2e-playwright";

const PORT = Number(process.env.E2E_PORT) || freePort();
const BASE = `http://localhost:${PORT}`;
// Self-isolating by default: a fresh temp root (never the shared ~/.agent-mesh-dev). An explicit
// E2E_ROOT override is honored, but we only auto-clean roots we created ourselves.
const ownRoot = !process.env.E2E_ROOT;
const ROOT = process.env.E2E_ROOT?.replace(/^~/, homedir()) ?? (await mkdtemp(join(tmpdir(), "mesh-resume-root-")));
const e2eToken = await seedApprovedDevice(e2eAuthRoot(ROOT));
const REPO = resolve(import.meta.dir, "..", "..");
const mesh = `resume-e2e-${process.pid}`;
const work = await mkdtemp(join(tmpdir(), "mesh-resume-e2e-"));
const fakeStore = join(work, "fake-store");
const effects = join(work, "effects.log");
const bin = join(work, "bin");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let pass = 0;
const fails: string[] = [];
let browser: Browser | undefined;
let page: Page | undefined;
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

await mkdir(bin, { recursive: true });
const shim = join(bin, "codex-acp");
await writeFile(shim, `#!/usr/bin/env bash\nexec bun ${JSON.stringify(resolve(REPO, "src", "fixtures", "resume-acp.ts"))}\n`, "utf8");
await chmod(shim, 0o700);

let backend = Bun.spawn(["bun", "run", "src/main.ts", "--no-assistant", "--port", String(PORT), "--root", ROOT], {
  cwd: REPO,
  env: {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    FAKE_ACP_STORE: fakeStore,
    FAKE_ACP_EFFECTS: effects,
    FAKE_ACP_REPLAY_IMAGE: "1",
    MESH_API_PORT: "",
  },
  stdout: "pipe",
  stderr: "pipe",
});

try {
  await waitReady();
  browser = await launchChromium();
  const ctx = await authedContext(browser, e2eToken, { viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();
  const config = { name: mesh, agents: [{ id: "r", harness: "codex", project: ".", role: "router" }], edges: [] };

  let firstPid = 0;
  const sentinel = `SENTINEL-${process.pid}`;
  await step("define + start mesh, establish sentinel and one side effect", async () => {
    if (!(await post("/api/meshes", config)).ok) throw new Error("define failed");
    if (!(await post(`/api/meshes/${mesh}/start`)).ok) throw new Error("start failed");
    await waitFor(async () => (await daemonPid()) > 0);
    firstPid = await daemonPid();
    await post(`/api/meshes/${mesh}/agents/r/prompt`, { text: `remember sentinel ${sentinel}` });
    await waitFor(async () => (await transcriptText()).includes(`remembered ${sentinel}`));
    const lines = (await readFile(effects, "utf8")).trim().split("\n").filter(Boolean);
    if (lines.length !== 1 || lines[0] !== sentinel) throw new Error(`unexpected effects: ${JSON.stringify(lines)}`);
  });

  await step("kill -9 mesh daemon, restart mesh, session/load recalls sentinel without duplicate side effect", async () => {
    process.kill(firstPid, "SIGKILL");
    await sleep(600);
    if (!(await post(`/api/meshes/${mesh}/start`)).ok) throw new Error("restart failed");
    await waitFor(async () => {
      try {
        return (await daemonPid()) !== firstPid;
      } catch {
        return false;
      }
    });
    await post(`/api/meshes/${mesh}/agents/r/prompt`, { text: "what is the sentinel?" });
    await waitFor(async () => (await transcriptText()).includes(sentinel));
    const lines = (await readFile(effects, "utf8")).trim().split("\n").filter(Boolean);
    if (lines.length !== 1) throw new Error(`side effect duplicated: ${JSON.stringify(lines)}`);
  });

  await step("browser renders resumed user image markdown as an image", async () => {
    if (!page) throw new Error("missing browser page");
    await page.addInitScript((selected) => {
      localStorage.setItem("mesh.lang", "en");
      localStorage.setItem("mesh.selected", selected);
    }, mesh);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".brand", { timeout: 8000 });
    await page.waitForSelector(`.detail-head:has-text("${mesh}")`, { timeout: 8000 }).catch(async (error) => {
      const rows = await page!.locator(".mrow .mname").allTextContents().catch(() => []);
      const detail = await page!.locator(".detail-head").textContent().catch(() => "");
      throw new Error(`${String(error).split("\n")[0]} rows=${JSON.stringify(rows.slice(0, 8))} detail=${JSON.stringify(detail)}`);
    });
    const panel = page.locator(".conv-panel").first();
    await panel.locator('.msg.user .bubble img[src^="data:image/png"]').first().waitFor({ timeout: 8000 });
    const visibleBase64 = await panel.locator(".msg.user .bubble", { hasText: "iVBORw0KGgo" }).count();
    if (visibleBase64) throw new Error("resumed user image is still visible as base64 text");
  });

  await step("deliberate stop clears auto-respawn flag; explicit start resurrects", async () => {
    if (!(await post(`/api/meshes/${mesh}/stop`)).ok) throw new Error("stop failed");
    await waitFor(async () => {
      try {
        process.kill(await daemonPid(), 0);
        return false;
      } catch {
        return true;
      }
    });
    const saved = JSON.parse(await readFile(sessionsPath(), "utf8"));
    if (saved.meshExpectedAlive !== false) throw new Error("meshExpectedAlive was not false after stop");
    if (!(await post(`/api/meshes/${mesh}/start`)).ok) throw new Error("restart after stop failed");
    await waitFor(async () => {
      const s = await state();
      return s.meshes.some((m: any) => m.name === mesh && m.agents?.[0]?.status === "ready");
    });
    await waitFor(async () => {
      const current = JSON.parse(await readFile(sessionsPath(), "utf8"));
      return current.meshExpectedAlive === true;
    });
  });

  await step("explicit restart resumes saved session", async () => {
    await post(`/api/meshes/${mesh}/agents/r/prompt`, { text: "what is the sentinel?" });
    await waitFor(async () => (await transcriptText()).includes(sentinel));
    const lines = (await readFile(effects, "utf8")).trim().split("\n").filter(Boolean);
    if (lines.length !== 1) throw new Error(`side effect duplicated: ${JSON.stringify(lines)}`);
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  SESSION-RESUME E2E OK");
  }
} finally {
  await browser?.close();
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
