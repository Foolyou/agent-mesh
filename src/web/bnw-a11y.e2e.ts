// Step 7.2-B — focused a11y crawl of the REAL /bnw console across all 9 v2 mode×accent
// combinations (3 mode × 3 accent), per the Step-7 gate. Boots the web server over a FAKE
// gateway, seeds an approved device token, and for each combo sets the persisted v2
// mode/accent (no legacy theme key → initTheme applies compose()), loads representative
// populated /bnw routes (overview + board list/detail), and asserts every painted text node
// meets WCAG AA. Run: bun run src/web/bnw-a11y.e2e.ts
import { WebGateway } from "./gateway";
import { startWebServer } from "./server";
import { authedContext, launchChromium, provisionE2eAuth } from "./e2e-playwright";
import { rm } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeRecord } from "../mesh-registry";
import type { Page } from "playwright";
import type { MeshEvent, MeshConfig } from "../acp/types";

const MODES = ["dark-slate", "light-cool", "eye-care-warm"] as const;
const ACCENTS = ["signal-teal", "ember", "fleet-azure"] as const;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const cfg = (name: string): MeshConfig => ({ name, agents: [{ id: "router", harness: "claude", project: "p", role: "router" }, { id: "codex-1", harness: "codex", project: "p", role: "member" }], edges: [{ from: "router", to: "codex-1" }] });
const mkTask = (id: number, o: Record<string, unknown> = {}) => ({ id, title: `task ${id}`, status: "todo", priority: "normal", deps: [], subtasks: [], subtaskSeq: 0, revision: 1, createdBy: "router", createdAt: "", updatedAt: "", comments: [], mailEventIds: [], ...o });
const BOARD = {
  mesh: "demo", revision: 4, epicSeq: 1, taskSeq: 12, labelSeq: 1,
  epics: [{ id: "epic-1", seq: 1, title: "Onboarding", status: "in_progress", revision: 1, createdBy: "router", createdAt: "", updatedAt: "", comments: [] }],
  labels: [{ id: "label-1", name: "ui", color: "#bae6fd" }],
  tasks: [
    mkTask(12, { epicId: "epic-1", title: "Add device-auth page", status: "in_review", assignee: "codex-1", priority: "high", labelIds: ["label-1"], comments: [{ author: "router", text: "dispatched", ts: "" }] }),
    mkTask(9, { epicId: "epic-1", title: "Token contrast audit", status: "todo", assignee: "router" }),
  ],
};
const fake: any = {
  on(_l: (n: string, e: MeshEvent) => void) { return () => {}; },
  listMeshes() { return [{ name: "demo", defined: true, status: "stopped" }]; },
  configOf(n: string) { return cfg(n); }, routerOf() { return "router"; },
  async startMesh() {}, async stopMesh() {}, async promptRouter() {}, promptAgent() {}, resolvePermission() {},
  async setMode() {}, async setModel() {}, async setAgentEffort() {}, interruptAgent() {}, wakeAgent() {},
  async newAgentSession() {}, async newAllSessions() {}, stopAgent() {}, removeQueuedTurn() {}, steerAgent() {},
  async addEdge() {}, async addAgent() {}, async readBoard() { return BOARD; }, async boardCommand() { return { ok: true, state: BOARD, change: {} }; },
  async defineMesh() {}, async deleteMesh() {}, async loadDefinitions() {}, async stopAll() {},
};

// ── ported color math + crawler (kept in sync with a11y.e2e.ts) ───────────────
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
const CRAWL = () => {
  const { parse, over, ratio, effBg } = (window as any).__a11y;
  const AAt = 4.5, AAlarge = 3.0, DISABLED_FLOOR = 3.0;
  const offenders: any[] = [];
  let scanned = 0;
  const hasOwnText = (el: Element) => { for (const n of Array.from(el.childNodes)) if (n.nodeType === 3 && (n.textContent || "").trim().length > 0) return true; return false; };
  const isDisabled = (el: Element) => !!(el as any).disabled || el.getAttribute("aria-disabled") === "true" || !!el.closest("[disabled],[aria-disabled='true'],:disabled");
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity || "1") === 0) continue;
    if (!(el as HTMLElement).offsetParent && cs.position !== "fixed") continue;
    if ((el as HTMLElement).getClientRects().length === 0) continue;
    if (!hasOwnText(el)) continue;
    scanned++;
    const bg = effBg(el);
    const color = parse(cs.color);
    const elOpacity = parseFloat(cs.opacity || "1");
    const fg = over({ ...color, a: color.a * elOpacity }, bg);
    const r = ratio(fg, bg);
    const px = parseFloat(cs.fontSize) || 0;
    const bold = (parseInt(cs.fontWeight) || 400) >= 700;
    const large = px >= 24 || (px >= 18.66 && bold);
    const disabled = isDisabled(el);
    const need = disabled ? DISABLED_FLOOR : large ? AAlarge : AAt;
    if (r < need - 0.005) offenders.push({ tag: el.tagName.toLowerCase(), cls: (el.getAttribute("class") || "").slice(0, 36), text: (el.textContent || "").trim().slice(0, 28), ratio: Math.round(r * 100) / 100, need, disabled });
  }
  return { offenders, scanned };
};
const installColorMath = (page: Page) => page.evaluate(`window.__a11y = (function(){ ${COLOR_MATH} return { parse, over, lum, ratio, effBg }; })();`);

