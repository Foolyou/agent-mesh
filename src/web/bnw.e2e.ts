// Step 7.0 — `/bnw/` console smoke e2e: boots the web server over a FAKE gateway (no real
// agents), seeds an approved device token, and drives a real browser to verify the new
// parallel shell mounts under /bnw/, route-switches across surfaces, renders placeholders,
// and does same-origin SPA navigation via RouteLink. Run: bun run src/web/bnw.e2e.ts
import { WebGateway } from "./gateway";
import { startWebServer } from "./server";
import { authedContext, launchChromium, provisionE2eAuth } from "./e2e-playwright";
import { rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import type { MeshEvent, MeshConfig } from "../acp/types";

const SHOTS = "/tmp/mesh-shots";
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const MESHES = ["demo", "alpha"];
const cfgOf = (name: string): MeshConfig => ({
  name,
  agents: [{ id: "router", harness: "claude", project: "p", role: "router" }],
  edges: [],
});

function fakeManager() {
  return {
    on(_l: (n: string, e: MeshEvent) => void) { return () => {}; },
    listMeshes() { return MESHES.map((name) => ({ name, defined: true, status: "stopped" as const })); },
    configOf(name: string) { return cfgOf(name); },
    routerOf() { return "router"; },
    async startMesh() {}, async stopMesh() {}, async promptRouter() {}, promptAgent() {},
    resolvePermission() {}, async setMode() {}, async setModel() {}, async setAgentEffort() {},
    interruptAgent() {}, async defineMesh() {}, async deleteMesh() {}, async loadDefinitions() {}, async stopAll() {},
  };
}

function assert(cond: unknown, msg: string) { if (!cond) throw new Error(`BNW E2E FAIL: ${msg}`); }

const auth = await provisionE2eAuth();
const gw = new WebGateway(fakeManager() as any, undefined, { root: auth.authRoot });
const handle = startWebServer({ gateway: gw, port: 0, dev: false }); // no HMR (prod-like serving)
const BASE = handle.url;
const browser = await launchChromium();
const errors: string[] = [];
let passed = 0;
const step = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

try {
  const ctx = await authedContext(browser, auth.token, { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|_bun\/hmr/.test(m.text())) errors.push(m.text()); });

  await step("/bnw/ mounts the new shell + lands on default mesh runtime", async () => {
    await page.goto(`${BASE}/bnw/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw="shell"]', { timeout: 10000 });
    // home → default mesh runtime (replace nav once meshes arrive over WS)
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 10000 });
    assert(/\/bnw\/mesh\/(demo|alpha)$/.test(new URL(page.url()).pathname), `landed on a mesh runtime (got ${page.url()})`);
    if (await page.locator('nav[aria-label="meshes"] a').count() < 2) throw new Error("mesh nav rows missing");
  });

  await step("deep-link board / doctor / settings / notFound switch the surface", async () => {
    for (const [path, surface] of [
      ["/bnw/mesh/demo/board", "board"],
      ["/bnw/mesh/demo/canvas", "runtime"],
      ["/bnw/doctor", "doctor"],
      ["/bnw/settings", "settings"],
      ["/bnw/harnesses", "harnesses"],
      ["/bnw/notifications", "notifications"],
      ["/bnw/mesh/new", "newMesh"],
      ["/bnw/nope/deep", "notFound"],
    ] as [string, string][]) {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(`[data-bnw-surface="${surface}"]`, { timeout: 8000 });
    }
  });

  await step("RouteLink does same-origin SPA nav (no full reload) runtime→board", async () => {
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    await page.evaluate(() => ((window as any).__bnwNav = true)); // marker cleared by a real reload
    await page.getByRole("link", { name: "看板" }).first().click();
    await page.waitForSelector('[data-bnw-surface="board"]', { timeout: 8000 });
    assert(await page.evaluate(() => (window as any).__bnwNav === true), "SPA nav must not full-reload the page");
    assert(new URL(page.url()).pathname === "/bnw/mesh/demo/board", `URL updated (got ${page.url()})`);
  });

  await step("file-viewer deep link with a dotted path resolves (not 404)", async () => {
    await page.goto(`${BASE}/bnw/mesh/demo/agent/router/artifact/topology.png`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="file"]', { timeout: 8000 });
  });

  await step("screenshot bnw-shell", async () => {
    await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-bnw-surface="runtime"]', { timeout: 8000 });
    await sleep(150);
    await page.screenshot({ path: `${SHOTS}/bnw-shell.png`, fullPage: true });
  });

  if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);
  console.log(`BNW E2E: ${passed} passed, 0 failed`);
  console.log("BNW E2E OK");
} finally {
  await browser.close();
  handle.stop();
  await rm(auth.meshRootBase, { recursive: true, force: true });
}
