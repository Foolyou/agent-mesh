// Artifact-publish e2e over the real backend + mesh-host + ACP client, with a fake
// codex-acp executable (src/fixtures/publish-acp.ts) that drives the real
// mesh_publish_attachment tool. Verifies the full path: agent writes a file →
// publishes it → attachment card appears in the console (image loads, document opens
// in the FileViewer) → dangerous publishes are rejected → deleting the mesh clears the
// artifact bucket.
// Run: E2E_PORT=10026 E2E_ROOT=~/.agent-mesh-dev bun run src/web/artifact-publish.e2e.ts
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./e2e-playwright";

const PORT = Number(process.env.E2E_PORT) || 10026;
const BASE = `http://localhost:${PORT}`;
const ROOT = process.env.E2E_ROOT?.replace(/^~/, homedir()) ?? join(homedir(), ".agent-mesh-dev");
const REPO = resolve(import.meta.dir, "..", "..");
const mesh = `artifact-e2e-${process.pid}`;
const work = await mkdtemp(join(tmpdir(), "mesh-artifact-e2e-"));
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
      if ((await fetch(`${BASE}/api/state`)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("backend never became ready");
}

const state = async () => (await fetch(`${BASE}/api/state`)).json();
const post = (p: string, body?: unknown) =>
  fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const del = (p: string) => fetch(`${BASE}${p}`, { method: "DELETE" });

// /api/state ships the lazy-stripped snapshot (transcript items omitted); read the real
// transcript through the backfill endpoint the client uses for lazy load.
async function transcriptItems(): Promise<any[]> {
  const res = await fetch(`${BASE}/api/meshes/${mesh}/agents/r/transcript?limit=500`);
  if (!res.ok) return [];
  const body = await res.json();
  return body?.items ?? [];
}
async function attachments(): Promise<any[]> {
  return (await transcriptItems()).filter((it: any) => it.kind === "attachment");
}
async function lastAgentText(): Promise<string> {
  const msgs = (await transcriptItems()).filter((it: any) => it.kind === "message" && it.role === "agent");
  return msgs.length ? String(msgs[msgs.length - 1].text ?? "") : "";
}
async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 8000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(200);
  }
  throw new Error("condition not met before timeout");
}

await mkdir(bin, { recursive: true });
const shim = join(bin, "codex-acp");
await writeFile(shim, `#!/usr/bin/env bash\nexec bun ${JSON.stringify(resolve(REPO, "src", "fixtures", "publish-acp.ts"))}\n`, "utf8");
await chmod(shim, 0o700);

const backend = Bun.spawn(["bun", "run", "src/main.ts", "--no-assistant", "--port", String(PORT), "--root", ROOT], {
  cwd: REPO,
  env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, MESH_API_PORT: "" },
  stdout: "pipe",
  stderr: "pipe",
});

try {
  await waitReady();
  browser = await launchChromium();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const config = { name: mesh, agents: [{ id: "r", harness: "codex", project: ".", role: "router" }], edges: [] };

  await step("define + start mesh", async () => {
    if (!(await post("/api/meshes", config)).ok) throw new Error("define failed");
    if (!(await post(`/api/meshes/${mesh}/start`)).ok) throw new Error("start failed");
    await waitFor(async () => (await state()).meshes.some((m: any) => m.name === mesh && m.agents?.[0]?.status === "ready"));
  });

  await step("publish an image → attachment card event + artifact served over the api", async () => {
    await post(`/api/meshes/${mesh}/agents/r/prompt`, { text: "publish-image chart.png" });
    await waitFor(async () => (await attachments()).some((a) => a.path === "chart.png"));
    const card = (await attachments()).find((a) => a.path === "chart.png");
    if (card.agent !== "r") throw new Error(`owner not derived from agent: ${card.agent}`);
    if (card.contentType !== "image/png") throw new Error(`bad content type: ${card.contentType}`);
    if (card.caption !== "the chart") throw new Error(`bad caption: ${card.caption}`);
    const res = await fetch(`${BASE}/api/meshes/${mesh}/agents/r/artifacts/chart.png`);
    if (res.status !== 200) throw new Error(`artifact api status ${res.status}`);
    if (!(res.headers.get("content-type") ?? "").includes("image/png")) throw new Error("artifact api wrong content type");
  });

  await step("publish a document → attachment card with viewer link", async () => {
    await post(`/api/meshes/${mesh}/agents/r/prompt`, { text: "publish-doc report.md" });
    await waitFor(async () => (await attachments()).some((a) => a.path === "report.md"));
    const doc = (await attachments()).find((a) => a.path === "report.md");
    if (!doc.contentType.includes("markdown")) throw new Error(`bad doc content type: ${doc.contentType}`);
    if (doc.name !== "Weekly report") throw new Error(`bad doc name: ${doc.name}`);
  });

  await step("dangerous publishes (svg, traversal) are rejected and add no card", async () => {
    const before = (await attachments()).length;
    await post(`/api/meshes/${mesh}/agents/r/prompt`, { text: "publish-svg evil.svg" });
    await waitFor(async () => (await lastAgentText()).includes("PUBLISH_RESULT"));
    await post(`/api/meshes/${mesh}/agents/r/prompt`, { text: "publish-missing ../escape.md" });
    await waitFor(async () => (await lastAgentText()).includes("error:"));
    await sleep(300);
    const after = await attachments();
    if (after.length !== before) throw new Error(`rejected publishes added cards: ${before} → ${after.length}`);
    if (after.some((a) => a.path.includes("escape") || a.path.includes("svg"))) throw new Error("dangerous artifact leaked into a card");
  });

  await step("browser renders the image card (loads) and opens the document in the FileViewer", async () => {
    if (!page) throw new Error("missing browser page");
    await page.addInitScript((selected) => {
      localStorage.setItem("mesh.lang", "en");
      localStorage.setItem("mesh.selected", selected);
    }, mesh);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".brand", { timeout: 8000 });
    const panel = page.locator(".conv-panel").first();

    const img = panel.locator('.attachment img[src="/api/meshes/' + mesh + '/agents/r/artifacts/chart.png"]').first();
    await img.waitFor({ timeout: 8000 });
    const loaded = await img.evaluate((el: any) => el.complete && el.naturalWidth > 0);
    if (!loaded) throw new Error("attachment image did not load");

    await panel.locator('.attachment a[href="/mesh/' + mesh + '/agent/r/artifact/report.md"]').first().click();
    await page.waitForSelector(".file-viewer-path", { timeout: 8000 });
    await page.waitForSelector('.file-viewer-body h1:has-text("Weekly report")', { timeout: 8000 });
    await page.locator(".file-viewer-back").click();
    await page.waitForSelector(".conv-panel", { timeout: 8000 });
  });

  await step("deleting the mesh clears the artifact bucket", async () => {
    await post(`/api/meshes/${mesh}/stop`);
    await del(`/api/meshes/${mesh}`);
    await sleep(400);
    const res = await fetch(`${BASE}/api/meshes/${mesh}/agents/r/artifacts/chart.png`);
    if (res.status === 200) throw new Error("artifact still served after mesh deletion");
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  ARTIFACT-PUBLISH E2E OK");
  }
} finally {
  await browser?.close();
  try { await post(`/api/meshes/${mesh}/stop`); } catch {}
  try { await del(`/api/meshes/${mesh}`); } catch {}
  backend.kill("SIGKILL");
  await rm(work, { recursive: true, force: true });
}
