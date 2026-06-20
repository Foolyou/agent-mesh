// Accessibility e2e: for EVERY built-in theme, render the app and measure the *computed*
// contrast of real DOM nodes against their *effective* background (walking the DOM,
// compositing translucent layers + element opacity). Two complementary passes:
//
//   1. CRAWL — walk every visible element that paints its own text and assert the text
//      meets WCAG AA (normal 4.5, large text 3.0). This catches structural bugs the
//      static palette audit can't: a control that keeps its dark-surface color on the
//      inverted (light) selection row (the start-button bug), a badge using the wrong
//      token, status words rendered too light, etc. Disabled controls are held to a HARD
//      3.0 usability floor (same threshold the static contract gates). Reviewed exceptions
//      are explicit and logged.
//   2. DIRECTED — a handful of non-text / SVG / focus checks the crawler can't see from
//      text color alone (canvas window border, idle + active canvas edge strokes).
//
// Theme list is DERIVED from BUILTIN_THEMES so a new theme is covered automatically.
// Run: bun run src/web/a11y.e2e.ts  (alias: bun run a11y:e2e)
import { type Page } from "playwright";
import { authedContext, authedReady, launchChromium, provisionE2eAuth } from "./e2e-playwright";
import { rm } from "node:fs/promises";
import { UI_COMPONENT, AA_TEXT, AA_LARGE } from "./client/contrast";
import { BUILTIN_THEMES } from "./client/themes";

const PORT = Number(process.env.E2E_PORT) || 7490;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const THEMES = BUILTIN_THEMES.map((t) => t.name);

// Selectors the crawler must NOT fail on, each with a documented reason. Kept empty by
// default — add an entry only with a real justification; it is logged on every run so an
// excused element can never silently rot.
const REVIEWED_EXCEPTIONS: { sel: string; why: string }[] = [
  // (none) — every visible text node currently meets AA.
];

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

// ── shared in-page color math (compositing + luminance) ───────────────────────
// Serialised into the page by both CRAWL and MEASURE. Keep dependency-free.
const COLOR_MATH = `
  const parse = (s) => {
    const srgb = s.match(/color\\(srgb\\s+([^\\s]+)\\s+([^\\s]+)\\s+([^\\s/]+)(?:\\s*\\/\\s*([^)]+))?\\)/);
    if (srgb) { const [,r,g,b,a]=srgb; return { r:parseFloat(r)*255, g:parseFloat(g)*255, b:parseFloat(b)*255, a:a===undefined?1:parseFloat(a) }; }
    const m = s.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return { r:0,g:0,b:0,a:0 };
    const [r,g,b,a] = m[1].split(/[,\\s/]+/).filter(Boolean).map((x)=>parseFloat(x));
    return { r,g,b,a:a===undefined?1:a };
  };
  const over = (f,b) => ({ r:f.r*f.a+b.r*(1-f.a), g:f.g*f.a+b.g*(1-f.a), b:f.b*f.a+b.b*(1-f.a), a:1 });
  const lum = ({r,g,b}) => { const ch=(c)=>{const s=c/255; return s<=0.03928?s/12.92:((s+0.055)/1.055)**2.4;}; return 0.2126*ch(r)+0.7152*ch(g)+0.0722*ch(b); };
  const ratio = (x,y) => { const a=lum(x),b=lum(y); const [hi,lo]=a>=b?[a,b]:[b,a]; return (hi+0.05)/(lo+0.05); };
  const effBg = (el) => {
    const layers=[];
    for (let n=el; n; n=n.parentElement) { const bg=parse(getComputedStyle(n).backgroundColor); if (bg.a>0) layers.push(bg); if (bg.a>=0.999) break; }
    let base = layers.length?layers[layers.length-1]:{r:0,g:0,b:0,a:1};
    for (let i=layers.length-2;i>=0;i--) base = over(layers[i], base);
    return base;
  };
`;

