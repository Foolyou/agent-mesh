// Artifact-channel e2e over the fake server. Run: bun run src/web/artifacts.e2e.ts
import { chromium, type Page } from "playwright";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.E2E_PORT) || 7553;
const BASE = `http://localhost:${PORT}`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
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

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}/api/state`)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("server never became ready");
}

async function post(path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return res;
}

async function del(path: string) {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
}

async function openAgent(page: Page, agent: string) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("mesh.selected", "artifact-demo"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('.detail-head:has-text("artifact-demo")', { timeout: 8000 });
  const tab = agent === "lead" ? page.locator(`.conv-router-tab:has-text("${agent}")`) : page.locator(`.conv-member-tab:has-text("${agent}")`);
  await tab.click();
  await page.waitForSelector(`.conv-head .sub:has-text("${agent}")`, { timeout: 8000 });
}

const baseRoot = await mkdtemp(join(tmpdir(), "mesh-artifacts-root-"));
const root = join(baseRoot, ".agent-mesh");
const artifactRoot = join(root, "artifacts", "artifact-demo");
const codexDir = join(artifactRoot, "codex-1");
const builderDir = join(artifactRoot, "builder");
await mkdir(codexDir, { recursive: true });
await mkdir(builderDir, { recursive: true });
await writeFile(join(codexDir, "diagram.png"), PNG);
await writeFile(join(codexDir, "report.md"), "# Artifact report\n");
await writeFile(join(builderDir, "x.png"), PNG);
await writeFile(join(codexDir, "bad.svg"), "<svg></svg>");
await symlink(join(codexDir, "report.md"), join(codexDir, "linked.md"));

const server = Bun.spawn(["bun", "run", "src/main.ts", "--fake", "--port", String(PORT), "--root", baseRoot], {
  stdout: "pipe",
  stderr: "pipe",
});
const browser = await chromium.launch({ headless: true });

try {
  await waitReady();
  await post("/api/meshes", {
    name: "artifact-demo",
    agents: [
      { id: "lead", harness: "claude", project: "p", role: "router" },
      { id: "codex-1", harness: "codex", project: "p", role: "member" },
      { id: "builder", harness: "codex", project: "p", role: "member" },
    ],
    edges: [{ from: "lead", to: "codex-1" }],
  });
  await post("/api/meshes/artifact-demo/start");
  await post("/api/meshes/artifact-demo/agents/codex-1/prompt", {
    text: "Artifacts: ![diagram](artifact:diagram.png) [doc](artifact:report.md)",
  });
  await post("/api/meshes/artifact-demo/prompt", {
    text: "Forwarded: ![builder](artifact://builder/x.png)",
  });
  await sleep(700);

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (/WebSocket connection to .*_bun\/hmr/.test(m.text())) return;
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });

  await step("agent artifact image and document link render with mesh-scoped URLs", async () => {
    await openAgent(page, "codex-1");
    const bubble = page.locator(".msg.agent .bubble", { hasText: "Artifacts:" }).last();
    await bubble.locator('img[src="/api/meshes/artifact-demo/agents/codex-1/artifacts/diagram.png"]').waitFor({ timeout: 8000 });
    await bubble.locator('a[href="/api/meshes/artifact-demo/agents/codex-1/artifacts/report.md"]').waitFor({ timeout: 8000 });
    const res = await fetch(`${BASE}/api/meshes/artifact-demo/agents/codex-1/artifacts/report.md`);
    if (!res.ok || !(await res.text()).includes("Artifact report")) throw new Error(`artifact document fetch failed: ${res.status}`);
  });

  await step("explicit artifact owner renders from another agent directory", async () => {
    await openAgent(page, "lead");
    const bubble = page.locator(".msg.agent .bubble", { hasText: "Forwarded:" }).last();
    await bubble.locator('img[src="/api/meshes/artifact-demo/agents/builder/artifacts/x.png"]').waitFor({ timeout: 8000 });
  });

  await step("negative artifact requests and user-authored artifact refs are rejected", async () => {
    const traversal = await fetch(`${BASE}/api/meshes/artifact-demo/agents/codex-1/artifacts/..%2Foutside.md`);
    if (traversal.status !== 400) throw new Error(`traversal status ${traversal.status}`);
    const linked = await fetch(`${BASE}/api/meshes/artifact-demo/agents/codex-1/artifacts/linked.md`);
    if (linked.status !== 400) throw new Error(`symlink status ${linked.status}`);
    const svg = await fetch(`${BASE}/api/meshes/artifact-demo/agents/codex-1/artifacts/bad.svg`);
    if (svg.status !== 404) throw new Error(`svg status ${svg.status}`);

    await openAgent(page, "lead");
    const textarea = page.locator(".composer textarea");
    await textarea.fill("user artifact ![bad](artifact:x.png)");
    await textarea.press("Enter");
    const userBubble = page.locator(".msg.user .bubble", { hasText: "user artifact" }).last();
    await userBubble.waitFor({ timeout: 8000 });
    if ((await userBubble.locator("img").count()) !== 0) throw new Error("user-authored artifact image rendered without AuthorContext");
  });

  await step("delete mesh removes artifact directory and route returns 404", async () => {
    await post("/api/meshes/artifact-demo/stop");
    await del("/api/meshes/artifact-demo");
    const res = await fetch(`${BASE}/api/meshes/artifact-demo/agents/codex-1/artifacts/diagram.png`);
    if (res.status !== 404) throw new Error(`deleted artifact status ${res.status}`);
    try {
      await mkdir(codexDir);
      throw new Error("artifact directory still existed after delete");
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  });

  await step("no page errors", async () => {
    if (errors.length) throw new Error(errors.slice(0, 3).join(" || "));
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  ARTIFACTS E2E OK");
  }
} finally {
  await browser.close();
  server.kill();
  await rm(baseRoot, { recursive: true, force: true });
}
