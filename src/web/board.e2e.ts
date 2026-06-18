// Browser e2e for the collaboration board (#42): starts the --fake backend, opens the board
// panel, and drives the full Phase-1 loop — create epic/task/subtask, assign/priority/status,
// comment, dependency edit + warning — then stops the mesh and reloads to prove the persisted
// board renders read-only. Real REST → FakeManager.boardCommand → board_snapshot → WS → store.
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
    await page.locator('.drail .seg-tab:has-text("board")').click();
    await page.waitForSelector(".drail .board", { timeout: 6000 });
  };
  const taskRow = (id: number) => page.locator(`.drail .board-task:has(.board-tid:has-text("#${id}"))`);

  await step("start mesh → board tab is visible", async () => {
    await page.locator('.detail-head .btn:has-text("start mesh")').click();
    await page.waitForSelector('.detail-head:has-text("running")', { timeout: 8000 });
    await openBoard();
  });

  await step("create a task and an epic", async () => {
    await page.getByPlaceholder("+ task").first().fill("Wire it up");
    await page.getByPlaceholder("+ task").first().press("Enter");
    await page.waitForSelector('.drail .board-tid:has-text("#1")', { timeout: 6000 });
    await page.getByPlaceholder("+ epic").first().fill("Launch");
    await page.getByPlaceholder("+ epic").first().press("Enter");
    await page.waitForSelector('.drail .board-eid:has-text("E1")', { timeout: 6000 });
  });

  await step("change status, priority, assignee on the task", async () => {
    const row = taskRow(1);
    await row.locator('select[title="status"]').selectOption("in_progress");
    await page.waitForFunction(() => {
      const sel = document.querySelector('.drail .board-task select[title="status"]') as HTMLSelectElement | null;
      return sel?.value === "in_progress";
    }, { timeout: 6000 });
    await row.locator('select[title="priority"]').selectOption("high");
    await row.locator('select[title="assignee"]').selectOption("codex-1");
    await page.waitForFunction(() => {
      const sel = document.querySelector('.drail .board-task select[title="assignee"]') as HTMLSelectElement | null;
      return sel?.value === "codex-1";
    }, { timeout: 6000 });
  });

  await step("expand the task, add a subtask and a comment", async () => {
    await taskRow(1).locator(".board-twirl").click();
    await page.getByPlaceholder("+ subtask").first().fill("subtask A");
    await page.getByPlaceholder("+ subtask").first().press("Enter");
    await page.waitForSelector('.drail .board-subtask:has-text("subtask A")', { timeout: 6000 });
    await page.getByPlaceholder("comment…").first().fill("looking into it");
    await page.getByPlaceholder("comment…").first().press("Enter");
    await page.waitForSelector('.drail .board-comment:has-text("looking into it")', { timeout: 6000 });
  });

  await step("dependency edit surfaces a warning (advisory, not blocking)", async () => {
    // second task to depend on
    await page.getByPlaceholder("+ task").first().fill("Prereq");
    await page.getByPlaceholder("+ task").first().press("Enter");
    await page.waitForSelector('.drail .board-tid:has-text("#2")', { timeout: 6000 });
    // #1 depends on #2; #1 is already in_progress while #2 is todo → blocked-by-incomplete warning
    const depsInput = taskRow(1).getByPlaceholder("deps e.g. 1,2");
    await depsInput.fill("2");
    await depsInput.press("Enter");
    await page.waitForSelector(".drail .board-warn", { timeout: 6000 });
  });

  await step("Enter-then-blur on an unchanged deps value does not error or double-submit", async () => {
    const depsInput = taskRow(1).getByPlaceholder("deps e.g. 1,2");
    await depsInput.focus();
    await depsInput.press("Enter"); // value already "2" == current → no write
    await page.locator(".drail .board-head").click(); // blur → depsCommit returns null again
    await sleep(300);
    if (await page.locator(".toast.error, .toast-error").count()) throw new Error("an error toast appeared on a no-op deps commit");
    // still exactly one dep shown
    const depText = await taskRow(1).locator(".board-meta").innerText();
    if (!/#2/.test(depText)) throw new Error(`deps meta lost #2: ${depText}`);
  });

  await step("dispatch state renders in the task detail (dispatch line + lifecycle pill + mail-failed badge)", async () => {
    // FakeManager runs the REAL board reducer, so a single dispatch_task command (NOT the funnel)
    // seeds the panel with dispatch + lifecycle data to render. Read current revisions, then POST;
    // the panel re-renders from board_snapshot → WS → store.
    const getBoard = async () => (await fetch(`${BASE}/api/meshes/demo/board`)).json();
    const post = (command: unknown, ebr: number) =>
      fetch(`${BASE}/api/meshes/demo/board`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command, expectedBoardRevision: ebr }) });

    const b1 = await getBoard();
    const rev1 = b1.tasks.find((x: { id: number }) => x.id === 1).revision;
    const r1 = await post({ type: "dispatch_task", id: 1, expectedRevision: rev1, assignee: "codex-1", taskSlug: "wire-it" }, b1.revision);
    if (!r1.ok) throw new Error(`dispatch_task POST failed: ${r1.status}`);

    // ensure #1 is expanded WITHOUT toggling a row that may already be open from an earlier step
    if (!(await taskRow(1).locator(".board-task-body").count())) await taskRow(1).locator(".board-twirl").click();
    await page.waitForSelector('.drail .board-task .board-dispatch:has-text("@codex-1")', { timeout: 6000 });
    await page.waitForSelector('.drail .board-task .board-lc-pill:has-text("dispatched")', { timeout: 6000 });

    const b2 = await getBoard();
    const rev2 = b2.tasks.find((x: { id: number }) => x.id === 1).revision;
    const r2 = await post({ type: "set_dispatch_mail", taskId: 1, expectedRevision: rev2, mailFailed: true }, b2.revision);
    if (!r2.ok) throw new Error(`set_dispatch_mail POST failed: ${r2.status}`);
    await page.waitForSelector(".drail .board-task .board-mailfail", { timeout: 6000 });
  });

  await step("stop the mesh, reload, and the persisted board renders read-only", async () => {
    await page.locator('.detail-head .btn:has-text("stop mesh")').click();
    // ConfirmButton: a second click confirms.
    await page.locator('.detail-head .btn:has-text("stop")').last().click();
    await page.waitForSelector('.detail-head:has-text("stopped")', { timeout: 8000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".mrow.sel", { timeout: 8000 });
    await openBoard();
    await page.waitForSelector('.drail .board-tid:has-text("#1")', { timeout: 6000 });
    if (await page.locator(".drail .board select").count()) throw new Error("editable selects present on a stopped mesh board");
    if (await page.locator(".drail .board .board-input").count()) throw new Error("editable inputs present on a stopped mesh board");
    if (!(await page.locator('.drail .board-title:has-text("Wire it up")').count())) throw new Error("persisted task missing after reload");
  });

  await step("mobile viewport renders the board panel without layout overlap", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(200);
    // switch to the mobile log segment which hosts the board panel
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
    console.log("  BOARD E2E OK — create/edit/deps/warning + stopped read-only after reload");
  }
} finally {
  await browser.close();
  server.kill();
}
