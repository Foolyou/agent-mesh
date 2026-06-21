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

  // ── shell (01) states (Phase B) ─────────────────────────────────────────────
  await step("shell empty: no-mesh empty state + New mesh", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=shell&state=empty`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"]', { timeout: 8000 });
    if (await page.getByText("No meshes yet").count() === 0) throw new Error("empty state missing");
  });
  await step("shell offline: offline chip + reconnecting banner + disabled mgmt", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=shell&state=offline`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"]', { timeout: 8000 });
    if (await page.getByText("正在重连", { exact: false }).count() === 0) throw new Error("reconnecting banner missing");
    if (!(await page.getByRole("button", { name: "管理▾" }).isDisabled())) throw new Error("management should be disabled offline");
  });
  await step("shell permission: unauthorized banner + disabled management", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=shell&state=permission`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"]', { timeout: 8000 });
    if (await page.getByText("设备未授权", { exact: false }).count() === 0) throw new Error("permission banner missing");
  });
  await step("shell boundary: long mesh name + 99+ notif overflow", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=shell&state=boundary`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"]', { timeout: 8000 });
    if (await page.getByText("a-very-long-mesh-name-that-should-truncate-gracefully").count() === 0) throw new Error("long mesh name missing");
    if (await page.getByText("99+", { exact: false }).count() === 0) throw new Error("badge overflow missing");
  });

  // ── app-shell补漏 — pagination (#19) + reload (#20) ────────────────────────────
  await step("app-shell补漏 desktop: ↻ reload two-click confirm in the left nav", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=shell&state=populated&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[aria-label="meshes"]', { timeout: 8000 });
    const reload = page.locator('[aria-label="重新加载 mesh 定义"]');
    if (await reload.count() === 0) throw new Error("reload button missing");
    await reload.click(); // arms (first click)
    await sleep(80);
    // armed → aria-pressed=true + label text swaps to 确认? (aria-label keeps the name)
    if (await page.locator('[aria-label="重新加载 mesh 定义"][aria-pressed="true"]').count() === 0) throw new Error("reload did not arm two-click confirm");
    if (await reload.innerText() !== "确认?") throw new Error("armed label did not swap to 确认?");
  });

  await step("app-shell补漏 desktop: mesh-list pagination pages through (boundary, 4/page)", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=shell&state=boundary&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-mesh-pagination]", { timeout: 8000 });
    if (await page.getByText("1 / 4", { exact: true }).count() === 0) throw new Error("page indicator missing");
    await page.locator('[aria-label="下一页 mesh"]').click();
    await sleep(80);
    if (await page.getByText("2 / 4", { exact: true }).count() === 0) throw new Error("pagination did not advance");
    // populated (4 meshes) shows no pager
    await page.goto(`${BASE}/__ui-mockup?surface=shell&state=populated&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[aria-label="meshes"]', { timeout: 8000 });
    if (await page.locator("[data-mesh-pagination]").count() !== 0) throw new Error("single page must not show a pager");
  });

  await step("app-shell补漏 mobile: ↻ reload in the 更多 sheet", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=mobile&surface=shell&state=populated`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-device="mobile"]', { timeout: 8000 });
    await page.getByRole("tab", { name: "更多" }).click();
    await sleep(80);
    if (await page.locator('[aria-label="重新加载 mesh 定义"]').count() === 0) throw new Error("mobile reload entry missing in 更多 sheet");
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

  // ── runtime补漏 — audited [E] capabilities (audit #9–#18) ──────────────────────
  await step("runtime focus补漏: selectors + context/health + queue + expanders + ⊞ full → fullscreen", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=runtime&runtime=focus&state=populated&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-runtime="focus"]', { timeout: 8000 });
    for (const lbl of ["agent mode", "agent model", "agent effort", "kimi thinking", "prev queued", "load older", "jump to bottom", "enter fullscreen"]) {
      if (await page.locator(`[aria-label="${lbl}"]`).count() === 0) throw new Error(`runtime control missing: ${lbl}`);
    }
    if (await page.locator("[data-context-usage]").count() === 0) throw new Error("context/health usage missing");
    if (await page.locator("[data-queue]").count() === 0) throw new Error("pending-turn queue missing");
    if (await page.locator("[data-transcript-expanders]").count() === 0) throw new Error("transcript expanders missing");
    // ⊞ full navigates to the standalone fullscreen frame
    await page.locator('[aria-label="enter fullscreen"]').click();
    await page.waitForSelector('[data-mockup="frame"][data-runtime="full"]', { timeout: 8000 });
    if (await page.locator('[aria-label="exit fullscreen"]').count() === 0) throw new Error("⊟ exit missing in fullscreen");
  });

  await step("runtime overview补漏: start strategy + add agent/edge + new-all + wake cold; ⤢ → canvas", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=runtime&runtime=overview&state=populated&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-runtime="overview"]', { timeout: 8000 });
    for (const lbl of ["start strategy", "add agent", "add edge", "new all sessions", "wake kimi-cold", "open topology canvas"]) {
      if (await page.locator(`[aria-label="${lbl}"]`).count() === 0) throw new Error(`overview op missing: ${lbl}`);
    }
    await page.locator('[aria-label="open topology canvas"]').click();
    await page.waitForSelector('[data-mockup="frame"][data-runtime="canvas"]', { timeout: 8000 });
    if (await page.locator("[data-canvas-window]").count() === 0) throw new Error("canvas windows missing");
    for (const lbl of ["stop codex-1", "wake kimi-cold", "codex-1 actions", "close canvas", "zoom in"]) {
      if (await page.locator(`[aria-label="${lbl}"]`).count() === 0) throw new Error(`canvas control missing: ${lbl}`);
    }
  });

  await step("navigation index skeleton: surfaces + deep links; link → surface", async () => {
    await page.goto(`${BASE}/__ui-mockup?index=1`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-mockup-index]", { timeout: 8000 });
    for (const t of ["01 · 应用外壳", "02 · 运行态 A", "03 · 看板 C", "04 · 新建 mesh"]) {
      if (await page.getByText(t, { exact: false }).count() === 0) throw new Error(`index section missing: ${t}`);
    }
    // a runtime canvas deep link is listed and navigates to the canvas frame
    await page.locator('[data-mockup-index] a[href*="runtime=canvas"]').first().click();
    await page.waitForSelector('[data-mockup="frame"][data-runtime="canvas"]', { timeout: 8000 });
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

  // ── runtime (A) state × mode × device screenshots (Phase B; Dark·Slate × Signal Teal) ──
  const RUNTIME_STATES = ["empty", "loading", "populated", "error", "permission", "busy", "offline", "boundary"];
  for (const device of ["desktop", "mobile"]) {
    for (const rmode of ["overview", "focus"]) {
      for (const st of RUNTIME_STATES) {
        await step(`screenshot runtime-${rmode}-${st}-${device}`, async () => {
          await page.goto(`${BASE}/__ui-mockup?surface=runtime&runtime=${rmode}&state=${st}&device=${device}&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
          await page.waitForSelector(`[data-mockup="frame"][data-device="${device}"] [data-runtime]`, { timeout: 8000 });
          await sleep(140);
          await shotFrame(`${SHOTS}/runtime-${rmode}-${st}-${device}-dark-slate-signal-teal.png`);
        });
      }
    }
  }

  // ── runtime补漏 full / canvas standalone frames (desktop-only) × key states ──
  const RT_FRAME_STATES = ["populated", "boundary", "permission", "offline", "empty", "loading", "error"];
  for (const sub of ["full", "canvas"]) {
    const states = sub === "canvas" ? ["populated", "boundary", "permission", "offline"] : RT_FRAME_STATES;
    for (const st of states) {
      await step(`screenshot runtime-${sub}-${st}-desktop`, async () => {
        await page.goto(`${BASE}/__ui-mockup?surface=runtime&runtime=${sub}&state=${st}&device=desktop&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(`[data-mockup="frame"][data-runtime="${sub}"]`, { timeout: 8000 });
        await sleep(140);
        await shotFrame(`${SHOTS}/runtime-${sub}-${st}-desktop-dark-slate-signal-teal.png`);
      });
    }
  }

  // ── navigation index skeleton screenshot (full page, not a single frame) ──
  await step("screenshot mockup-index", async () => {
    await page.goto(`${BASE}/__ui-mockup?index=1&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-mockup-index]", { timeout: 8000 });
    await sleep(150);
    const file = `${SHOTS}/mockup-index-dark-slate-signal-teal.png`;
    await page.locator("[data-mockup-index]").screenshot({ path: file });
    shots.push(file);
  });

  // ── board (C) subview × state × device screenshots (Phase B; Dark·Slate × Signal Teal) ──
  // Desktop: list/detail/kanban. Mobile: list/detail (kanban degrades to list).
  const BOARD_STATES = ["empty", "loading", "populated", "error", "permission", "busy", "offline", "boundary"];
  const BOARD_SUBS: Record<string, string[]> = { desktop: ["list", "detail", "kanban"], mobile: ["list", "detail"] };
  for (const device of ["desktop", "mobile"]) {
    for (const sub of BOARD_SUBS[device]) {
      for (const st of BOARD_STATES) {
        await step(`screenshot board-${sub}-${st}-${device}`, async () => {
          await page.goto(`${BASE}/__ui-mockup?surface=board&board=${sub}&state=${st}&device=${device}&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
          await page.waitForSelector(`[data-mockup="frame"][data-device="${device}"] [data-board]`, { timeout: 8000 });
          await sleep(130);
          await shotFrame(`${SHOTS}/board-${sub}-${st}-${device}-dark-slate-signal-teal.png`);
        });
      }
    }
  }

  // ── new-mesh (04) builder: assertions + state × device screenshots (loading N/A; offline covered) ──
  await step("new-mesh builder: form present; error validation; permission disables", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=new-mesh&state=populated`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"] [data-newmesh="builder"], [data-mockup="frame"][data-newmesh="builder"]', { timeout: 8000 });
    if (await page.locator('[aria-label="mesh name"]').count() === 0) throw new Error("mesh name field missing");
    await page.goto(`${BASE}/__ui-mockup?surface=new-mesh&state=error`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-newmesh="builder"]', { timeout: 8000 });
    if (await page.getByText("already exists", { exact: false }).count() === 0) throw new Error("dup-name validation missing");
    await page.goto(`${BASE}/__ui-mockup?surface=new-mesh&state=permission`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-newmesh="builder"]', { timeout: 8000 });
    if (await page.getByText("设备未授权", { exact: false }).count() === 0) throw new Error("permission banner missing");
    await page.goto(`${BASE}/__ui-mockup?surface=new-mesh&state=offline`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-newmesh="builder"]', { timeout: 8000 });
    if (await page.getByText("正在重连", { exact: false }).count() === 0) throw new Error("offline banner missing");
    if (!(await page.getByRole("textbox", { name: "mesh name" }).isDisabled())) throw new Error("mesh name should be disabled offline");
  });
  await step("new-mesh builder: per-agent controls + auto-compact + edge steer + expanded editor", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=new-mesh&state=populated&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-newmesh="builder"]', { timeout: 8000 });
    for (const lbl of ["agent 1 instructions", "agent 1 model", "agent 1 effort", "agent 1 lazy", "agent 3 opencode permission", "auto-compact threshold", "edge 1 steer"]) {
      if (await page.locator(`[aria-label="${lbl}"]`).count() === 0) throw new Error(`control missing: ${lbl}`);
    }
    await page.goto(`${BASE}/__ui-mockup?surface=new-mesh&state=populated&nmEditor=charter&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-newmesh-editor="charter"][role="dialog"]', { timeout: 8000 });
  });
  const NM_STATES = ["empty", "populated", "error", "permission", "busy", "offline", "boundary"];
  for (const device of ["desktop", "mobile"]) {
    for (const st of NM_STATES) {
      await step(`screenshot new-mesh-${st}-${device}`, async () => {
        await page.goto(`${BASE}/__ui-mockup?surface=new-mesh&state=${st}&device=${device}&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(`[data-mockup="frame"][data-device="${device}"][data-newmesh="builder"]`, { timeout: 8000 });
        await sleep(130);
        await shotFrame(`${SHOTS}/new-mesh-${st}-${device}-dark-slate-signal-teal.png`);
      });
    }
  }
  // expanded text editor: charter (desktop modal) + instructions (mobile sheet)
  for (const [q, file] of [
    ["surface=new-mesh&state=populated&nmEditor=charter&device=desktop", "new-mesh-editor-charter-desktop-dark-slate-signal-teal.png"],
    ["surface=new-mesh&state=populated&nmEditor=instructions&device=mobile", "new-mesh-editor-instructions-mobile-dark-slate-signal-teal.png"],
  ] as [string, string][]) {
    await step(`screenshot ${file}`, async () => {
      await page.goto(`${BASE}/__ui-mockup?${q}&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-newmesh-editor]', { timeout: 8000 });
      await sleep(130);
      await shotFrame(`${SHOTS}/${file}`);
    });
  }

  // ── shell (01) state × device screenshots (Phase B; default Dark·Slate × Signal Teal) ──
  const SHELL_STATES = ["empty", "loading", "populated", "error", "permission", "busy", "offline", "boundary"];
  for (const device of ["desktop", "mobile"]) {
    for (const st of SHELL_STATES) {
      await step(`screenshot app-shell-${st}-${device}`, async () => {
        await page.goto(`${BASE}/__ui-mockup?surface=shell&state=${st}&device=${device}&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(`[data-mockup="frame"][data-device="${device}"]`, { timeout: 8000 });
        await sleep(150);
        await shotFrame(`${SHOTS}/app-shell-${st}-${device}-dark-slate-signal-teal.png`);
      });
    }
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
