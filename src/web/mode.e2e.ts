// Browser e2e for the agent session mode/model pickers: starts the fake mesh, opens a member
// conversation tab, and drives the <select>s — proving the advertised choices render and that
// switching round-trips through setMode/setModel back into the pickers.
// Run: bun run src/web/mode.e2e.ts
import { type Page } from "playwright";
import { authedContext, authedReady, launchChromium, provisionE2eAuth } from "./e2e-playwright";
import { rm } from "node:fs/promises";

const PORT = Number(process.env.E2E_PORT) || 7540;
const BASE = `http://localhost:${PORT}`;
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

const auth = await provisionE2eAuth();
const server = Bun.spawn(["bun", "run", "src/main.ts", "run", "--fake", "--port", String(PORT)], { stdout: "pipe", stderr: "pipe", env: auth.env });
const browser = await launchChromium();
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await authedReady(BASE, auth.token)).ok) break;
    } catch {}
    await sleep(250);
  }
  const ctx = await authedContext(browser, auth.token, { viewport: { width: 1440, height: 900 } });
  const page: Page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".mrow.sel", { timeout: 8000 });

  await step("stopped mesh shows NO mode picker", async () => {
    if (await page.locator(".mode-sel").count()) throw new Error("mode picker visible before the mesh is running");
    if (await page.locator(".model-sel").count()) throw new Error("model picker visible before the mesh is running");
    if (await page.locator(".effort-sel").count()) throw new Error("effort picker visible before the mesh is running");
  });

  await step("start mesh → member tab shows the advertised modes", async () => {
    await page.locator('.detail-head .btn:has-text("start mesh")').click();
    await page.waitForSelector('.detail-head:has-text("running")', { timeout: 8000 });
    await page.locator('.conv-member-tab:has-text("codex-1")').click();
    const mode = page.locator(".conv-control .mode-sel");
    await mode.waitFor({ timeout: 8000 });
    const opts = await mode.locator("option").allTextContents();
    const want = ["read-only", "default", "full-access"];
    if (JSON.stringify(opts) !== JSON.stringify(want)) throw new Error(`options ${JSON.stringify(opts)} != ${JSON.stringify(want)}`);
    const val = await mode.inputValue();
    if (val !== "default") throw new Error(`current mode "${val}" != "default"`);
    const model = page.locator(".conv-control .model-sel");
    await model.waitFor({ timeout: 8000 });
    const modelOpts = await model.locator("option").allTextContents();
    const wantModels = ["kimi-k2", "deepseek-v3"];
    if (JSON.stringify(modelOpts) !== JSON.stringify(wantModels)) throw new Error(`model options ${JSON.stringify(modelOpts)} != ${JSON.stringify(wantModels)}`);
    if ((await model.inputValue()) !== "kimi-k2") throw new Error(`current model "${await model.inputValue()}" != "kimi-k2"`);
  });

  await step("effort picker shows per-harness: codex present (disabled while running), opencode hidden", async () => {
    // codex-1 is selected; codex has a spawn-time effort ladder → picker present but disabled
    // at runtime (codex is not runtime-switchable), and includes xhigh.
    const codexEffort = page.locator(".conv-control .effort-sel");
    await codexEffort.waitFor({ timeout: 6000 });
    if (!(await codexEffort.isDisabled())) throw new Error("codex effort picker should be disabled while running (spawn-time only)");
    const effOpts = await codexEffort.locator("option").allTextContents();
    if (!effOpts.includes("xhigh")) throw new Error(`codex effort options missing xhigh: ${JSON.stringify(effOpts)}`);
    // opencode has no effort entry at all → the picker must not render for it.
    await page.locator('.conv-member-tab:has-text("opencode-1")').click();
    await sleep(200);
    if (await page.locator(".conv-control .effort-sel").count()) throw new Error("opencode shows an effort picker but should not");
    await page.locator('.conv-member-tab:has-text("codex-1")').click();
    await sleep(150);
  });

  await step("switching mode round-trips back into the picker + logs the change", async () => {
    await page.locator(".conv-control .mode-sel").selectOption("read-only");
    // the fake echoes agent.modes with the new current → the select reflects it
    await page.waitForFunction(() => (document.querySelector(".conv-control .mode-sel") as HTMLSelectElement)?.value === "read-only", { timeout: 5000 });
    // and the activity log records it
    await page.locator('.drail .seg-tab:has-text("activity")').click();
    await page.waitForSelector('.drail .panel .tx:has-text("mode → read-only")', { timeout: 6000 });
  });

  await step("switching model round-trips back into the picker + logs the change", async () => {
    await page.locator(".conv-control .model-sel").selectOption("deepseek-v3");
    await page.waitForFunction(() => (document.querySelector(".conv-control .model-sel") as HTMLSelectElement)?.value === "deepseek-v3", { timeout: 5000 });
    await page.locator('.drail .seg-tab:has-text("activity")').click();
    await page.waitForSelector('.drail .panel .tx:has-text("model → deepseek-v3")', { timeout: 6000 });
  });

  await step("no page errors", async () => {
    if (errors.length) throw new Error(`${errors.length}: ${errors.slice(0, 2).join(" || ")}`);
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  MODE E2E OK — session mode/model pickers render + round-trip");
  }
} finally {
  await browser.close();
  server.kill();
  await rm(auth.meshRootBase, { recursive: true, force: true });
}