// CRAWL: every visible element that paints its OWN text → contrast vs effective bg.
// Returns the offenders (and a scanned count) so the test can assert none below threshold.
const CRAWL = (excepts: string[]) => {
  // @ts-ignore — injected below as a string prelude
  const { parse, over, lum, ratio, effBg } = (window as any).__a11y;
  const AAt = 4.5,
    AAlarge = 3.0,
    DISABLED_FLOOR = 3.0;
  const exceptSel = excepts.join(",");
  const offenders: any[] = [];
  let scanned = 0;
  const hasOwnText = (el: Element) => {
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3 && (n.textContent || "").trim().length > 0) return true;
    return false;
  };
  const isDisabled = (el: Element) =>
    !!(el as any).disabled ||
    el.getAttribute("aria-disabled") === "true" ||
    !!el.closest("[disabled],[aria-disabled='true'],.disabled,.composer.disabled,:disabled");
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity || "1") === 0) continue;
    if (!(el as HTMLElement).offsetParent && cs.position !== "fixed") continue; // not laid out
    if ((el as HTMLElement).getClientRects().length === 0) continue;
    if (!hasOwnText(el)) continue;
    scanned++;
    if (exceptSel && el.closest(exceptSel)) continue;
    const bg = effBg(el);
    const color = parse(cs.color);
    const elOpacity = parseFloat(cs.opacity || "1");
    const fg = over({ ...color, a: color.a * elOpacity }, bg);
    const r = ratio(fg, bg);
    // large text (WCAG): >=24px, or >=18.66px bold
    const px = parseFloat(cs.fontSize) || 0;
    const bold = (parseInt(cs.fontWeight) || 400) >= 700;
    const large = px >= 24 || (px >= 18.66 && bold);
    const disabled = isDisabled(el);
    const need = disabled ? DISABLED_FLOOR : large ? AAlarge : AAt;
    if (r < need - 0.005) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute("class") || "").slice(0, 40),
        text: (el.textContent || "").trim().slice(0, 28),
        ratio: Math.round(r * 100) / 100,
        need,
        large,
        disabled,
      });
    }
  }
  return { offenders, scanned };
};

// DIRECTED: non-text / SVG / focus checks the crawler can't infer from text color.
type Check = { sel: string; kind: "ui"; prop: string };
const DIRECTED: Check[] = [
  { sel: ".canvas-window", kind: "ui", prop: "border-top-color" }, // window border on raised surface
  { sel: ".canvas-edge", kind: "ui", prop: "stroke" }, // idle directed canvas edge on canvas bg
  { sel: ".canvas-edge.active", kind: "ui", prop: "stroke" }, // active directed edge uses info accent
];
const MEASURE = (selectors: Check[]) => {
  // @ts-ignore
  const { parse, effBg, lum } = (window as any).__a11y;
  const ratio = (x: any, y: any) => {
    const a = lum(x),
      b = lum(y);
    const [hi, lo] = a >= b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
  };
  return selectors.map((sel) => {
    const el = document.querySelector(sel.sel);
    if (!el) return { ...sel, found: false, ratio: 0, need: 3 };
    const cs = getComputedStyle(el);
    const bg = effBg(el);
    const raw = cs.getPropertyValue(sel.prop);
    const color = parse(raw || cs.color);
    const fg = { r: color.r, g: color.g, b: color.b };
    return { ...sel, found: true, ratio: Math.round(ratio(fg, bg) * 100) / 100, need: 3, value: raw };
  });
};

async function installColorMath(page: Page) {
  await page.evaluate(`window.__a11y = (function(){ ${COLOR_MATH} return { parse, over, lum, ratio, effBg }; })();`);
}

