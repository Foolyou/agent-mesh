// Browser e2e for the collaboration board (#42, Phase 2 list+detail + Phase 3 kanban): starts the
// --fake backend, opens the board panel, and drives list → filter → detail (row click AND ?issue=N
// deep link, board-tab-active per Phase 2 scope), a gated status edit, subtask/comment, dispatch/
// lifecycle render, then the KANBAN view — five status columns, a keyboard status-select move and a
// drag-and-drop move both persisting via WS — then stops the mesh and reloads to prove read-only
// persistence (list, detail, AND kanban). Real REST → FakeManager.boardCommand (real reducer) →
// board_snapshot → WS → store. The kanban drag uses synthetic HTML5 DnD events (a shared
// DataTransfer) because Playwright's locator.dragTo does not reliably trigger native DnD; it drives
// the exact production dragstart→drop→attemptMove path. The keyboard-select move is the a11y path
// and is asserted independently.
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

  await step("create a label via the manage UI, attach it via the detail toggle, see the chip", async () => {
    // operator label management lives in the filter bar (running mesh only).
    await page.locator(".drail .board-manage-labels").click();
    await page.getByPlaceholder("label name").fill("bug");
    await page.locator('.drail .board-label-manager .board-back:has-text("label")').first().click(); // "+ label"
    await page.waitForFunction(async () => {
      const b = await (await fetch("/api/meshes/demo/board")).json();
      return (b.labels ?? []).some((l: { name: string }) => l.name === "bug");
    }, { timeout: 6000 });
    // attach via the detail toggle (gated label editor)
    await issueRow(1).click();
    await page.waitForSelector(".drail .board-detail", { timeout: 6000 });
    await page.locator('.drail .board-label-pick .label-toggle:has-text("bug")').click();
    await page.waitForFunction(async () => {
      const b = await (await fetch("/api/meshes/demo/board")).json();
      return (b.tasks.find((t: { id: number }) => t.id === 1)?.labelIds ?? []).length === 1;
    }, { timeout: 6000 });
    await page.locator(".drail .board-back").first().click();
    await page.waitForSelector('.drail .board-issue:has(.board-tid:has-text("#1")) .label-chip:has-text("bug")', { timeout: 6000 });
  });

  await step("the label filter narrows the list (by label, and by no-label)", async () => {
    const labelSel = page.locator('.drail select[aria-label="filter by label"]');
    await labelSel.selectOption({ label: "bug" }); // #1 carries "bug" → stays
    await page.waitForFunction(() => document.querySelectorAll(".drail .board-issue").length === 1, { timeout: 6000 });
    if (!(await page.locator('.drail .board-issue:has(.board-tid:has-text("#1"))').count())) throw new Error("label filter hid the labeled task");
    await labelSel.selectOption("@none"); // "no label" hides the labeled #1
    await page.waitForFunction(() => document.querySelectorAll(".drail .board-issue").length === 0, { timeout: 6000 });
    await labelSel.selectOption(""); // clear → back
    await page.waitForFunction(() => document.querySelectorAll(".drail .board-issue").length === 1, { timeout: 6000 });
  });

  const kanbanCard = (id: number) => page.locator(`.drail .board-card:has(.board-tid:has-text("#${id}"))`);
  const taskStatus = async (id: number) => (await getBoard()).tasks.find((t: { id: number }) => t.id === id)?.status;

  await step("switch to the kanban view shows the five status columns", async () => {
    await page.locator(".drail .board-views .seg-tab").nth(1).click(); // List · Board → Board
    await page.waitForSelector(".drail .board-kanban", { timeout: 6000 });
    await page.waitForFunction(() => new URLSearchParams(location.search).get("board") === "kanban", { timeout: 6000 });
    const cols = await page.locator(".drail .board-kanban .board-col").count();
    if (cols !== 5) throw new Error(`expected 5 columns, got ${cols}`);
    // #1 (in_review) card sits under the in_review column
    await page.waitForSelector('.drail .board-col:has(.board-col-head .pill.st-in_review) .board-card:has(.board-tid:has-text("#1"))', { timeout: 6000 });
  });

  await step("keyboard status select moves a card across columns and persists via WS", async () => {
    await kanbanCard(1).locator("select").selectOption("done");
    await page.waitForFunction(() => {
      const card = document.querySelector('.drail .board-col:has(.board-col-head .pill.st-done) .board-card .board-tid');
      return card?.textContent?.includes("#1");
    }, { timeout: 6000 });
    if ((await taskStatus(1)) !== "done") throw new Error("keyboard status move did not persist");
  });

  await step("internal card drag to another column changes status (HTML5 DnD) and persists", async () => {
    // Playwright's locator.dragTo does not reliably trigger HTML5 drag-and-drop, so drive the same
    // dragstart→dragover→drop handlers deterministically with a shared DataTransfer. The real
    // onDragStart writes the private application/x-agent-mesh-board-task-id payload + dragging ref,
    // and onDrop reads/matches them → attemptMove → set_task_status (we do NOT set the payload here).
    const moved = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".drail .board-card")];
      const src = cards.find((c) => c.querySelector(".board-tid")?.textContent?.includes("#1")) as HTMLElement | undefined;
      const cols = [...document.querySelectorAll(".drail .board-col")];
      const tgt = cols.find((c) => c.querySelector(".board-col-head .pill.st-todo")) as HTMLElement | undefined;
      if (!src || !tgt) return false;
      const dataTransfer = new DataTransfer();
      src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
      tgt.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
      tgt.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
      src.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer }));
      return true;
    });
    if (!moved) throw new Error("could not locate drag source/target nodes");
    await page.waitForFunction(async () => {
      const b = await (await fetch("/api/meshes/demo/board")).json();
      return b.tasks.find((t: { id: number }) => t.id === 1)?.status === "todo";
    }, { timeout: 6000 });
    await page.waitForSelector('.drail .board-col:has(.board-col-head .pill.st-todo) .board-card:has(.board-tid:has-text("#1"))', { timeout: 6000 });
  });

  await step("an EXTERNAL plain-text drop is ignored (no board mutation)", async () => {
    // Security regression guard: a foreign drag carrying only text/plain "1" (no internal dragstart,
    // so no private payload and no active dragging ref) must NOT be mistaken for a task id and move
    // #1. #1 is currently in todo; dropping onto the done column must leave it untouched.
    const before = await taskStatus(1);
    if (before !== "todo") throw new Error(`precondition: expected #1 in todo, was ${before}`);
    await page.evaluate(() => {
      const cols = [...document.querySelectorAll(".drail .board-col")];
      const done = cols.find((c) => c.querySelector(".board-col-head .pill.st-done")) as HTMLElement | undefined;
      if (!done) return;
      const dataTransfer = new DataTransfer();
      dataTransfer.setData("text/plain", "1"); // external payload, NOT the private board MIME type
      done.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
      done.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    });
    await sleep(400); // allow any (erroneous) mutation to round-trip before asserting it did NOT happen
    if ((await taskStatus(1)) !== "todo") throw new Error("external plain-text drop mutated the board");
    if (!(await page.locator('.drail .board-col:has(.board-col-head .pill.st-todo) .board-card:has(.board-tid:has-text("#1"))').count())) {
      throw new Error("#1 left the todo column after an external drop");
    }
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

  await step("stopped-mesh kanban is read-only: cards present, no move controls, not draggable", async () => {
    await page.goto(BASE + "/?board=kanban", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".mrow.sel", { timeout: 8000 });
    await openBoard();
    await page.waitForSelector(".drail .board-kanban .board-card", { timeout: 6000 });
    if (await page.locator(".drail .board-kanban .board-card-move").count()) throw new Error("status selects present on a stopped-mesh kanban");
    if (await page.locator('.drail .board-kanban .board-card[draggable="true"]').count()) throw new Error("draggable cards on a stopped-mesh kanban");
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
