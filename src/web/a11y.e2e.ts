// Accessibility e2e: for EVERY theme, render the app and measure the *computed* contrast
// of real text nodes against their *effective* background (walking the DOM, compositing
// translucent layers + element opacity). This is what catches structural bugs the palette
// audit can't — e.g. a control that keeps its dark-surface color on the inverted (light)
// selection row (the start-button bug). Run: bun run src/web/a11y.e2e.ts
import { type Page } from "playwright";
import { launchChromium, e2eEnv } from "./e2e-playwright";
import { UI_COMPONENT } from "./client/contrast";

const PORT = Number(process.env.E2E_PORT) || 7490;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const THEMES = ["phosphor", "amber", "ice", "paper", "mono", "frost", "sage", "linen"];
const AA = 4.5;
type CheckKind = "text" | "ui";
type Check = { sel: string; kind: CheckKind; prop?: string };

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

// Runs inside the page: returns the contrast ratio of each selector's text vs its
// effective background, accounting for translucent layers and element opacity.
const MEASURE = (selectors: Check[]) => {
  const parse = (s: string) => {
    const srgb = s.match(/color\(srgb\s+([^\s]+)\s+([^\s]+)\s+([^\s/]+)(?:\s*\/\s*([^)]+))?\)/);
    if (srgb) {
      const [, r, g, b, a] = srgb;
      return { r: parseFloat(r) * 255, g: parseFloat(g) * 255, b: parseFloat(b) * 255, a: a === undefined ? 1 : parseFloat(a) };
    }
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return { r: 0, g: 0, b: 0, a: 0 };
    const [r, g, b, a] = m[1].split(/[,\s/]+/).filter(Boolean).map((x) => parseFloat(x));
    return { r, g, b, a: a === undefined ? 1 : a };
  };
  type C = { r: number; g: number; b: number; a: number };
  const over = (f: C, b: C): C => ({
    r: f.r * f.a + b.r * (1 - f.a),
    g: f.g * f.a + b.g * (1 - f.a),
    b: f.b * f.a + b.b * (1 - f.a),
    a: 1,
  });
  const lum = ({ r, g, b }: C) => {
    const ch = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  };
  const ratio = (x: C, y: C) => {
    const a = lum(x),
      b = lum(y);
    const [hi, lo] = a >= b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
  };
  const effBg = (el: Element): C => {
    const layers: C[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) {
      const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg.a > 0) layers.push(bg);
      if (bg.a >= 0.999) break;
    }
    let base: C = layers.length ? layers[layers.length - 1] : { r: 0, g: 0, b: 0, a: 1 };
    for (let i = layers.length - 2; i >= 0; i--) base = over(layers[i], base);
    return base;
  };
  return selectors.map((sel) => {
    const el = document.querySelector(sel.sel);
    if (!el) return { ...sel, found: false, ratio: 0, need: sel.kind === "text" ? 4.5 : 3 };
    const cs = getComputedStyle(el);
    const bg = effBg(el);
    const prop = sel.prop ?? "color";
    const raw = cs.getPropertyValue(prop);
    const color = parse(raw || cs.color);
    const fg = over({ ...color, a: color.a * parseFloat(cs.opacity || "1") }, bg);
    return {
      ...sel,
      found: true,
      ratio: Math.round(ratio(fg, bg) * 100) / 100,
      need: sel.kind === "text" ? 4.5 : 3,
      text: (el.textContent || "").trim().slice(0, 24),
      value: raw,
    };
  });
};

// the text surfaces that must stay readable in every theme
const SELECTORS: Check[] = [
  { sel: ".mrow.sel .btn", kind: "text" }, // THE start-button bug: control on the inverted selection row
  { sel: ".mrow.sel .mstatus", kind: "text" }, // status text on the selection row (has opacity)
  { sel: ".mrow.sel .mname", kind: "text" }, // mesh name on selection row
  { sel: ".panel > .head", kind: "text" }, // panel headers (fg-dim, was the low-contrast complaint)
  { sel: ".brand", kind: "text" }, // topbar brand
  { sel: ".topbar .stat", kind: "text" }, // topbar status text
  { sel: ".msg.agent .bubble .md a", kind: "text" }, // markdown links use the info role on transcript surfaces
  { sel: ".msg.agent .bubble .md code", kind: "text" }, // inline/fenced code remains readable on inset surfaces
  { sel: ".canvas-top .ttl", kind: "text" }, // canvas overlay title on themed top chrome
  { sel: ".canvas-window-head .agent-id", kind: "text" }, // canvas window title on inset header
  { sel: ".canvas-window-head .sub", kind: "text" }, // canvas harness label on inset header
  { sel: ".canvas-window", kind: "ui", prop: "border-top-color" }, // canvas window border on raised surface
  { sel: ".canvas-edge", kind: "ui", prop: "stroke" }, // idle directed canvas edge on canvas background
  { sel: ".canvas-edge.active", kind: "ui", prop: "stroke" }, // active directed canvas edge uses info accent
];

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
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".mrow.sel", { timeout: 8000 });
  await page.locator('.detail-head .btn:has-text("start mesh")').click();
  await page.waitForSelector(".conv-panel .msg.agent .bubble .md a", { timeout: 12000 });

  for (const theme of THEMES) {
    await step(`theme "${theme}": rendered canvas/app contrast meets WCAG thresholds`, async () => {
      await page.evaluate((t) => localStorage.setItem("mesh.theme", t), theme);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".mrow.sel .btn", { timeout: 8000 });
      await page.locator('.drail .panel:has(.head:has-text("topology")) .btn:has-text("⤢")').click();
      await page.waitForSelector(".mesh-canvas .canvas-window-head .agent-id", { timeout: 8000 });
      // Kill transitions/animations before activating the edge so computed colors are
      // measured at their final state, not mid-tween.
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
      const rows = await page.evaluate(MEASURE, SELECTORS);
      const bad = rows.filter((r) => r.found && r.ratio < r.need);
      const missing = rows.filter((r) => !r.found);
      if (missing.length) throw new Error(`selectors not found: ${missing.map((m) => m.sel).join(", ")}`);
      if (bad.length)
        throw new Error(bad.map((b) => `${b.sel} "${(b as any).text}" = ${b.ratio}:1 need ${b.need}:1`).join(" · "));
    });
  }

  await step("no page errors across theme switches", async () => {
    if (errors.length) throw new Error(`${errors.length}: ${errors.slice(0, 2).join(" || ")}`);
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log(`  A11Y E2E OK — rendered text ≥ ${AA}:1 and UI components ≥ ${UI_COMPONENT}:1 in every theme`);
  }
} finally {
  await browser.close();
  server.kill();
}