const auth = await provisionE2eAuth();
const server = Bun.spawn(["bun", "run", "src/main.ts", "--fake", "--port", String(PORT)], { stdout: "pipe", stderr: "pipe", env: auth.env });
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
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".mrow.sel", { timeout: 8000 });
  await page.locator('.detail-head .btn:has-text("start mesh")').click();
  await page.waitForSelector(".conv-panel .msg.agent .bubble .md a", { timeout: 12000 });

  const exceptSels = REVIEWED_EXCEPTIONS.map((e) => e.sel);
  if (REVIEWED_EXCEPTIONS.length)
    console.log(`  reviewed exceptions: ${REVIEWED_EXCEPTIONS.map((e) => `${e.sel} (${e.why})`).join(", ")}`);

  for (const theme of THEMES) {
    await step(`theme "${theme}": rendered DOM text + UI contrast meets WCAG`, async () => {
      await page.evaluate((t) => localStorage.setItem("mesh.theme", t), theme);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".mrow.sel .btn", { timeout: 8000 });
      await page.locator('.drail .panel:has(.head:has-text("topology")) .btn:has-text("⤢")').click();
      await page.waitForSelector(".mesh-canvas .canvas-window-head .agent-id", { timeout: 8000 });
      // Kill transitions/animations before measuring so computed colors are at their final
      // state, not mid-tween.
      await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
      await page.evaluate(() => {
        const store = (window as any).__meshStore;
        const now = new Date().toISOString();
        store.apply({
          t: "mail",
          name: "demo",
          entry: { id: `a11y-canvas-active-${Date.now()}`, ts: now, from: "codex-1", to: "opencode-1", body: "audit active canvas edge" },
        });
      });
      await page.waitForSelector('.canvas-edge.active[data-from="codex-1"][data-to="opencode-1"]', { timeout: 1000 });
      await sleep(60);
      await installColorMath(page);

      const { offenders, scanned } = await page.evaluate(CRAWL, exceptSels);
      const directed = await page.evaluate(MEASURE, DIRECTED);
      const missing = directed.filter((d) => !d.found);
      const badUi = directed.filter((d) => d.found && d.ratio < d.need);
      if (scanned < 20) throw new Error(`only ${scanned} text nodes scanned — page likely not rendered`);
      if (missing.length) throw new Error(`directed selectors not found: ${missing.map((m) => m.sel).join(", ")}`);
      if (offenders.length)
        throw new Error(
          `${offenders.length} text node(s) below AA (scanned ${scanned}): ` +
            offenders
              .slice(0, 6)
              .map((o) => `<${o.tag}.${o.cls}> "${o.text}"=${o.ratio} need ${o.need}${o.disabled ? " [disabled-floor]" : ""}`)
              .join(" · "),
        );
      if (badUi.length) throw new Error(badUi.map((b) => `${b.sel}=${b.ratio}:1 need ${b.need}:1`).join(" · "));
    });
  }

  // mesh-ps-doctor: the System health / process panel (doctor checks + ps detail) paints
  // severity-coloured text (--ok/--warn/--bad) and faint metadata on the raised modal surface, so
  // crawl its rendered DOM in every theme. Data comes from the gated /api/diagnostics/* routes (the
  // authed e2e context satisfies the device gate); --fake yields a populated report.
  for (const theme of THEMES) {
    await step(`theme "${theme}": System panel (doctor + ps) text meets WCAG`, async () => {
      await page.evaluate((t) => localStorage.setItem("mesh.theme", t), theme);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".mrow.sel .btn", { timeout: 8000 });
      await page.locator('[aria-label="Open system health"]').click();
      await page.waitForSelector(".system-modal", { timeout: 6000 });
      // Wait for the fetch to resolve into real content (a section) or a surfaced error — not the
      // transient "loading…" placeholder — so the crawler measures the populated panel.
      await page.waitForSelector(".system-modal .system-section, .system-modal .system-error", { timeout: 8000 });
      await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
      await sleep(40);
      await installColorMath(page);
      const { offenders, scanned } = await page.evaluate(CRAWL, exceptSels);
      if (scanned < 20) throw new Error(`only ${scanned} text nodes scanned — System panel likely not rendered`);
      if (offenders.length)
        throw new Error(
          `${offenders.length} System-panel text node(s) below AA (scanned ${scanned}): ` +
            offenders.slice(0, 6).map((o) => `<${o.tag}.${o.cls}> "${o.text}"=${o.ratio} need ${o.need}`).join(" · "),
        );
    });
  }

  // issue-panel Phase 4: label chips paint user-chosen palette backgrounds, so their TEXT must stay
  // AA. Seed two chips via REST (a LIGHT palette color → black foreground, and a DARK one → white)
  // then open the board so the crawler measures the chip text against its custom background.
  await step("label chips meet WCAG AA in the board view (light + dark palette colors)", async () => {
    const getBoard = async () => (await fetch(`${BASE}/api/meshes/demo/board`, { headers: { authorization: `Bearer ${auth.token}` } })).json();
    const post = (command: unknown, ebr: number) =>
      fetch(`${BASE}/api/meshes/demo/board`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${auth.token}` }, body: JSON.stringify({ command, expectedBoardRevision: ebr }) });
    let b = await getBoard();
    if (!(b.labels ?? []).some((l: { name: string }) => l.name === "bug")) {
      await post({ type: "create_label", name: "bug", color: "#fde68a" }, b.revision); // light → black fg
      b = await getBoard();
      await post({ type: "create_label", name: "blocked", color: "#b91c1c" }, b.revision); // dark → white fg
      b = await getBoard();
      await post({ type: "create_task", title: "Audit label chips", assignee: "codex-1" }, b.revision);
      b = await getBoard();
      const last = b.tasks[b.tasks.length - 1];
      await post({ type: "set_task_labels", id: last.id, expectedRevision: last.revision, labelIds: b.labels.map((l: { id: string }) => l.id) }, b.revision);
    }
    await page.evaluate(() => localStorage.setItem("mesh.theme", "phosphor"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".mrow.sel .btn", { timeout: 8000 });
    await page.locator('.drail .seg-tab:has-text("board")').first().click();
    await page.waitForSelector(".drail .board .label-chip", { timeout: 8000 });
    await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
    await installColorMath(page);
    const chips = await page.locator(".drail .board .label-chip").count();
    if (chips < 2) throw new Error(`expected ≥2 label chips rendered, got ${chips}`);
    const { offenders, scanned } = await page.evaluate(CRAWL, exceptSels);
    if (scanned < 20) throw new Error(`only ${scanned} text nodes scanned — board likely not rendered`);
    if (offenders.length)
      throw new Error(
        `${offenders.length} text node(s) below AA in the board view (scanned ${scanned}): ` +
          offenders.slice(0, 6).map((o) => `<${o.tag}.${o.cls}> "${o.text}"=${o.ratio} need ${o.need}`).join(" · "),
      );
  });

  // One mobile-viewport pass on the default theme: mobile uses a master→detail layout
  // (tap a mesh row to open its detail), so it exercises chrome the desktop pass doesn't.
  await step("mobile viewport (default theme): rendered text meets AA", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => localStorage.setItem("mesh.theme", "phosphor"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('.mrow:has-text("demo")', { timeout: 8000 });
    await page.locator('.mrow:has-text("demo")').click();
    await page.waitForSelector(".mdetail", { timeout: 6000 });
    await sleep(120);
    await installColorMath(page);
    const { offenders, scanned } = await page.evaluate(CRAWL, exceptSels);
    if (scanned < 10) throw new Error(`only ${scanned} text nodes scanned on mobile`);
    if (offenders.length)
      throw new Error(
        `${offenders.length} mobile text node(s) below AA (scanned ${scanned}): ` +
          offenders.slice(0, 6).map((o) => `<${o.tag}.${o.cls}> "${o.text}"=${o.ratio} need ${o.need}`).join(" · "),
      );
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await step("no page errors across theme switches", async () => {
    if (errors.length) throw new Error(`${errors.length}: ${errors.slice(0, 2).join(" || ")}`);
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log(`  A11Y E2E OK — crawled DOM text ≥ AA (${AA_TEXT}/large ${AA_LARGE}) and UI components ≥ ${UI_COMPONENT}:1 in every theme`);
  }
} finally {
  await browser.close();
  server.kill();
  await rm(auth.meshRootBase, { recursive: true, force: true });
}
