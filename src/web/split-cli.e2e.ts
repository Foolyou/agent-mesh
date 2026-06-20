// Two-process e2e: launches `mesh backend` and `mesh web` as SEPARATE CLI processes
// (one binary, two commands) and drives the browser against the web tier — proving the
// SPA + REST + live WS all work across the proxy boundary. Run:
//   bun run src/web/split-cli.e2e.ts
import { authedContext, launchChromium, provisionE2eAuth } from "./e2e-playwright";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";

const API_PORT = Number(process.env.API_PORT) || 7350;
const WEB_PORT = Number(process.env.WEB_PORT) || 7351;
const WEB = `http://localhost:${WEB_PORT}`;
const SHOTS = "/tmp/mesh-shots";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });

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
async function waitReady(url: string, token: string) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

const auth = await provisionE2eAuth();

// two separate processes from the one binary
const backend = Bun.spawn(["bun", "run", "src/main.ts", "backend", "--fake", "--port", String(API_PORT)], {
  stdout: "pipe",
  stderr: "pipe",
  env: auth.env,
});
const web = Bun.spawn(
  ["bun", "run", "src/main.ts", "web", "--port", String(WEB_PORT), "--backend", `http://localhost:${API_PORT}`],
  { stdout: "pipe", stderr: "pipe", env: auth.env },
);

const browser = await launchChromium();
try {
  const backOk = await waitReady(`http://localhost:${API_PORT}/api/state`, auth.token);
  const webOk = await waitReady(`${WEB}/api/state`, auth.token);
  console.log(`backend ready: ${backOk} · web ready: ${webOk}`);

  await step("backend has no SPA; web serves it", async () => {
    const b = await fetch(`http://localhost:${API_PORT}/`);
    if (b.status !== 404) throw new Error(`backend / should be 404, got ${b.status}`);
    const w = await fetch(`${WEB}/`);
    if (!(w.headers.get("content-type") ?? "").includes("text/html")) throw new Error("web / not html");
  });

  const ctx = await authedContext(browser, auth.token, { viewport: { width: 1440, height: 860 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(WEB, { waitUntil: "domcontentloaded" });

  await step("SPA loads through the web tier; ws connects (proxied)", async () => {
    await page.waitForSelector('.stat:has-text("live")', { timeout: 8000 }); // ws snapshot arrived via proxy
    await page.waitForSelector('.mrow:has-text("demo")', { timeout: 8000 });
  });

  await step("start mesh (POST proxied) → live deltas (WS proxied) flow", async () => {
    await page.locator('.detail-head .btn:has-text("start mesh")').click();
    await page.waitForSelector('.detail-head:has-text("running")', { timeout: 8000 });
    // a streamed router message proves live WS deltas traverse the proxy
    await page
      .locator(".conv-panel .msg.agent .bubble", { hasText: "implements the calculator core" })
      .first()
      .waitFor({ timeout: 12000 });
  });

  await page.screenshot({ path: `${SHOTS}/split-two-process.png`, fullPage: false });

  await step("no console/page errors", async () => {
    if (errors.length) throw new Error(`${errors.length}: ${errors.slice(0, 2).join(" || ")}`);
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  SPLIT-CLI E2E OK — two processes, browser drove the proxy end-to-end");
  }
} finally {
  await browser.close();
  backend.kill();
  web.kill();
  await rm(auth.meshRootBase, { recursive: true, force: true });
}
