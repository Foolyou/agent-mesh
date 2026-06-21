// DesignSync export — generate a fully-standalone HTML bundle of the completed Phase B
// `/__ui-mockup` set, for upload to claude.ai/design. Reuses the ui-mockup.e2e.ts harness
// (provisionE2eAuth + --fake server + Playwright), navigates a curated ~46-card subset of
// the 13 surfaces × device × representative states (+ the ?index=1 overview), and for each
// writes a self-contained HTML file: first line `<!-- @dsCard group="..." -->`, all CSS
// inlined into <style>, the live compose() :root vars carried on <html style>, and the
// captured frame/index outerHTML in <body>. No external <link>, no network, renders offline.
//
// The mockup uses zero <img> tags (emoji + CSS placeholders only), so there are no external
// image dependencies to data-URI or neutralize.
//
// Run: `bun run src/web/ui-mockup-export.ts`  (output → dist-dssync/, git-ignored).
import { type Page } from "playwright";
import { launchChromium, provisionE2eAuth, authedReady } from "./e2e-playwright";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.E2E_PORT) || 7475;
const BASE = `http://localhost:${PORT}`;
const TONE = "mode=dark-slate&accent=signal-teal";
const OUT = resolve(process.env.DSSYNC_OUT || "dist-dssync");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Curated card set: representative states per surface (always populated where meaningful,
// plus 1–2 high-information states from the coverage matrix), + the index overview.
interface Card { file: string; group: string; q: string }
const C = (file: string, group: string, q: string): Card => ({ file, group, q });
const CARDS: Card[] = [
  C("00-index-overview", "总览 Overview", "index=1"),

  C("01-shell-populated-desktop", "应用外壳 App shell", "surface=shell&state=populated&device=desktop"),
  C("01-shell-boundary-desktop", "应用外壳 App shell", "surface=shell&state=boundary&device=desktop"),
  C("01-shell-offline-desktop", "应用外壳 App shell", "surface=shell&state=offline&device=desktop"),
  C("01-shell-populated-mobile", "应用外壳 App shell", "surface=shell&state=populated&device=mobile"),

  C("02-runtime-overview-desktop", "运行态 Runtime", "surface=runtime&runtime=overview&state=populated&device=desktop"),
  C("02-runtime-focus-desktop", "运行态 Runtime", "surface=runtime&runtime=focus&state=populated&device=desktop"),
  C("02-runtime-canvas-desktop", "运行态 Runtime", "surface=runtime&runtime=canvas&state=populated&device=desktop"),
  C("02-runtime-full-desktop", "运行态 Runtime", "surface=runtime&runtime=full&state=populated&device=desktop"),
  C("02-runtime-overview-mobile", "运行态 Runtime", "surface=runtime&runtime=overview&state=populated&device=mobile"),

  C("03-board-list-desktop", "看板 Board", "surface=board&board=list&state=populated&device=desktop"),
  C("03-board-detail-desktop", "看板 Board", "surface=board&board=detail&state=populated&device=desktop"),
  C("03-board-kanban-desktop", "看板 Board", "surface=board&board=kanban&state=populated&device=desktop"),
  C("03-board-list-boundary-desktop", "看板 Board", "surface=board&board=list&state=boundary&device=desktop"),
  C("03-board-list-mobile", "看板 Board", "surface=board&board=list&state=populated&device=mobile"),

  C("04-new-mesh-populated-desktop", "新建 New mesh", "surface=new-mesh&state=populated&device=desktop"),
  C("04-new-mesh-boundary-desktop", "新建 New mesh", "surface=new-mesh&state=boundary&device=desktop"),
  C("04-new-mesh-populated-mobile", "新建 New mesh", "surface=new-mesh&state=populated&device=mobile"),

  C("05-assistant-populated-desktop", "助手 Assistant", "surface=assistant&state=populated&device=desktop"),
  C("05-assistant-absent-desktop", "助手 Assistant", "surface=assistant&state=error&device=desktop"),
  C("05-assistant-populated-mobile", "助手 Assistant", "surface=assistant&state=populated&device=mobile"),

  C("06-harnesses-populated-desktop", "Harnesses", "surface=harnesses&state=populated&device=desktop"),
  C("06-harnesses-boundary-desktop", "Harnesses", "surface=harnesses&state=boundary&device=desktop"),
  C("06-harnesses-populated-mobile", "Harnesses", "surface=harnesses&state=populated&device=mobile"),

  C("07-channels-populated-desktop", "渠道 Channels", "surface=channels&state=populated&device=desktop"),
  C("07-channels-busy-desktop", "渠道 Channels", "surface=channels&state=busy&device=desktop"),
  C("07-channels-populated-mobile", "渠道 Channels", "surface=channels&state=populated&device=mobile"),

  C("08-doctor-populated-desktop", "Doctor / 系统", "surface=doctor&state=populated&device=desktop"),
  C("08-doctor-boundary-desktop", "Doctor / 系统", "surface=doctor&state=boundary&device=desktop"),
  C("08-doctor-populated-mobile", "Doctor / 系统", "surface=doctor&state=populated&device=mobile"),

  C("09-settings-populated-desktop", "设置 Settings", "surface=settings&state=populated&device=desktop"),
  C("09-settings-boundary-desktop", "设置 Settings", "surface=settings&state=boundary&device=desktop"),
  C("09-settings-populated-mobile", "设置 Settings", "surface=settings&state=populated&device=mobile"),

  C("10-notifications-populated-desktop", "通知 Notifications", "surface=notifications&state=populated&device=desktop"),
  C("10-notifications-offline-desktop", "通知 Notifications", "surface=notifications&state=offline&device=desktop"),
  C("10-notifications-populated-mobile", "通知 Notifications", "surface=notifications&state=populated&device=mobile"),

  C("11-artifact-populated-desktop", "文件 / 产物 Files", "surface=artifact&state=populated&device=desktop"),
  C("11-artifact-lightbox-desktop", "文件 / 产物 Files", "surface=artifact&state=populated&lb=1&device=desktop"),
  C("11-artifact-error-desktop", "文件 / 产物 Files", "surface=artifact&state=error&device=desktop"),
  C("11-artifact-populated-mobile", "文件 / 产物 Files", "surface=artifact&state=populated&device=mobile"),

  C("12-device-auth-permission-desktop", "设备授权 Device-auth", "surface=device-auth&state=permission&device=desktop"),
  C("12-device-auth-offline-desktop", "设备授权 Device-auth", "surface=device-auth&state=offline&device=desktop"),
  C("12-device-auth-permission-mobile", "设备授权 Device-auth", "surface=device-auth&state=permission&device=mobile"),

  C("13-global-populated-desktop", "全局状态 Global states", "surface=global&state=populated&device=desktop"),
  C("13-global-permission-desktop", "全局状态 Global states", "surface=global&state=permission&device=desktop"),
  C("13-global-offline-desktop", "全局状态 Global states", "surface=global&state=offline&device=desktop"),
];

const FONT_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const auth = await provisionE2eAuth({ MESH_UI_PREVIEW: "1" });
const server = Bun.spawn(["bun", "run", "src/main.ts", "run", "--fake", "--port", String(PORT)], { stdout: "pipe", stderr: "pipe", env: auth.env });
const browser = await launchChromium();
let ok = 0;
const fails: string[] = [];
const perGroup = new Map<string, number>();
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await authedReady(BASE, auth.token)).ok) break; } catch {}
    await sleep(250);
  }
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page: Page = await ctx.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  for (const card of CARDS) {
    const isIndex = card.q.includes("index=1");
    const target = isIndex ? "[data-mockup-index]" : '[data-mockup="frame"]';
    try {
      await page.goto(`${BASE}/__ui-mockup?${card.q}&${TONE}`, { waitUntil: "networkidle" });
      await page.waitForSelector(target, { timeout: 8000 });
      await sleep(120); // let compose()/applyComposition write :root vars
      const cap = await page.evaluate((sel) => {
        // Serialize the BROWSER-COMPILED cssRules (dev serves raw `@import "tailwindcss"`,
        // so fetching the <link> would miss the compiled output). Recursively FLATTEN
        // `@layer` blocks — Tailwind v4 hides its `@theme` static tokens (--spacing/
        // --radius-*/--text-*) inside `@layer theme { :root {...} }`, and a plain
        // `cssRules`-cssText concat drops them. Keep @media/@supports wrappers; skip
        // @import (drops the legacy Google-Fonts import → no network dependency).
        const flatten = (rules: CSSRuleList): string => {
          let css = "";
          for (const rule of Array.from(rules)) {
            const name = rule.constructor && rule.constructor.name;
            if (name === "CSSImportRule" || name === "CSSLayerStatementRule") continue;
            if (name === "CSSLayerBlockRule") {
              css += flatten((rule as CSSGroupingRule).cssRules);
            } else if ((name === "CSSMediaRule" || name === "CSSSupportsRule") && (rule as CSSGroupingRule).cssRules) {
              const head = rule.cssText.slice(0, rule.cssText.indexOf("{") + 1);
              css += head + flatten((rule as CSSGroupingRule).cssRules) + "}\n";
            } else {
              css += rule.cssText + "\n";
            }
          }
          return css;
        };
        let css = "";
        for (const sheet of Array.from(document.styleSheets)) {
          try { css += flatten(sheet.cssRules); } catch { /* cross-origin (none expected) */ }
        }
        const el = document.querySelector(sel);
        return {
          css,
          rootStyle: document.documentElement.getAttribute("style") || "",
          html: el ? el.outerHTML : "",
        };
      }, target);
      if (!cap.html) throw new Error("target element not found");
      // Strip @import rules (legacy theme.css pulls IBM Plex Mono from Google Fonts) so the
      // file has NO network dependency — the mockup uses the system font stack anyway.
      const css = cap.css.replace(/@import\b[^;]*;/g, "");
      if (!css || css.length < 500) throw new Error(`suspiciously small CSS (${css.length})`);
      if (/@import|url\(\s*https?:|src\s*=\s*"https?:/i.test(css)) throw new Error("external dependency leaked into inlined CSS");
      const rootStyle = cap.rootStyle.replace(/"/g, "&quot;");
      const doc = `<!-- @dsCard group="${card.group}" -->
<!doctype html>
<html lang="zh" style="${rootStyle}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${card.file}</title>
<style>${css}</style>
<style>
  html { font-family: ${FONT_STACK}; }
  body { margin: 0; background: var(--surface, #0f172a); color: var(--text-primary, #e2e8f0);
         padding: 24px; display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; }
</style>
</head>
<body>${cap.html}</body>
</html>
`;
      writeFileSync(resolve(OUT, `${card.file}.html`), doc);
      perGroup.set(card.group, (perGroup.get(card.group) ?? 0) + 1);
      ok++;
      console.log(`  ✓ ${card.file}.html`);
    } catch (e: any) {
      fails.push(`${card.file} — ${String(e?.message ?? e).split("\n")[0]}`);
      console.log(`  ✗ ${card.file} — ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }

  if (pageErrors.length) fails.push(`page errors: ${pageErrors.slice(0, 3).join(" | ")}`);
} finally {
  await browser.close();
  server.kill();
}

console.log(`\nDSSYNC EXPORT: ${ok}/${CARDS.length} cards written`);
console.log(`localDir: ${OUT}`);
console.log("per-group:");
for (const [g, n] of [...perGroup.entries()].sort()) console.log(`  ${g}: ${n}`);
if (fails.length) {
  console.log("FAILED:", fails.join("; "));
  process.exit(1);
}
console.log("DSSYNC EXPORT OK");
