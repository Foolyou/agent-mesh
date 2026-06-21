// Step 6 — Playwright smoke + screenshots for the guarded /__ui-mockup application
// shell mockup. Boots --fake with MESH_UI_PREVIEW=1, then: mounts the guarded route,
// loads a ?device=mobile deep link, performs a view-switch interaction (运行态→看板),
// asserts the live compose() tokens, and captures desktop + mobile (+ one accent
// comparison) frame screenshots (≤1500px wide). Run: `bun run src/web/ui-mockup.e2e.ts`.
import { type Page } from "playwright";
import { launchChromium, provisionE2eAuth, authedReady } from "./e2e-playwright";
import { compose } from "./client/themes";
import { mkdirSync } from "node:fs";

const PORT = Number(process.env.E2E_PORT) || 7473;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.AGENT_MESH_ARTIFACTS || "/tmp/mesh-mockup-shots";
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

const auth = await provisionE2eAuth({ MESH_UI_PREVIEW: "1" });
const server = Bun.spawn(["bun", "run", "src/main.ts", "run", "--fake", "--port", String(PORT)], { stdout: "pipe", stderr: "pipe", env: auth.env });
const browser = await launchChromium();
const shots: string[] = [];
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await authedReady(BASE, auth.token)).ok) break;
    } catch {}
    await sleep(250);
  }
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page: Page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  const cssVar = (n: string) => page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), n);
  const shotFrame = async (file: string) => {
    await page.locator('[data-mockup="frame"]').screenshot({ path: file });
    shots.push(file);
  };

  await step("guarded /__ui-mockup mounts the desktop shell", async () => {
    await page.goto(`${BASE}/__ui-mockup`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-device="desktop"]', { timeout: 8000 });
    if (await page.locator('[aria-label="meshes"]').count() !== 1) throw new Error("left nav missing");
  });

  await step("adaptive topbar: nav expanded → mesh LABEL (no select); collapsed → SELECT", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-device="desktop"]', { timeout: 8000 });
    if (await page.locator('[data-topbar-mesh="label"]').count() !== 1) throw new Error("expanded nav should show a mesh label");
    if (await page.locator('[data-topbar-mesh="select"]').count() !== 0) throw new Error("expanded nav must NOT show a topbar select");
    await page.getByRole("button", { name: "收起导航" }).click();
    await sleep(120);
    if (await page.locator('[data-topbar-mesh="select"]').count() !== 1) throw new Error("collapsed nav should show the topbar select");
    if (await page.locator('[data-topbar-mesh="label"]').count() !== 0) throw new Error("collapsed nav must NOT show the label");
  });

  await step("collapsed nav is fully hidden (no rail / no status dots) with a floating expand button", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-device="desktop"]', { timeout: 8000 });
    const dotsExpanded = await page.locator('[data-mockup="frame"]').getByRole("img").count();
    if (dotsExpanded === 0) throw new Error("expanded nav should have status dots (sanity)");
    await page.getByRole("button", { name: "收起导航" }).click();
    await sleep(120);
    if (await page.locator('[aria-label="meshes"]').count() !== 0) throw new Error("collapsed: left nav must be gone");
    if (await page.locator('[data-mockup="frame"]').getByRole("img").count() !== 0) throw new Error("collapsed: no status dots allowed");
    if (await page.locator('[data-nav-expand]').count() !== 1) throw new Error("collapsed: floating expand button missing");
    await page.locator('[data-nav-expand]').click();
    await sleep(120);
    if (await page.locator('[aria-label="meshes"]').count() !== 1) throw new Error("expand button should restore the left nav");
  });

  await step("left nav is the primary mesh switcher (real link rows change the active mesh)", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-topbar-mesh="label"]', { timeout: 8000 });
    await page.locator('[aria-label="meshes"]').getByRole("link", { name: "alpha" }).click();
    await sleep(120);
    const label = (await page.locator('[data-topbar-mesh="label"]').innerText()).trim();
    if (!label.includes("alpha")) throw new Error(`topbar label did not follow nav selection: ${label}`);
  });

  await step("?device=mobile deep link renders the mobile shell + bottom tabs", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=mobile`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-device="mobile"]', { timeout: 8000 });
    if (await page.getByRole("tab").count() !== 3) throw new Error("expected 3 bottom tabs");
    await page.getByRole("tab", { name: "更多" }).click();
    await sleep(80);
    if (await page.getByText("设置 · 主题").count() === 0) throw new Error("更多 sheet did not show management/settings");
  });

  await step("view switch interaction 运行态→看板 swaps the stage", async () => {
    await page.goto(`${BASE}/__ui-mockup`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"]', { timeout: 8000 });
    if (await page.getByText("运行态 视图占位").count() === 0) throw new Error("runtime stage not shown initially");
    await page.locator('[aria-label="View"]').getByRole("radio", { name: "看板" }).click();
    await sleep(120);
    if (await page.getByText("看板 视图占位").count() === 0) throw new Error("board stage not shown after switch");
  });

  await step("live compose() tokens applied to :root (default Dark·Slate × Signal Teal)", async () => {
    const expected = compose("dark-slate", "signal-teal");
    if ((await cssVar("--surface")) !== expected.surface) throw new Error(`--surface=${await cssVar("--surface")}`);
    if ((await cssVar("--accent")) !== expected.accent) throw new Error(`--accent=${await cssVar("--accent")}`);
  });

  // ── runtime view (A) ──────────────────────────────────────────────────────────
  await step("runtime A desktop overview: topology of agents; node → focus interaction", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=desktop&surface=runtime&runtime=overview`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-runtime="overview"]', { timeout: 8000 });
    if (await page.getByText("Topology · 全体 agent").count() === 0) throw new Error("topology overview missing");
    if (await page.locator('[data-runtime="overview"]').getByRole("link", { name: "codex-1" }).count() === 0) throw new Error("agent node link missing");
    await page.locator('[data-runtime="overview"]').getByRole("link", { name: "codex-1" }).first().click();
    await page.waitForSelector('[data-runtime="focus"]', { timeout: 8000 });
  });

  await step("runtime A desktop focus: transcript + inline approval + composer + activity/mail", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=desktop&surface=runtime&runtime=focus`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-runtime="focus"]', { timeout: 8000 });
    if (await page.getByText("restart the alpha mesh").count() === 0) throw new Error("transcript fixture missing");
    if (await page.getByRole("button", { name: "Approve" }).count() === 0) throw new Error("inline ApprovalCard missing");
    if (await page.locator('[aria-label="Message composer"]').count() === 0) throw new Error("composer shell missing");
    if (await page.locator('[aria-label="context"]').getByText("mail").count() === 0) throw new Error("activity/mail context missing");
  });

  await step("runtime A mobile overview: agent card list with pending approvals pinned", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=mobile&surface=runtime&runtime=overview`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-device="mobile"] [data-runtime="overview"]', { timeout: 8000 });
    if (await page.getByText("待审批").count() === 0) throw new Error("pinned approvals section missing");
  });

  await step("runtime A mobile focus: approval pinned above transcript + composer", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=mobile&surface=runtime&runtime=focus`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-device="mobile"] [data-runtime="focus"]', { timeout: 8000 });
    if (await page.getByRole("button", { name: "Approve" }).count() === 0) throw new Error("pinned approval missing");
    if (await page.getByText("Transcript").count() === 0) throw new Error("transcript panel missing");
    if (await page.locator('[aria-label="Message composer"]').count() === 0) throw new Error("composer missing");
  });

  // ── board view (C) ──────────────────────────────────────────────────────────
  await step("board C desktop list: filter/bulk/epic groups/rich rows; row → detail interaction", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=desktop&surface=board&board=list`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-board="list"]', { timeout: 8000 });
    if (await page.locator('[aria-label="search issues"]').count() === 0) throw new Error("filter bar missing");
    if (await page.locator('[aria-label="select all"]').count() === 0) throw new Error("bulk toolbar missing");
    if (await page.getByText("Epic: Onboarding").count() === 0) throw new Error("epic group header missing");
    if (await page.getByText("Dispatch ▾").count() === 0) throw new Error("router dispatch entry missing");
    await page.getByRole("link", { name: "Add device-auth page" }).click();
    await page.waitForSelector('[data-board="detail"]', { timeout: 8000 });
  });

  await step("board C desktop detail: lifecycle path + timeline + deps + comment", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=desktop&surface=board&board=detail`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-board="detail"]', { timeout: 8000 });
    if (await page.getByText("activity timeline").count() === 0) throw new Error("activity timeline missing");
    if (await page.getByText("blocked-by").count() === 0) throw new Error("deps missing");
    if (await page.locator('[aria-label="Message composer"]').count() === 0) throw new Error("comment box missing");
  });

  await step("board C desktop kanban: 5 lifecycle columns + cards", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=desktop&surface=board&board=kanban`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-board="kanban"]', { timeout: 8000 });
    for (const col of ["todo", "in_progress", "in_review", "done", "cancelled"]) {
      if (await page.getByText(col, { exact: true }).count() === 0) throw new Error(`kanban column ${col} missing`);
    }
  });

  await step("board C mobile list + detail (kanban desktop-only)", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=mobile&surface=board&board=list`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-device="mobile"] [data-board="list"]', { timeout: 8000 });
    await page.goto(`${BASE}/__ui-mockup?device=mobile&surface=board&board=detail`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-device="mobile"] [data-board="detail"]', { timeout: 8000 });
    // kanban on mobile must degrade to the list
    await page.goto(`${BASE}/__ui-mockup?device=mobile&surface=board&board=kanban`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-device="mobile"] [data-board="list"]', { timeout: 8000 });
  });

  await step("screenshot desktop · expanded nav (dark-slate × signal-teal)", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=desktop&view=runtime&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-topbar-mesh="label"]', { timeout: 8000 });
    await sleep(150);
    await shotFrame(`${SHOTS}/shell-desktop-expanded-dark-slate-signal-teal.png`);
  });

  await step("screenshot desktop · collapsed nav (dark-slate × signal-teal)", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=desktop&view=runtime&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-device="desktop"]', { timeout: 8000 });
    await page.getByRole("button", { name: "收起导航" }).click();
    await page.waitForSelector('[data-topbar-mesh="select"]', { timeout: 8000 });
    await sleep(150);
    await shotFrame(`${SHOTS}/shell-desktop-collapsed-dark-slate-signal-teal.png`);
  });

  await step("screenshot mobile · dark-slate × signal-teal", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=mobile&view=runtime&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-device="mobile"]', { timeout: 8000 });
    await sleep(150);
    await shotFrame(`${SHOTS}/shell-mobile-dark-slate-signal-teal.png`);
  });

  // ── runtime (A) screenshots (default Dark·Slate × Signal Teal) ──────────────────
  const RUNTIME_SHOTS: [string, string][] = [
    ["device=desktop&surface=runtime&runtime=overview", "runtime-desktop-overview-dark-slate-signal-teal.png"],
    ["device=desktop&surface=runtime&runtime=focus", "runtime-desktop-focus-dark-slate-signal-teal.png"],
    ["device=mobile&surface=runtime&runtime=overview", "runtime-mobile-list-dark-slate-signal-teal.png"],
    ["device=mobile&surface=runtime&runtime=focus", "runtime-mobile-focus-dark-slate-signal-teal.png"],
  ];
  for (const [q, file] of RUNTIME_SHOTS) {
    await step(`screenshot ${file}`, async () => {
      await page.goto(`${BASE}/__ui-mockup?${q}&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-mockup="frame"] [data-runtime]', { timeout: 8000 });
      await sleep(150);
      await shotFrame(`${SHOTS}/${file}`);
    });
  }

  // ── board (C) screenshots (default Dark·Slate × Signal Teal) ────────────────────
  const BOARD_SHOTS: [string, string][] = [
    ["device=desktop&surface=board&board=list", "board-desktop-list-dark-slate-signal-teal.png"],
    ["device=desktop&surface=board&board=detail", "board-desktop-detail-dark-slate-signal-teal.png"],
    ["device=desktop&surface=board&board=kanban", "board-desktop-kanban-dark-slate-signal-teal.png"],
    ["device=mobile&surface=board&board=list", "board-mobile-list-dark-slate-signal-teal.png"],
    ["device=mobile&surface=board&board=detail", "board-mobile-detail-dark-slate-signal-teal.png"],
  ];
  for (const [q, file] of BOARD_SHOTS) {
    await step(`screenshot ${file}`, async () => {
      await page.goto(`${BASE}/__ui-mockup?${q}&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-mockup="frame"] [data-board]', { timeout: 8000 });
      await sleep(150);
      await shotFrame(`${SHOTS}/${file}`);
    });
  }

  await step("no page errors across the mockup", async () => {
    if (errors.length) throw new Error(errors.slice(0, 3).join(" | "));
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(`\nMOCKUP E2E: ${pass} passed, ${fails.length} failed`);
console.log(`screenshots (${shots.length}) → ${SHOTS}`);
if (fails.length) {
  console.log("FAILED:", fails.join("; "));
  process.exit(1);
}
console.log("MOCKUP E2E OK");