const auth = await provisionE2eAuth();
// Seed the diagnostics run dir so the real /bnw/doctor surface paints a populated daemon +
// recovery panel (live daemon record + orphan socket) for the contrast crawl.
const RUN_DIR = join(auth.authRoot, "run");
mkdirSync(RUN_DIR, { recursive: true });
await writeRecord(RUN_DIR, { name: "dev-mesh", pid: process.pid, socketPath: join(RUN_DIR, "dev-mesh.sock"), proto: 2, startedAt: new Date(Date.now() - 3_600_000).toISOString() });
writeFileSync(join(RUN_DIR, "dev-mesh.sock"), "");
writeFileSync(join(RUN_DIR, "old-mesh.sock"), ""); // orphan socket → leak row
const gw = new WebGateway(fake, undefined, { root: auth.authRoot });
const handle = startWebServer({ gateway: gw, port: 0, dev: false });
const BASE = handle.url;
const browser = await launchChromium();
let pass = 0; const fails: string[] = [];

async function crawl(page: Page, label: string) {
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  await installColorMath(page);
  const { offenders, scanned } = await page.evaluate(CRAWL) as { offenders: any[]; scanned: number };
  if (scanned < 12) throw new Error(`${label}: only ${scanned} text nodes scanned — not rendered`);
  if (offenders.length) throw new Error(`${label}: ${offenders.length} below AA (scanned ${scanned}): ` + offenders.slice(0, 6).map((o) => `<${o.tag}.${o.cls}> "${o.text}"=${o.ratio} need ${o.need}${o.disabled ? " [disabled]" : ""}`).join(" · "));
}

