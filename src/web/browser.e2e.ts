// Headless browser end-to-end over the `--fake` server: spawns the server, drives the
// real DOM with Playwright (bundled chromium), and asserts every widget. Also writes
// screenshots to /tmp/mesh-shots. Run: bun run src/web/browser.e2e.ts
import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";

const PORT = Number(process.env.E2E_PORT) || 7413;
const BASE = `http://localhost:${PORT}`;
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

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/api/state`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("server never became ready");
}

const server = Bun.spawn(["bun", "run", "src/main.ts", "--fake", "--port", String(PORT)], {
  stdout: "pipe",
  stderr: "pipe",
});

const browser = await chromium.launch({ headless: true });
try {
  await waitReady();
  const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  // ignore HTTP-status resource logs (e.g. the deliberate 400 in the toast test —
  // the app surfaces those as toasts); keep genuine JS/React errors.
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  await step("topbar + ws live + demo mesh listed", async () => {
    await page.waitForSelector(".brand", { timeout: 8000 });
    await page.waitForSelector('.stat:has-text("live")', { timeout: 8000 });
    await page.waitForSelector('.mrow:has-text("demo")', { timeout: 8000 });
  });

  await step("mesh auto-selected → detail header shows start button", async () => {
    await page.waitForSelector('.detail-head:has-text("demo")', { timeout: 8000 });
    await page.waitForSelector('.detail-head .btn:has-text("start mesh")', { timeout: 8000 });
  });

  await step("topology renders 3 nodes + edges", async () => {
    await page.waitForSelector(".topo svg .node", { timeout: 8000 });
    const nodes = await page.locator(".topo .node").count();
    if (nodes !== 3) throw new Error(`expected 3 nodes, got ${nodes}`);
    const edges = await page.locator(".topo .edge").count();
    if (edges < 1) throw new Error("no topology edges");
    const box = await page.locator(".topo svg").boundingBox();
    if (!box || box.height < 120) throw new Error(`topology svg too short (${box?.height}px) — graph cropped`);
  });

  await page.screenshot({ path: `${SHOTS}/01-loaded.png`, fullPage: true });

  await step("start mesh → status running, agents ready", async () => {
    await page.locator('.detail-head .btn:has-text("start mesh")').click();
    await page.waitForSelector('.detail-head:has-text("running")', { timeout: 8000 });
  });

  await step("router message is COALESCED into one growing bubble (not per-chunk)", async () => {
    // the fake streams 'Plan: codex-1 implements the calculator core, opencode-1 reviews.'
    const bubble = page.locator('.panel:has(.head:has-text("router chat")) .msg.agent .bubble', {
      hasText: "implements the calculator core",
    });
    await bubble.first().waitFor({ timeout: 10000 });
    const count = await page.locator('.panel:has(.head:has-text("router chat")) .msg.agent').count();
    if (count > 3) throw new Error(`too many message bubbles (${count}) — chunks not coalesced`);
  });

  await step("agent prose renders markdown live", async () => {
    const panel = page.locator('.panel:has(.head:has-text("router chat"))');
    const bubble = panel.locator(".msg.agent .bubble", { hasText: "implements the calculator core" }).first();
    await bubble.locator("strong", { hasText: "codex-1" }).waitFor({ timeout: 4000 });
    await bubble.locator("ul li", { hasText: "implement core" }).waitFor({ timeout: 4000 });
    await bubble.locator("pre code", { hasText: "export const add" }).waitFor({ timeout: 4000 });
    const link = bubble.locator('a[href="https://example.com/"]').first();
    await link.waitFor({ timeout: 4000 });
    const target = await link.getAttribute("target");
    const rel = await link.getAttribute("rel");
    if (target !== "_blank") throw new Error(`safe link target was ${target}`);
    if (rel !== "noopener noreferrer") throw new Error(`safe link rel was ${rel}`);
    const badLinks = await bubble.locator('a[href^="javascript:"]').count();
    if (badLinks) throw new Error("javascript link retained an anchor href");
    const img = bubble.locator("img").first();
    await img.waitFor({ timeout: 4000 });
    if ((await img.getAttribute("referrerpolicy")) !== "no-referrer") throw new Error("image referrerpolicy not hardened");
    if ((await img.getAttribute("loading")) !== "lazy") throw new Error("image loading not lazy");
    const badImages = await bubble.locator('img[src^="javascript:"]').count();
    if (badImages) throw new Error("javascript image src rendered");
    // data:image/png is a spec-allowed scheme and must survive sanitize + harden …
    const dataImg = bubble.locator('img[src^="data:image/png"]');
    if ((await dataImg.count()) < 1) throw new Error("data:image/png did not render (sanitize stripped it)");
    // … but data:image/svg+xml (can carry script) must be blocked …
    if ((await bubble.locator('img[src^="data:image/svg"]').count()) > 0) throw new Error("data:image/svg+xml rendered");
    // … and raw HTML must not pass through as a live element (no rehype-raw)
    if ((await bubble.locator("u").count()) > 0) throw new Error("raw HTML <u> rendered as a live element");
  });

  await step("router shows a plan checklist", async () => {
    await page.waitForSelector('.panel:has(.head:has-text("router chat")) .plan .plan-row', { timeout: 9000 });
  });

  await step("agent replies never render a streaming caret", async () => {
    // The UI intentionally renders no caret, including while replies are still streaming.
    await page.waitForFunction(
      () => {
        const panel = [...document.querySelectorAll(".panel")].find((p) =>
          p.querySelector(".head")?.textContent?.includes("router chat"),
        );
        const agentMsgs = panel?.querySelectorAll(".msg.agent") ?? [];
        return agentMsgs.length > 0 && document.querySelectorAll(".cursor").length === 0;
      },
      { timeout: 10000 },
    );
  });

  await step("messages show timestamps", async () => {
    const t = await page.locator(".msg .who .t").first().textContent();
    if (!/\d\d:\d\d:\d\d/.test(t ?? "")) throw new Error(`no timestamp (got "${t}")`);
  });

  await step("thought block present and expandable", async () => {
    const label = page.locator(".thought .label").first();
    await label.waitFor({ timeout: 8000 });
    await label.click();
    await page.waitForSelector(".thought .txt", { timeout: 4000 });
    await page.waitForSelector(".thought .txt strong", { timeout: 4000 });
  });

  await step("tool-call card shows detail by default; toggle collapses", async () => {
    // switch to codex-1 agent panel via topology node click
    await page.locator('.topo .node:has-text("codex-1")').click();
    await page.waitForSelector('.tool .badge.completed', { timeout: 12000 });
    const cards = await page.locator(".tool").count();
    if (cards < 1) throw new Error("no tool card");
    // detail is visible WITHOUT a click — detail-bearing cards default to open
    await page.waitForSelector(".tool .tout", { timeout: 4000 });
    await page.waitForSelector('.tool .tdetail .tlabel:has-text("input")', { timeout: 4000 });
    const strongInTool = await page.locator(".tool .tout strong").count();
    if (strongInTool) throw new Error("tool detail rendered markdown");
    const raw = await page.locator(".tool .tout", { hasText: "**raw output**" }).count();
    if (!raw) throw new Error("tool output did not preserve raw markdown text");
    // the manual toggle still collapses a detail-bearing card
    const detailed = page.locator(".tool", { has: page.locator(".tdetail") }).first();
    await detailed.locator(".thead").click();
    await detailed.locator(".tdetail").waitFor({ state: "detached", timeout: 4000 });
  });

  await step("tool cards keep full height when the transcript overflows (no flex-shrink collapse)", async () => {
    // Regression: .stream is a flex column; an overflowing transcript used to let flexbox
    // shrink .tool cards (overflow:hidden → flex min-size 0) down to their ~2px borders.
    await page.evaluate(() => {
      const store = (window as any).__meshStore;
      const now = new Date().toISOString();
      const conv = { scope: "agent", mesh: "demo", agent: "router" };
      for (let i = 0; i < 14; i++) {
        store.apply({
          t: "transcript.upsert",
          conv,
          item: { id: `of-${i}`, kind: "message", role: "agent", text: Array.from({ length: 6 }, (_, j) => `overflow filler ${i}.${j}`).join("\n"), ts: now, complete: true },
        });
      }
      store.apply({
        t: "transcript.upsert",
        conv,
        item: { id: "of-tool", kind: "tool_call", toolCallId: "of-tc", title: "mcp__mesh__send_mail", toolKind: "other", status: "completed", input: '{ "to": "impl", "body": "hi" }', ts: now, updatedTs: now },
      });
    });
    const panel = page.locator('.panel:has(.head:has-text("router chat"))');
    const card = panel.locator(".tool", { hasText: "mcp__mesh__send_mail" }).first();
    await card.waitFor({ timeout: 4000 });
    const h = await card.evaluate((el) => (el as HTMLElement).offsetHeight);
    if (h < 24) throw new Error(`tool card collapsed to ${h}px under overflow (flex-shrink regression)`);
  });

  await step("thinking effort is read-only while the mesh is running", async () => {
    // effort is a launch-time setting — while running it's shown but not editable (edit when stopped
    // or in the builder). The create/edit builder test covers the stopped-edit + persist round-trip.
    await page.locator('.topo .node:has-text("codex-1")').click();
    const sel = page.locator('.dchat .panel:has(.tabs) .effort-sel').first();
    await sel.waitFor({ timeout: 6000 });
    if (!(await sel.isDisabled())) throw new Error("effort select should be read-only (disabled) while running");
  });

  await step("failed command surfaces an error toast", async () => {
    // starting an already-running mesh fails → toast (drives the store directly)
    await page.evaluate(() => (window as any).__meshStore.startMesh("demo").catch(() => {}));
    await page.waitForSelector(".toast.error", { timeout: 4000 });
  });

  await step("rail logs: mailbox tab shows inter-agent mail", async () => {
    await page.locator('.drail .seg-tab:has-text("mail")').click();
    await page.waitForSelector(".drail .panel .k.mail", { timeout: 10000 });
  });

  await step("received mail appears inline in the recipient's conversation, sender-labeled", async () => {
    // the fake mails codex-1 → opencode-1; open opencode-1 and verify the inline mail bubble
    await page.locator('.topo .node:has-text("opencode-1")').click();
    const mail = page.locator(".msg.mail", { hasText: "core implemented" }).first();
    await mail.waitFor({ timeout: 10000 });
    const who = (await mail.locator(".who").innerText()).toLowerCase();
    if (!who.includes("codex-1")) throw new Error(`mail bubble missing sender label: ${who}`);
  });

  await step("rail logs: activity tab shows mail + interrupt + log", async () => {
    await page.locator('.drail .seg-tab:has-text("activity")').click();
    await page.waitForSelector(".drail .panel .k.interrupt", { timeout: 10000 });
  });

  await step("permission card (pinned) appears and resolves into history", async () => {
    const card = page.locator(".dperm .perm");
    await card.first().waitFor({ timeout: 12000 });
    await page.screenshot({ path: `${SHOTS}/02-running.png`, fullPage: true });
    await page.locator('.dperm .perm .btn:has-text("Allow once")').click();
    await page.locator('.drail .seg-tab:has-text("history")').click();
    await page.waitForSelector(".drail .panel .k.permission_resolved", { timeout: 6000 });
    if ((await page.locator(".dperm .perm").count()) !== 0) throw new Error("permission card did not clear");
  });

  await step("operator interrupt cancels an agent's turn (activity from 'operator')", async () => {
    // codex-1 panel is active from the tool-call step; click its interrupt button
    await page.locator(".dchat .panel:has(.tabs) .btn", { hasText: "interrupt" }).first().click();
    await page.locator('.drail .seg-tab:has-text("activity")').click();
    await page.waitForSelector('.drail .panel .tx:has-text("operator")', { timeout: 6000 });
  });

  await step("master chat: send instruction → user bubble + streamed reply", async () => {
    const input = page.locator('.panel:has(.head:has-text("Mesh Assistant")) .composer textarea');
    await input.fill("create a build squad mesh");
    await input.press("Enter");
    await page.waitForSelector('.panel:has(.head:has-text("Mesh Assistant")) .msg.user', { timeout: 6000 });
    await page.waitForSelector('.panel:has(.head:has-text("Mesh Assistant")) .msg.agent', { timeout: 8000 });
  });

  await step("router chat: send prompt → user bubble", async () => {
    const input = page.locator('.panel:has(.head:has-text("router chat")) .composer textarea');
    await input.fill("status **please**");
    await input.press("Enter");
    await page.waitForSelector('.panel:has(.head:has-text("router chat")) .msg.user', { timeout: 6000 });
    const user = page.locator('.panel:has(.head:has-text("router chat")) .msg.user .bubble', { hasText: "**please**" }).last();
    await user.waitFor({ timeout: 4000 });
    if ((await user.locator("strong").count()) !== 0) throw new Error("user message rendered markdown");
  });

  await step("unclosed fence streams without breaking and resolves when closed", async () => {
    await page.evaluate(() => {
      const store = (window as any).__meshStore;
      const now = new Date().toISOString();
      store.apply({
        t: "transcript.upsert",
        conv: { scope: "agent", mesh: "demo", agent: "router" },
        item: { id: "md-stream", kind: "message", role: "agent", text: "Before\n```ts\nconst x = 1", ts: now, complete: false },
      });
    });
    const panel = page.locator('.panel:has(.head:has-text("router chat"))');
    await panel.locator("#md-stream").waitFor({ timeout: 4000 }).catch(() => {});
    await panel.locator(".msg.agent .bubble", { hasText: "Before" }).last().waitFor({ timeout: 4000 });
    await panel.locator(".msg.agent .bubble pre, .msg.agent .bubble code", { hasText: "const x = 1" }).last().waitFor({ timeout: 4000 });
    await page.evaluate(() => {
      const store = (window as any).__meshStore;
      store.apply({
        t: "transcript.patch",
        conv: { scope: "agent", mesh: "demo", agent: "router" },
        id: "md-stream",
        patch: { text: "Before\n```ts\nconst x = 1\n```\nAfter", complete: true },
      });
    });
    await panel.locator(".msg.agent .bubble pre code", { hasText: "const x = 1" }).last().waitFor({ timeout: 4000 });
    await panel.locator(".msg.agent .bubble", { hasText: "After" }).last().waitFor({ timeout: 4000 });
  });

  await step("markdown height changes keep transcript pinned to bottom", async () => {
    const stream = page.locator('.panel:has(.head:has-text("router chat")) .stream').first();
    await stream.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.evaluate(() => {
      const store = (window as any).__meshStore;
      const now = new Date().toISOString();
      store.apply({
        t: "transcript.upsert",
        conv: { scope: "agent", mesh: "demo", agent: "router" },
        item: { id: "md-tall", kind: "message", role: "agent", text: "short", ts: now, complete: false },
      });
    });
    await sleep(80);
    await page.evaluate(() => {
      const store = (window as any).__meshStore;
      store.apply({
        t: "transcript.patch",
        conv: { scope: "agent", mesh: "demo", agent: "router" },
        id: "md-tall",
        patch: { text: Array.from({ length: 24 }, (_, i) => `- row ${i}`).join("\n") },
      });
    });
    await sleep(200);
    const gap = await stream.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    if (gap >= 40) throw new Error(`stream not pinned after markdown height change, gap=${gap}`);
  });

  await step("keyboard: 'f' fullscreens router chat, Esc exits", async () => {
    await page.locator(".detail-head .mtitle").click(); // focus a non-input element
    await page.keyboard.press("f");
    await page.waitForSelector(".dmain.full", { timeout: 4000 });
    await page.keyboard.press("Escape");
    await page.waitForSelector(".drail", { timeout: 4000 }); // rail (topology + logs) returns
  });

  await step("mesh builder: invalid config shows inline error", async () => {
    await page.locator('.panel:has(.head:has-text("meshes")) .btn:has-text("new")').click();
    await page.waitForSelector(".modal", { timeout: 4000 });
    // name empty + only one router but blank name → error
    await page.locator('.modal .btn:has-text("define mesh")').click();
    await page.waitForSelector(".modal .err", { timeout: 4000 });
  });

  await step("mesh builder: valid config creates a mesh", async () => {
    await page.locator('.modal .field:has(label:has-text("mesh name")) input').fill("squad-x");
    await page.locator(".modal textarea").fill("Goal: build a tiny CLI. Norms: be concise, write a test.");
    // set the (claude) agent's thinking effort + initial permission mode in the builder
    const adv = page.locator(".modal .agrow-adv .adv-sel");
    await adv.nth(0).selectOption("high"); // effort
    // the no-prompt modes must NOT be advertised in the builder (can't pre-arm a bypass session)
    const modeOpts = await adv.nth(1).locator("option").allTextContents();
    if (modeOpts.some((o) => /bypassPermissions|full-access/.test(o))) throw new Error(`unsafe mode advertised in builder: ${modeOpts.join(",")}`);
    await adv.nth(1).selectOption("plan"); // mode (safe)
    await page.screenshot({ path: `${SHOTS}/03-builder.png`, fullPage: true });
    await page.locator('.modal .btn:has-text("define mesh")').click();
    await page.waitForSelector('.mrow:has-text("squad-x")', { timeout: 6000 });
    // and it auto-opens its console (regression: post-snapshot mesh had no perMesh)
    await page.waitForSelector('.detail-head:has-text("squad-x")', { timeout: 4000 });
    await page.waitForSelector('.panel:has(.head:has-text("topology")) .node', { timeout: 4000 });
  });

  await step("edit a mesh prefills the builder with its config (name locked)", async () => {
    await page.locator('.detail-head .btn:has-text("edit")').click();
    await page.waitForSelector('.modal .mhead:has-text("edit mesh")', { timeout: 4000 });
    const val = await page.locator('.modal .field:has(label:has-text("mesh name")) input').inputValue();
    if (val !== "squad-x") throw new Error(`edit prefill wrong name: "${val}"`);
    const charterVal = await page.locator(".modal textarea").inputValue();
    if (!charterVal.includes("build a tiny CLI")) throw new Error(`charter not prefilled: "${charterVal}"`);
    // effort + initial mode round-trip from the saved config back into the builder
    const adv2 = page.locator(".modal .agrow-adv .adv-sel");
    if ((await adv2.nth(0).inputValue()) !== "high") throw new Error("effort not prefilled");
    if ((await adv2.nth(1).inputValue()) !== "plan") throw new Error("mode not prefilled");
    await page.locator('.modal .btn:has-text("save mesh")').click();
    await page.waitForSelector(".modal", { state: "detached", timeout: 4000 });
    await page.waitForSelector('.mrow:has-text("squad-x")', { timeout: 4000 });
  });

  await step("delete a stopped mesh (two-click confirm) removes it", async () => {
    // squad-x is selected + stopped → its header shows a delete button
    await page.locator('.detail-head .btn:has-text("delete")').click();
    await page.locator('.detail-head .btn:has-text("delete?")').click();
    await page.waitForSelector('.mrow:has-text("squad-x")', { state: "detached", timeout: 5000 });
  });

  await page.screenshot({ path: `${SHOTS}/04-final.png`, fullPage: true });

  await step("no console/page errors", async () => {
    if (errors.length) throw new Error(`${errors.length} console errors: ${errors.slice(0, 3).join(" || ")}`);
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  BROWSER E2E OK — screenshots in /tmp/mesh-shots");
  }
} finally {
  await browser.close();
  server.kill();
}
