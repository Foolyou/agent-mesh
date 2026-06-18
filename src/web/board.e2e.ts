// Browser e2e for the collaboration board (#42, Phase 2 list+detail workspace): starts the --fake
// backend, opens the board panel, and drives the list → filter → detail loop — create task/epic,
// filter, open a detail via row click AND via a ?issue=N deep link (board-tab-active, per Phase 2
// scope: NOT cold auto-opening the board tab), round-trip a gated status edit, add subtask/comment,
// render dispatch/lifecycle state — then stops the mesh and reloads to prove read-only persistence.
// Real REST → FakeManager.boardCommand (real reducer) → board_snapshot → WS → store.
// Run: bun run src/web/board.e2e.ts
import { type Page } from "playwright";
import { launchChromium, e2eEnv } from "./e2e-playwright";

const PORT = Number(process.env.E2E_PORT) || 7561;
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

const server = Bun.spawn(["bun", "run", "src/main.ts", "--fake", "--port", String(PORT)], { stdout: "pipe", stderr: "pipe", env: e2eEnv() });
const browser = await launchChromium();
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(BASE + "/api/state")).ok) break;
    } catch {}
    await sleep(250);
  }
  const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".mrow.sel", { timeout: 8000 });

  const openBoard = async () => {
    await page.locator('.drail .seg-tab:has-text("board")').first().click();
    await page.waitForSelector(".drail .board", { timeout: 6000 });
  };
  const issueRow = (id: number) => page.locator(`.drail .board-issue:has(.board-tid:has-text("#${id}"))`);
  const postBoard = (command: unknown, ebr: number) =>
    fetch(`${BASE}/api/meshes/demo/board`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command, expectedBoardRevision: ebr }) });
  const getBoard = async () => (await fetch(`${BASE}/api/meshes/demo/board`)).json();

  await step("start mesh → board tab shows the list workspace", async () => {
    await page.locator('.detail-head .btn:has-text("start mesh")').click();
    await page.waitForSelector('.detail-head:has-text("running")', { timeout: 8000 });
    await openBoard();
    await page.waitForSelector(".drail .board-filter", { timeout: 6000 }); // list view + filter bar
  });

  await step("create a task and an epic", async () => {
    await page.getByPlaceholder("+ task").first().fill("Wire it up");
    await page.getByPlaceholder("+ task").first().press("Enter");
    await page.waitForSelector('.drail .board-issue .board-tid:has-text("#1")', { timeout: 6000 });
    await page.getByPlaceholder("+ epic").first().fill("Launch");
    await page.getByPlaceholder("+ epic").first().press("Enter");
    await sleep(200);
  });

  await step("filter bar narrows the list and shows the no-match empty", async () => {
    const filter = page.getByPlaceholder("filter…").first();
    await filter.fill("zzz-nope");
    await page.waitForFunction(() => document.querySelectorAll(".drail .board-issue").length === 0, { timeout: 6000 });
    if (!(await page.locator('.drail :text("no issues match")').count())) throw new Error("no-match empty state missing");
    await filter.fill("");
    await page.waitForSelector('.drail .board-issue .board-tid:has-text("#1")', { timeout: 6000 });
  });

  await step("clicking an issue row opens its detail and sets the ?issue route", async () => {
    await issueRow(1).click();
    await page.waitForSelector(".drail .board-detail", { timeout: 6000 });
    await page.waitForFunction(() => new URLSearchParams(location.search).get("issue") === "1", { timeout: 6000 });
    if (!(await page.locator('.drail .board-detail:has-text("Wire it up")').count())) throw new Error("detail missing the task title");
  });

  await step("round-trip a gated status edit from the detail view", async () => {
    await page.locator('.drail .board-detail select[title="status"]').selectOption("in_review");
    await page.waitForFunction(() => {
      const sel = document.querySelector('.drail .board-detail select[title="status"]') as HTMLSelectElement | null;
      return sel?.value === "in_review";
    }, { timeout: 6000 });
    // persisted: the durable board reflects the new status
    const b = await getBoard();
    if (b.tasks.find((t: { id: number }) => t.id === 1)?.status !== "in_review") throw new Error("status edit did not persist");
  });

  await step("detail: add a subtask and a comment", async () => {
    await page.getByPlaceholder("+ subtask").first().fill("subtask A");
    await page.getByPlaceholder("+ subtask").first().press("Enter");
    await page.waitForSelector('.drail .board-subtask:has-text("subtask A")', { timeout: 6000 });
    await page.getByPlaceholder("comment…").first().fill("looking into it");
    await page.getByPlaceholder("comment…").first().press("Enter");
    await page.waitForSelector('.drail .board-comment:has-text("looking into it")', { timeout: 6000 });
  });

  await step("detail renders dispatch linkage + lifecycle timeline (REST dispatch → snapshot)", async () => {
    const b = await getBoard();
    const rev = b.tasks.find((t: { id: number }) => t.id === 1).revision;
    const r = await postBoard({ type: "dispatch_task", id: 1, expectedRevision: rev, assignee: "codex-1", taskSlug: "wire-it" }, b.revision);
    if (!r.ok) throw new Error(`dispatch_task POST failed: ${r.status}`);
    await page.waitForSelector('.drail .board-detail .board-lc-pill:has-text("dispatched")', { timeout: 6000 });
    if (!(await page.locator('.drail .board-detail:has-text("task/wire-it")').count())) throw new Error("branchName not shown in detail");
    const b2 = await getBoard();
    const rev2 = b2.tasks.find((t: { id: number }) => t.id === 1).revision;
    const r2 = await postBoard({ type: "set_dispatch_mail", taskId: 1, expectedRevision: rev2, mailFailed: true }, b2.revision);
    if (!r2.ok) throw new Error(`set_dispatch_mail POST failed: ${r2.status}`);
    await page.waitForSelector(".drail .board-detail .board-mailfail", { timeout: 6000 });
  });

  await step("back button returns to the list and clears ?issue", async () => {
    await page.locator(".drail .board-back").first().click();
    await page.waitForSelector(".drail .board-list", { timeout: 6000 });
    // #1 now shows in_review in the list row chip
    await page.waitForSelector('.drail .board-issue .pill.st-in_review', { timeout: 6000 });
  });

  await step("?issue=N deep link reopens the detail once the board panel is active", async () => {
    // Phase-2 scope: deep link is board-tab-active (does NOT cold-open the board tab itself).
    await page.goto(BASE + "/?issue=1", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".mrow.sel", { timeout: 8000 });
    await openBoard();
    await page.waitForSelector(".drail .board-detail", { timeout: 6000 });
    if (!(await page.locator('.drail .board-detail .board-tid:has-text("#1")').count())) throw new Error("deep link did not open #1 detail");
  });

  await step("stop the mesh, reload, and the persisted board renders read-only (list + detail)", async () => {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".mrow.sel", { timeout: 8000 });
    await page.locator('.detail-head .btn:has-text("stop mesh")').click();
    await page.locator('.detail-head .btn:has-text("stop")').last().click(); // ConfirmButton 2nd click
    await page.waitForSelector('.detail-head:has-text("stopped")', { timeout: 8000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".mrow.sel", { timeout: 8000 });
    await openBoard();
    await page.waitForSelector('.drail .board-issue .board-tid:has-text("#1")', { timeout: 6000 });
    // filter-bar selects remain (read-only navigation); only mutation controls must be gone.
    if (await page.locator(".drail .board-create").count()) throw new Error("create row present on a stopped mesh board");
    // open detail → read-only (no editing selects/inputs in the detail)
    await issueRow(1).click();
    await page.waitForSelector(".drail .board-detail", { timeout: 6000 });
    if (await page.locator('.drail .board-detail select').count()) throw new Error("editable selects in a stopped-mesh detail");
    if (await page.locator('.drail .board-detail .board-input').count()) throw new Error("editable inputs in a stopped-mesh detail");
    if (!(await page.locator('.drail .board-detail:has-text("Wire it up")').count())) throw new Error("persisted task missing after reload");
  });

  await step("mobile viewport renders the board panel without horizontal overflow", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(200);
    const logTab = page.locator('.mtab:has-text("log")');
    if (await logTab.count()) await logTab.click();
    await page.waitForSelector(".board", { timeout: 6000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 4) throw new Error(`horizontal overflow ${overflow}px on mobile`);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await step("no page errors", async () => {
    if (errors.length) throw new Error(`${errors.length}: ${errors.slice(0, 2).join(" || ")}`);
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  BOARD E2E OK — list/filter/detail + deep-link + gated edit + read-only persistence");
  }
} finally {
  await browser.close();
  server.kill();
}