try {
  const ctx = await authedContext(browser, auth.token, { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  // The harness probe is host-dependent; stub it so /bnw/harnesses paints deterministic rows
  // (ok / outdated+auth / self-install + old-version agent) for the contrast crawl.
  await page.route("**/api/harnesses", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
    { id: "claude", label: "Claude", installed: true, version: "1.4.2", toolVersion: "0.141.0", latest: "1.4.2", outdated: false, auth: "ok", installable: "npm", lastProbeAt: 0, runningAgentsUsingOldVersion: [] },
    { id: "codex", label: "Codex", installed: true, version: "1.2.3", toolVersion: "0.140.0", latest: "1.2.5", outdated: true, auth: "required", installable: "npm", lastProbeAt: 0, runningAgentsUsingOldVersion: ["demo/codex-1"] },
    { id: "opencode", label: "OpenCode", installed: false, auth: "unknown", installable: "self", installHint: { command: "npm i -g opencode", docsUrl: "https://opencode.example/docs" }, lastProbeAt: 0, runningAgentsUsingOldVersion: [] },
    { id: "kimi", label: "Kimi", installed: true, auth: "unknown", installable: "self", installHint: { command: "npm i -g @moonshot/kimi", docsUrl: "https://kimi.example/docs" }, lastProbeAt: 0, runningAgentsUsingOldVersion: [] },
  ]) }));
  // Feishu channel is absent in the fake gateway → stub status so /bnw/channels paints a running
  // channel with a binding (auth-admin sections are static placeholders) for the contrast crawl.
  await page.route("**/api/channels/feishu/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "running", configPath: "channels/feishu.json", configured: true, enabled: true, appId: "cli_demo", domain: "feishu", bindings: [{ mesh: "demo", chatId: "oc_demo123", name: "demo 群", source: "auto", requireMention: true }], updatedAt: "" }) }));
  // file-viewer: stub a markdown artifact so /bnw/.../file/report.md paints rendered content.
  await page.route("**/api/agents/router/files/report.md", (r) => r.fulfill({ status: 200, contentType: "text/markdown", body: "# Gate summary\n\nThe device-auth gate is ready for review.\n" }));
  await page.goto(`${BASE}/bnw/`, { waitUntil: "domcontentloaded" }); // establish origin for localStorage

  // A separate UNAUTHENTICATED page (no device token) so the /bnw device-auth gate (mockup 12)
  // renders for the contrast crawl — the gate replaces the console until a device is approved.
  const anonCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const anonPage = await anonCtx.newPage();
  await anonPage.goto(`${BASE}/bnw/`, { waitUntil: "domcontentloaded" });

  for (const mode of MODES) {
    for (const accent of ACCENTS) {
      const combo = `${mode} × ${accent}`;
      try {
        // persist the v2 composition + clear any legacy theme so initTheme applies compose()
        await page.evaluate(([m, a]) => { localStorage.setItem("mesh.theme.mode", m); localStorage.setItem("mesh.theme.accent", a); localStorage.removeItem("mesh.theme"); }, [mode, accent]);
        // overview (real snapshot agents)
        await page.goto(`${BASE}/bnw/mesh/demo`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-bnw-agents]', { timeout: 8000 });
        await sleep(60); await crawl(page, `${combo} · overview`);
        // board list (real readBoard fetch)
        await page.goto(`${BASE}/bnw/mesh/demo/board`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-bnw-board-list]', { timeout: 8000 });
        await sleep(60); await crawl(page, `${combo} · board-list`);
        // board list with the label manager open (#24 — palette swatches + inputs)
        await page.locator('[aria-label="manage labels"]').click();
        await page.waitForSelector('[data-bnw-board-labels]', { timeout: 8000 });
        await sleep(60); await crawl(page, `${combo} · board-labels`);
        // board fullscreen (#22)
        await page.locator('[aria-label="fullscreen"]').click();
        await page.waitForSelector('[data-bnw-board-fs]', { timeout: 8000 });
        await sleep(60); await crawl(page, `${combo} · board-fullscreen`);
        // kanban
        await page.goto(`${BASE}/bnw/mesh/demo/board?view=kanban`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-bnw-board-kanban]', { timeout: 8000 });
        await sleep(60); await crawl(page, `${combo} · board-kanban`);
        // board detail (status/comment/dispatch controls painted)
        await page.goto(`${BASE}/bnw/mesh/demo/board/issue/12`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-bnw-board-detail]', { timeout: 8000 });
        await sleep(60); await crawl(page, `${combo} · board-detail`);
        // 7.3 — new-mesh builder + expanded focus-trap editor
        await page.goto(`${BASE}/bnw/mesh/new?nmEditor=charter`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-bnw-editor]', { timeout: 8000 });
        await sleep(60); await crawl(page, `${combo} · new-mesh+editor`);
        // 7.3 — assistant
        await page.goto(`${BASE}/bnw/assistant`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-bnw-assistant="panel"]', { timeout: 8000 });
        await sleep(60); await crawl(page, `${combo} · assistant`);
        // 7.4-A — doctor (summary + findings + daemon table + recovery/leak rows)
        await page.goto(`${BASE}/bnw/doctor`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-recovery] [data-leak]', { timeout: 8000 });
        await sleep(60); await crawl(page, `${combo} · doctor`);
        // 7.4-A.2a — harnesses (rows + status/auth chips + self-install guide + old-version agents)
        await page.goto(`${BASE}/bnw/harnesses`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-old-agents] [data-old-agent]', { timeout: 8000 });
        await sleep(60); await crawl(page, `${combo} · harnesses`);
        // 7.4-A.2b-i — channels (status + bindings + auth-admin placeholders)
        await page.goto(`${BASE}/bnw/channels`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-bindings] [data-binding]', { timeout: 8000 });
        await sleep(60); await crawl(page, `${combo} · channels`);
        // 7.4-A.2b-ii — file/artifact viewer (rendered markdown + header/back)
        await page.goto(`${BASE}/bnw/mesh/demo/agent/router/file/report.md`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-artifact-kind="markdown"]', { timeout: 8000 });
        await sleep(60); await crawl(page, `${combo} · file-viewer`);
        // 7.4-B — settings appearance (mode/accent + 9-combo live grid)
        await page.goto(`${BASE}/bnw/settings`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-theme-matrix] [data-theme-cell]', { timeout: 8000 });
        await sleep(60); await crawl(page, `${combo} · settings`);
        // 7.4-A.2b-ii — device-auth gate (unauthenticated page; mockup 12)
        await anonPage.evaluate(([m, a]) => { localStorage.setItem("mesh.theme.mode", m); localStorage.setItem("mesh.theme.accent", a); localStorage.removeItem("mesh.theme"); }, [mode, accent]);
        await anonPage.goto(`${BASE}/bnw/`, { waitUntil: "domcontentloaded" });
        await anonPage.waitForSelector('[data-device-code]', { timeout: 8000 });
        await sleep(60); await crawl(anonPage, `${combo} · device-auth`);
        pass++; console.log(`  ✓ ${combo}`);
      } catch (e: any) {
        fails.push(combo); console.log(`  ✗ ${combo} — ${String(e?.message ?? e).split("\n")[0]}`);
      }
    }
  }
  if (fails.length) throw new Error(`/bnw a11y failed in ${fails.length}/9 combos: ${fails.join(", ")}`);
  console.log(`BNW A11Y OK — /bnw × 9 mode×accent combos all ≥ AA (${pass}/9)`);
} finally {
  await browser.close();
  handle.stop();
  await rm(auth.meshRootBase, { recursive: true, force: true });
}
