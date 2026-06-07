// Accessibility e2e: for EVERY theme, render the app and measure the *computed* contrast
// of real text nodes against their *effective* background (walking the DOM, compositing
// translucent layers + element opacity). This is what catches structural bugs the palette
// audit can't — e.g. a control that keeps its dark-surface color on the inverted (light)
// selection row (the start-button bug). Run: bun run src/web/a11y.e2e.ts
import { chromium, type Page } from "playwright";

const PORT = Number(process.env.E2E_PORT) || 7490;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const THEMES = ["phosphor", "amber", "ice", "paper", "mono", "frost", "sage", "linen"];
const AA = 4.5;

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
const MEASURE = (selectors: string[]) => {
  const parse = (s: string) => {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return { r: 0, g: 0, b: 0, a: 0 };
    const [r, g, b, a] = m[1].split(",").map((x) => parseFloat(x));
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
    const el = document.querySelector(sel);
    if (!el) return { sel, found: false, ratio: 0 };
    const cs = getComputedStyle(el);
    const bg = effBg(el);
    const fg = over({ ...parse(cs.color), a: parse(cs.color).a * parseFloat(cs.opacity || "1") }, bg);
    return { sel, found: true, ratio: Math.round(ratio(fg, bg) * 100) / 100, text: (el.textContent || "").trim().slice(0, 24) };
  });
};

// the text surfaces that must stay readable in every theme
const SELECTORS = [
  ".mrow.sel .btn", // THE start-button bug: control on the inverted selection row
  ".mrow.sel .mstatus", // status text on the selection row (has opacity)
  ".mrow.sel .mname", // mesh name on selection row
  ".panel > .head", // panel headers (fg-dim, was the low-contrast complaint)
  ".brand", // topbar brand
  ".topbar .stat", // topbar status text
];

const server = Bun.spawn(["bun", "run", "src/main.ts", "--fake", "--port", String(PORT)], { stdout: "pipe", stderr: "pipe" });
const browser = await chromium.launch({ headless: true });
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

  for (const theme of THEMES) {
    await step(`theme "${theme}": all rendered text ≥ ${AA}:1 (WCAG AA)`, async () => {
      await page.evaluate((t) => localStorage.setItem("mesh.theme", t), theme);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".mrow.sel .btn", { timeout: 8000 });
      // kill transitions/animations so colors are measured at their settled steady state,
      // not mid-tween (.btn animates color 120ms on selection) — this is about test
      // determinism, not the styling itself.
      await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
      await sleep(60);
      const rows = await page.evaluate(MEASURE, SELECTORS);
      const bad = rows.filter((r) => r.found && r.ratio < AA);
      const missing = rows.filter((r) => !r.found);
      if (missing.length) throw new Error(`selectors not found: ${missing.map((m) => m.sel).join(", ")}`);
      if (bad.length)
        throw new Error(bad.map((b) => `${b.sel} "${(b as any).text}" = ${b.ratio}:1`).join(" · "));
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
    console.log("  A11Y E2E OK — rendered contrast meets WCAG AA in every theme");
  }
} finally {
  await browser.close();
  server.kill();
}
