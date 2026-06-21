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

  await step("runtime A desktop focus: transcript + docked approval bar + composer + activity/mail", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=desktop&surface=runtime&runtime=focus`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-runtime="focus"]', { timeout: 8000 });
    if (await page.getByText("restart the alpha mesh").count() === 0) throw new Error("transcript fixture missing");
    // C2: approval is a docked bar (not inline), with a FIFO queue count, above the composer.
    if (await page.locator("[data-approval-bar]").count() === 0) throw new Error("docked approval bar missing");
    if (await page.getByRole("button", { name: "Approve" }).count() === 0) throw new Error("oldest ApprovalCard missing");
    if (await page.locator("[data-approval-queue]").count() === 0) throw new Error("FIFO queue count missing");
    if (await page.locator('[aria-label="Message composer"]').count() === 0) throw new Error("composer shell missing");
    if (await page.locator('[aria-label="context"]').getByText("mail").count() === 0) throw new Error("activity/mail context missing");
    if (await page.locator("[data-context-approvals]").count() === 0) throw new Error("right-context approval-queue badge missing");
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

  // ── board补漏 — audited [E] capabilities (audit #22–#25) ────────────────────────
  await step("board list补漏: group-by-epic + create epic/task + reopen terminal + 管理标签 toggle → manager", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=board&board=list&state=populated&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-board="list"]', { timeout: 8000 });
    for (const lbl of ["group by epic", "new epic", "new task", "reopen #7", "reopen #5", "管理标签", "全屏"]) {
      if (await page.locator(`[aria-label="${lbl}"]`).count() === 0) throw new Error(`board control missing: ${lbl}`);
    }
    // 管理标签 toggle opens the CRUD/palette manager
    await page.locator('[data-board-manage-labels]').click();
    await page.waitForSelector("[data-board-labels]", { timeout: 8000 });
    for (const lbl of ["new label name", "add label", "rename auth", "recolor auth", "delete auth"]) {
      if (await page.locator(`[aria-label="${lbl}"]`).count() === 0) throw new Error(`label manager control missing: ${lbl}`);
    }
    if (await page.locator("[data-palette]").first().getByRole("button").count() === 0) throw new Error("palette swatches missing");
  });

  await step("board补漏: 🗖 fullscreen → standalone board frame with 🗕 exit", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=board&board=list&state=populated&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-board="list"]', { timeout: 8000 });
    await page.locator('[data-board-fs]').first().click();
    await page.waitForSelector('[data-mockup="frame"][data-board-fs="1"]', { timeout: 8000 });
    if (await page.locator('[aria-label="退出全屏"]').count() === 0) throw new Error("🗕 exit missing in board fullscreen");
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

  // ── board补漏 desktop screenshots: fullscreen (list/kanban) + label manager ──
  for (const [q, file] of [
    ["surface=board&board=list&state=populated&boardFs=1&device=desktop", "board-list-fullscreen-populated-desktop-dark-slate-signal-teal.png"],
    ["surface=board&board=kanban&state=boundary&boardFs=1&device=desktop", "board-kanban-fullscreen-boundary-desktop-dark-slate-signal-teal.png"],
    ["surface=board&board=list&state=populated&boardManage=1&device=desktop", "board-list-manage-labels-populated-desktop-dark-slate-signal-teal.png"],
  ] as [string, string][]) {
    await step(`screenshot ${file}`, async () => {
      await page.goto(`${BASE}/__ui-mockup?${q}&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-mockup="frame"] [data-board], [data-mockup="frame"][data-board-fs="1"]', { timeout: 8000 });
      await sleep(140);
      await shotFrame(`${SHOTS}/${file}`);
    });
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

  // ── Mesh Assistant (05): assertions + state × device screenshots + fullscreen ──
  await step("assistant: chat + tool-call card + delete confirm + composer + ⊞ full → fullscreen", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=assistant&state=populated&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-assistant="chat"]', { timeout: 8000 });
    if (await page.locator("[data-assistant-tool]").count() === 0) throw new Error("tool-call card missing");
    // C2: delete-confirm is in a docked approval bar (composer-adjacent), not inline.
    if (await page.locator("[data-approval-bar]").count() === 0) throw new Error("docked approval bar missing");
    if (await page.getByRole("button", { name: "Delete" }).count() === 0) throw new Error("delete-confirm missing");
    if (await page.locator('[aria-label="Message composer"]').count() === 0) throw new Error("composer missing");
    if (await page.locator('[data-assistant-p2p]').count() === 0) throw new Error("p2p DM entry missing");
    await page.locator('[aria-label="全屏"]').click();
    await page.waitForSelector('[data-mockup="frame"][data-assistant-fs="1"]', { timeout: 8000 });
    if (await page.locator('[aria-label="退出全屏"]').count() === 0) throw new Error("⊟ exit missing in assistant fullscreen");
  });
  await step("assistant: absent(error)→not-configured+enable (no composer); empty→suggestions", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=assistant&state=error&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-assistant="chat"]', { timeout: 8000 });
    if (await page.getByText("未配置", { exact: false }).count() === 0) throw new Error("not-configured missing");
    if (await page.locator('[aria-label="Message composer"]').count() !== 0) throw new Error("absent must hide composer");
    await page.goto(`${BASE}/__ui-mockup?surface=assistant&state=empty&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-assistant-suggestions]", { timeout: 8000 });
  });
  const ASSISTANT_STATES = ["empty", "loading", "populated", "error", "permission", "busy", "offline", "boundary"];
  for (const device of ["desktop", "mobile"]) {
    for (const st of ASSISTANT_STATES) {
      await step(`screenshot assistant-${st}-${device}`, async () => {
        await page.goto(`${BASE}/__ui-mockup?surface=assistant&state=${st}&device=${device}&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(`[data-mockup="frame"][data-device="${device}"][data-assistant="chat"]`, { timeout: 8000 });
        await sleep(130);
        await shotFrame(`${SHOTS}/assistant-${st}-${device}-dark-slate-signal-teal.png`);
      });
    }
  }
  await step("screenshot assistant-fullscreen-populated-desktop", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=assistant&state=populated&asstFs=1&device=desktop&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-assistant-fs="1"]', { timeout: 8000 });
    await sleep(130);
    await shotFrame(`${SHOTS}/assistant-fullscreen-populated-desktop-dark-slate-signal-teal.png`);
  });

  // ── Harnesses (06): assertions + state × device screenshots ──
  await step("harnesses: rows + dual version + self-install + install progress + old-version restarts", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=harnesses&state=populated&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-harnesses="panel"]', { timeout: 8000 });
    if (await page.locator("[data-harness-row]").count() !== 4) throw new Error("expected 4 harness rows");
    for (const lbl of ["update codex", "reprobe claude", "copy install command for opencode", "open kimi docs", "restart dev-mesh/codex-1 after idle", "force restart dev-mesh/codex-1", "cancel restart alpha/claude-1", "close install progress"]) {
      if (await page.locator(`[aria-label="${lbl}"]`).count() === 0) throw new Error(`harness control missing: ${lbl}`);
    }
    if (await page.locator("[data-self-installer]").count() === 0) throw new Error("self-install guide missing");
    if (await page.locator("[data-old-agents]").count() === 0) throw new Error("old-version agents missing");
    // force restart is a two-click confirm
    await page.locator('[aria-label="force restart dev-mesh/codex-1"]').click();
    await sleep(80);
    if (await page.locator('[aria-label="force restart dev-mesh/codex-1"][aria-pressed="true"]').count() === 0) throw new Error("force restart did not arm two-click confirm");
  });
  await step("harnesses: error→interrupted install retry stream; loading→no rows", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=harnesses&state=error&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-harnesses="panel"]', { timeout: 8000 });
    if (await page.locator('[aria-label="retry stream"]').count() === 0) throw new Error("retry stream missing in error");
    await page.goto(`${BASE}/__ui-mockup?surface=harnesses&state=loading&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-harnesses="panel"]', { timeout: 8000 });
    if (await page.locator("[data-harness-row]").count() !== 0) throw new Error("loading must not show harness rows");
  });
  const HARNESS_STATES = ["loading", "populated", "error", "permission", "busy", "offline", "boundary"];
  for (const device of ["desktop", "mobile"]) {
    for (const st of HARNESS_STATES) {
      await step(`screenshot harnesses-${st}-${device}`, async () => {
        await page.goto(`${BASE}/__ui-mockup?surface=harnesses&state=${st}&device=${device}&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(`[data-mockup="frame"][data-device="${device}"][data-harnesses="panel"]`, { timeout: 8000 });
        await sleep(130);
        await shotFrame(`${SHOTS}/harnesses-${st}-${device}-dark-slate-signal-teal.png`);
      });
    }
  }

  // ── Channels (07): assertions + state × device screenshots ──
  await step("channels: status + bindings + pending approve/revoke + allowSenders registry", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=channels&state=populated&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-channels="panel"]', { timeout: 8000 });
    for (const sel of ["[data-channel-status]", "[data-bindings]", "[data-pending-senders]", "[data-authorized-senders]", "[data-channel-enroll]"]) {
      if (await page.locator(sel).count() === 0) throw new Error(`channels section missing: ${sel}`);
    }
    for (const lbl of ["bind chat to mesh", "sync feishu groups", "approve sender ou_77c…e2", "revoke pending ou_77c…e2", "revoke sender ou_me…01"]) {
      if (await page.locator(`[aria-label="${lbl}"]`).count() === 0) throw new Error(`channels control missing: ${lbl}`);
    }
  });
  await step("channels: busy→provision QR card; mobile→read-only status + inbox only", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=channels&state=busy&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-provision]", { timeout: 8000 });
    if (await page.locator('[aria-label="cancel provision"]').count() === 0) throw new Error("provision cancel missing");
    await page.goto(`${BASE}/__ui-mockup?surface=channels&state=populated&device=mobile`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-device="mobile"][data-channels="panel"]', { timeout: 8000 });
    if (await page.locator("[data-pending-senders]").count() === 0) throw new Error("mobile inbox missing");
    if (await page.locator("[data-bindings]").count() !== 0) throw new Error("mobile must defer bindings to desktop");
  });
  const CHANNEL_STATES = ["empty", "loading", "populated", "error", "permission", "busy", "offline", "boundary"];
  for (const device of ["desktop", "mobile"]) {
    for (const st of CHANNEL_STATES) {
      await step(`screenshot channels-${st}-${device}`, async () => {
        await page.goto(`${BASE}/__ui-mockup?surface=channels&state=${st}&device=${device}&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(`[data-mockup="frame"][data-device="${device}"][data-channels="panel"]`, { timeout: 8000 });
        await sleep(130);
        await shotFrame(`${SHOTS}/channels-${st}-${device}-dark-slate-signal-teal.png`);
      });
    }
  }

  // ── Doctor / system (08): assertions + state × device screenshots ──
  await step("doctor: summary + findings(+fixHint) + daemon table + recovery reap/restart", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=doctor&state=populated&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-doctor="panel"]', { timeout: 8000 });
    for (const sel of ["[data-doctor-summary]", "[data-doctor-findings]", "[data-daemons]", "[data-recovery]", "[data-leak]"]) {
      if (await page.locator(sel).count() === 0) throw new Error(`doctor section missing: ${sel}`);
    }
    for (const lbl of ["copy diagnostics", "run doctor", "restart daemon dev-mesh", "reap scratch", "reap all orphans"]) {
      if (await page.locator(`[aria-label="${lbl}"]`).count() === 0) throw new Error(`doctor control missing: ${lbl}`);
    }
    if (await page.getByText("self-install: npm i -g opencode", { exact: false }).count() === 0) throw new Error("fixHint missing");
  });
  await step("doctor: permission locks surface; empty→none running; mobile→no recovery", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=doctor&state=permission&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-doctor="panel"]', { timeout: 8000 });
    if (await page.getByText("诊断已锁定", { exact: false }).count() === 0) throw new Error("permission lock missing");
    await page.goto(`${BASE}/__ui-mockup?surface=doctor&state=empty&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-doctor="panel"]', { timeout: 8000 });
    if (await page.getByText("none running", { exact: false }).count() === 0) throw new Error("none-running missing");
    await page.goto(`${BASE}/__ui-mockup?surface=doctor&state=populated&device=mobile`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-device="mobile"][data-doctor="panel"]', { timeout: 8000 });
    if (await page.locator("[data-recovery]").count() !== 0) throw new Error("mobile must defer recovery to desktop");
  });
  const DOCTOR_STATES = ["empty", "loading", "populated", "error", "permission", "busy", "offline", "boundary"];
  for (const device of ["desktop", "mobile"]) {
    for (const st of DOCTOR_STATES) {
      await step(`screenshot doctor-${st}-${device}`, async () => {
        await page.goto(`${BASE}/__ui-mockup?surface=doctor&state=${st}&device=${device}&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(`[data-mockup="frame"][data-device="${device}"][data-doctor="panel"]`, { timeout: 8000 });
        await sleep(130);
        await shotFrame(`${SHOTS}/doctor-${st}-${device}-dark-slate-signal-teal.png`);
      });
    }
  }

  // ── Settings (09): assertions + state × device screenshots ──
  await step("settings: appearance(mode/accent/palette) + language + prefs + device mgmt", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=settings&state=populated&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-settings="panel"]', { timeout: 8000 });
    for (const lbl of ["theme mode", "accent", "palette bg", "language", "default landing view", "default device", "approve device dev-3", "revoke device dev-2", "mint bootstrap token"]) {
      if (await page.locator(`[aria-label="${lbl}"]`).count() === 0) throw new Error(`settings control missing: ${lbl}`);
    }
    if (await page.locator("[data-custom-palette]").count() === 0) throw new Error("custom palette editor missing");
    // theme mode change applies live via compose()
    await page.locator('[aria-label="theme mode"]').getByRole("radio", { name: "Light·Cool" }).click();
    await sleep(120);
    const expected = compose("light-cool", "signal-teal");
    if ((await cssVar("--surface")) !== expected.surface) throw new Error("settings theme mode did not apply live");
  });
  await step("settings: error→invalid hex tolerated; permission→approve host-CLI; empty→this device only", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=settings&state=error&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-settings="panel"]', { timeout: 8000 });
    if (await page.getByText("无效 hex", { exact: false }).count() === 0) throw new Error("invalid-hex tolerance missing");
    await page.goto(`${BASE}/__ui-mockup?surface=settings&state=permission&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-settings="panel"]', { timeout: 8000 });
    if (!(await page.locator('[aria-label="approve device dev-3"]').isDisabled())) throw new Error("permission must disable approve (host-CLI authoritative)");
    await page.goto(`${BASE}/__ui-mockup?surface=settings&state=empty&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-settings="panel"]', { timeout: 8000 });
    if (await page.locator("[data-device-row]").count() !== 1) throw new Error("empty should show only this device");
  });
  await step("settings offline: default prefs disabled while theme mode stays enabled (matrix △)", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=settings&state=offline&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-settings="panel"]', { timeout: 8000 });
    if (await page.locator('[aria-label="default landing view"] button:disabled').count() === 0) throw new Error("offline must disable default landing view options");
    if (await page.locator('[aria-label="default device"] button:disabled').count() === 0) throw new Error("offline must disable default device options");
    if (await page.locator('[aria-label="theme mode"] button:disabled').count() !== 0) throw new Error("theme mode must stay enabled offline (local)");
  });
  const SETTINGS_STATES = ["empty", "loading", "populated", "error", "permission", "busy", "offline", "boundary"];
  for (const device of ["desktop", "mobile"]) {
    for (const st of SETTINGS_STATES) {
      await step(`screenshot settings-${st}-${device}`, async () => {
        await page.goto(`${BASE}/__ui-mockup?surface=settings&state=${st}&device=${device}&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(`[data-mockup="frame"][data-device="${device}"][data-settings="panel"]`, { timeout: 8000 });
        await sleep(130);
        await shotFrame(`${SHOTS}/settings-${st}-${device}-dark-slate-signal-teal.png`);
      });
    }
  }

  // ── Notifications center (10): assertions + state × device screenshots ──
  await step("notifications: list + classes + follow action → harnesses; mark read/all; history", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=notifications&state=populated&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-notifications="center"]', { timeout: 8000 });
    if (await page.locator("[data-notif]").count() === 0) throw new Error("no notifications rendered");
    if (await page.locator("[data-unread-dot]").count() === 0) throw new Error("unread indicator missing");
    for (const lbl of ["mark all read", "mark read n1", "刷新更新"]) {
      if (await page.locator(`[aria-label="${lbl}"]`).count() === 0) throw new Error(`notif control missing: ${lbl}`);
    }
    if (await page.getByText("历史 / 已读", { exact: false }).count() === 0) throw new Error("history section missing");
    // follow-action navigates to the harnesses surface
    await page.locator('[data-notif] a[href*="surface=harnesses"]').first().click();
    await page.waitForSelector('[data-mockup="frame"][data-harnesses="panel"]', { timeout: 8000 });
  });
  await step("notifications: empty→all-caught-up; offline→conn-lost + mark-read disabled", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=notifications&state=empty&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-notifications="center"]', { timeout: 8000 });
    if (await page.getByText("全部已读", { exact: false }).count() === 0) throw new Error("all-caught-up missing");
    await page.goto(`${BASE}/__ui-mockup?surface=notifications&state=offline&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-notifications="center"]', { timeout: 8000 });
    if (await page.locator("[data-conn-lost]").count() === 0) throw new Error("connection-lost notice missing");
    if (await page.locator('[aria-label="mark read n1"]:disabled').count() === 0) throw new Error("mark-read must be disabled offline");
    // permission: device-auth notice surfaces unread with a gated (disabled) mark-read
    await page.goto(`${BASE}/__ui-mockup?surface=notifications&state=permission&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-notifications="center"]', { timeout: 8000 });
    if (await page.locator('[aria-label="mark read n4"]:disabled').count() === 0) throw new Error("permission must gate the device-class mark-read");
    if (await page.locator('[aria-label="mark read n1"]:disabled').count() !== 0) throw new Error("permission must NOT disable non-device mark-read");
  });
  const NOTIF_STATES = ["empty", "loading", "populated", "error", "permission", "busy", "offline", "boundary"];
  for (const device of ["desktop", "mobile"]) {
    for (const st of NOTIF_STATES) {
      await step(`screenshot notifications-${st}-${device}`, async () => {
        await page.goto(`${BASE}/__ui-mockup?surface=notifications&state=${st}&device=${device}&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(`[data-mockup="frame"][data-device="${device}"][data-notifications="center"]`, { timeout: 8000 });
        await sleep(130);
        await shotFrame(`${SHOTS}/notifications-${st}-${device}-dark-slate-signal-teal.png`);
      });
    }
  }

  // ── File / artifact viewer (11): assertions + state × device screenshots + lightbox ──
  await step("file-viewer: md/code/image + back + pending tray; image → lightbox", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=artifact&state=populated&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-artifact="viewer"]', { timeout: 8000 });
    for (const sel of ['[data-artifact-back]', '[data-artifact-kind="markdown"]', '[data-artifact-kind="code"]', "[data-artifact-image]", "[data-pending-tray]", "[data-tray-thumb]"]) {
      if (await page.locator(sel).count() === 0) throw new Error(`artifact section missing: ${sel}`);
    }
    if (await page.locator('[aria-label="attach image"]').count() === 0) throw new Error("attach control missing");
    // inline image opens the lightbox overlay
    await page.locator('[data-artifact-image]').first().click();
    await page.waitForSelector("[data-artifact-lightbox]", { timeout: 8000 });
    if (await page.locator('[aria-label="close lightbox"]').count() === 0) throw new Error("lightbox close missing");
  });
  await step("file-viewer: error 404 + back; permission 401; offline alt + attach disabled", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=artifact&state=error&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-artifact="viewer"]', { timeout: 8000 });
    if (await page.getByText("File not found", { exact: false }).count() === 0) throw new Error("404 error missing");
    await page.goto(`${BASE}/__ui-mockup?surface=artifact&state=permission&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-artifact="viewer"]', { timeout: 8000 });
    if (await page.getByText("Not permitted", { exact: false }).count() === 0) throw new Error("401 not-permitted missing");
    await page.goto(`${BASE}/__ui-mockup?surface=artifact&state=offline&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-artifact="viewer"]', { timeout: 8000 });
    if (await page.locator('[data-artifact-image="alt"]').count() === 0) throw new Error("offline alt image missing");
    if (await page.locator('[aria-label="attach image"]:disabled').count() === 0) throw new Error("attach must be disabled offline");
  });
  const ARTIFACT_STATES = ["empty", "loading", "populated", "error", "permission", "busy", "offline", "boundary"];
  for (const device of ["desktop", "mobile"]) {
    for (const st of ARTIFACT_STATES) {
      await step(`screenshot artifact-${st}-${device}`, async () => {
        await page.goto(`${BASE}/__ui-mockup?surface=artifact&state=${st}&device=${device}&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(`[data-mockup="frame"][data-device="${device}"][data-artifact="viewer"]`, { timeout: 8000 });
        await sleep(130);
        await shotFrame(`${SHOTS}/artifact-${st}-${device}-dark-slate-signal-teal.png`);
      });
    }
  }
  for (const device of ["desktop", "mobile"]) {
    await step(`screenshot artifact-lightbox-${device}`, async () => {
      await page.goto(`${BASE}/__ui-mockup?surface=artifact&state=populated&lb=1&device=${device}&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(`[data-mockup="frame"][data-device="${device}"] [data-artifact-lightbox]`, { timeout: 8000 });
      await sleep(130);
      await shotFrame(`${SHOTS}/artifact-lightbox-${device}-dark-slate-signal-teal.png`);
    });
  }

  // ── Device-auth gate (12): assertions + state × device screenshots ──
  await step("device-auth: base pending = device code + host-CLI approve + poll + bootstrap + deep link", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=device-auth&state=permission&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-device-auth="gate"]', { timeout: 8000 });
    for (const sel of ["[data-device-code]", "[data-bootstrap]", "[data-remembered]"]) {
      if (await page.locator(sel).count() === 0) throw new Error(`device-auth section missing: ${sel}`);
    }
    if (await page.locator('[aria-label="bootstrap token"]').count() === 0) throw new Error("bootstrap field missing");
    if (await page.locator('[aria-label="submit bootstrap token"]').count() === 0) throw new Error("bootstrap submit missing");
    if (await page.getByText("mesh approve", { exact: false }).count() === 0) throw new Error("host-CLI approve instruction missing");
    if (await page.getByText("loopback 不受信", { exact: false }).count() === 0) throw new Error("security footer missing");
  });
  await step("device-auth: error=expired+refresh; offline=service-unavailable+bootstrap disabled; empty=N/A", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=device-auth&state=error&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-device-auth="gate"]', { timeout: 8000 });
    if (await page.locator('[aria-label="refresh device code"]').count() === 0) throw new Error("expiry refresh missing");
    await page.goto(`${BASE}/__ui-mockup?surface=device-auth&state=offline&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-device-auth="gate"]', { timeout: 8000 });
    if (await page.getByText("服务不可用", { exact: false }).count() === 0) throw new Error("service-unavailable message missing");
    if (await page.locator('[aria-label="bootstrap token"]:disabled').count() === 0) throw new Error("bootstrap must be disabled offline");
    await page.goto(`${BASE}/__ui-mockup?surface=device-auth&state=empty&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-device-auth="gate"]', { timeout: 8000 });
    if (await page.locator("[data-device-auth-na]").count() === 0) throw new Error("empty must render an N/A explanation");
    if (await page.locator("[data-device-code]").count() !== 0) throw new Error("N/A must not render a real gate code");
  });
  const DEVAUTH_STATES = ["loading", "permission", "error", "busy", "offline", "boundary"];
  for (const device of ["desktop", "mobile"]) {
    for (const st of DEVAUTH_STATES) {
      await step(`screenshot device-auth-${st}-${device}`, async () => {
        await page.goto(`${BASE}/__ui-mockup?surface=device-auth&state=${st}&device=${device}&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(`[data-mockup="frame"][data-device="${device}"][data-device-auth="gate"]`, { timeout: 8000 });
        await sleep(130);
        await shotFrame(`${SHOTS}/device-auth-${st}-${device}-dark-slate-signal-teal.png`);
      });
    }
  }

  // ── Global states (13): assertions + state × device screenshots ──
  await step("global: connected demo + full contract catalog; 401 demo → device-auth gate", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=global&state=populated&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-global="states"]', { timeout: 8000 });
    if (await page.locator("[data-global-contracts]").count() === 0) throw new Error("contract catalog missing");
    for (const t of ["Boot / connection probe", "WS connect / snapshot-first", "Gate 401 → device-auth", "SPA 404 / unknown route", "Offline contract"]) {
      if (await page.getByText(t, { exact: false }).count() === 0) throw new Error(`contract missing: ${t}`);
    }
    await page.goto(`${BASE}/__ui-mockup?surface=global&state=permission&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-401-redirect]", { timeout: 8000 });
    await page.locator('[data-401-redirect] a[href*="surface=device-auth"]').first().click();
    await page.waitForSelector('[data-mockup="frame"][data-device-auth="gate"]', { timeout: 8000 });
  });
  await step("global: empty=SPA 404; offline=reconnect + last-known", async () => {
    await page.goto(`${BASE}/__ui-mockup?surface=global&state=empty&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-global="states"]', { timeout: 8000 });
    if (await page.locator("[data-not-found]").count() === 0) throw new Error("SPA 404 not-found missing");
    await page.goto(`${BASE}/__ui-mockup?surface=global&state=offline&device=desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-global="states"]', { timeout: 8000 });
    if (await page.locator("[data-reconnect]").count() === 0) throw new Error("offline reconnect demo missing");
    if (await page.getByText("最近已知", { exact: false }).count() === 0) throw new Error("last-known missing");
  });
  await step("index closeout: all 13 surfaces + single-entry overview sentence", async () => {
    await page.goto(`${BASE}/__ui-mockup?index=1`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-mockup-index]", { timeout: 8000 });
    if (await page.locator("[data-index-overview]").count() === 0) throw new Error("index overview sentence missing");
    for (const t of ["01 · 应用外壳", "07 · Channels", "13 · Global states"]) {
      if (await page.getByText(t, { exact: false }).count() === 0) throw new Error(`index section missing: ${t}`);
    }
  });
  const GLOBAL_STATES = ["empty", "loading", "populated", "error", "permission", "busy", "offline", "boundary"];
  for (const device of ["desktop", "mobile"]) {
    for (const st of GLOBAL_STATES) {
      await step(`screenshot global-${st}-${device}`, async () => {
        await page.goto(`${BASE}/__ui-mockup?surface=global&state=${st}&device=${device}&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(`[data-mockup="frame"][data-device="${device}"][data-global="states"]`, { timeout: 8000 });
        await sleep(130);
        await shotFrame(`${SHOTS}/global-${st}-${device}-dark-slate-signal-teal.png`);
      });
    }
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
