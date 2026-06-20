// ISOLATED high-fidelity page mockup (Step 6) — NOT part of the product.
//
// Route-guarded at /__ui-mockup (index.tsx mounts this for that path; server.ts
// serves the SPA shell there ONLY when MESH_UI_PREVIEW=1, same guard as the C8
// gallery). This checkpoint = the APPLICATION SHELL final mockup (desktop + mobile)
// from docs/design/ui/interaction/01-app-shell.md, built from the REAL C5–C7
// components (./ui/index) + the real v2 compose()/applyComposition() runtime, with
// FIXTURE data only — no backend, no store, no WS, no business-page migration.
//
// Query deep links for deterministic screenshots: ?device=desktop|mobile,
// ?view=runtime|board, ?mode=<mode>, ?accent=<accent>. No raw-* utilities (passes
// `bun run lint:tokens`); all classes literal so Tailwind emits them.
//
// Live review: `MESH_UI_PREVIEW=1 bun run src/main.ts run --fake --port 15080`
// then open http://localhost:15080/__ui-mockup (404s without the flag).
import { useEffect, useState, type ReactNode } from "react";
import { MODES, ACCENTS, type Mode, type Accent, compose, applyComposition } from "./themes";
import {
  Button, StatusChip, Badge, SegmentedControl, StatusListRow, PanelFrame,
  type Status,
} from "./ui/index";

const MODE_LABEL: Record<Mode, string> = { "dark-slate": "Dark·Slate", "light-cool": "Light·Cool", "eye-care-warm": "Eye-care·Warm" };
const ACCENT_LABEL: Record<Accent, string> = { "signal-teal": "Signal Teal", ember: "Ember", "fleet-azure": "Fleet Azure" };
const MODE_SET = new Set<Mode>(MODES);
const ACCENT_SET = new Set<Accent>(ACCENTS);

type Device = "desktop" | "mobile";
type View = "runtime" | "board";
const VIEW_LABEL: Record<View, string> = { runtime: "运行态", board: "看板" };

// Fixture meshes (no backend).
const MESHES: { id: string; status: Status }[] = [
  { id: "dev-mesh", status: "working" },
  { id: "alpha", status: "ready" },
  { id: "beta", status: "blocked" },
  { id: "docs-mesh", status: "idle" },
];

interface Sel {
  device: Device;
  view: View;
  mode: Mode;
  accent: Accent;
}

function readSel(): Sel {
  const search = typeof window !== "undefined" ? window.location.search : "";
  const p = new URLSearchParams(search);
  const m = p.get("mode");
  const a = p.get("accent");
  return {
    device: p.get("device") === "mobile" ? "mobile" : "desktop",
    view: p.get("view") === "board" ? "board" : "runtime",
    mode: MODE_SET.has(m as Mode) ? (m as Mode) : "dark-slate",
    accent: ACCENT_SET.has(a as Accent) ? (a as Accent) : "signal-teal",
  };
}

// ── shared shell pieces ──────────────────────────────────────────────────────
function Brand() {
  return (
    <span className="inline-flex items-center gap-1.5 font-semibold text-text-primary">
      <span className="text-accent" aria-hidden="true">◈</span> Mesh
    </span>
  );
}

function ConnectionChip({ compact = false }: { compact?: boolean }) {
  return compact ? <StatusChip status="ready" variant="dot" label="connected" /> : <StatusChip status="ready" variant="soft" label="connected" />;
}

function StagePlaceholder({ view }: { view: View }) {
  return (
    <PanelFrame
      title={VIEW_LABEL[view]}
      description={view === "runtime" ? "对话 / 转录 / 审批（下一检查点）" : "Epic → Task → Subtask 看板（下一检查点）"}
      actions={<SegmentedControl ariaLabel="Stage filter" value="all" onChange={() => {}} options={[{ value: "all", label: "全部" }, { value: "mine", label: "我的" }]} size="sm" />}
      className="h-full"
      bodyClassName="h-full"
    >
      <div className="flex h-full min-h-[260px] items-center justify-center rounded-lg border border-dashed border-border text-sm text-text-muted">
        {VIEW_LABEL[view]} 视图占位 — 本检查点只交付应用外壳
      </div>
    </PanelFrame>
  );
}

// ── desktop shell ────────────────────────────────────────────────────────────
function DesktopShell({ view, setView, mesh, setMesh }: { view: View; setView: (v: View) => void; mesh: string; setMesh: (m: string) => void }) {
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [ctxCollapsed, setCtxCollapsed] = useState(false);
  return (
    <div data-mockup="frame" data-device="desktop" className="w-[1280px] max-w-full overflow-hidden rounded-xl border border-border bg-surface text-text-primary shadow-sm">
      {/* topbar */}
      <header className="flex items-center gap-3 border-b border-border bg-surface-raised px-4 py-2.5">
        <Brand />
        <ConnectionChip />
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <label className="inline-flex items-center gap-1.5 text-sm">
          <span className="text-text-muted">mesh</span>
          <select value={mesh} onChange={(e) => setMesh(e.target.value)} aria-label="active mesh" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary">
            {MESHES.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          </select>
        </label>
        <SegmentedControl
          ariaLabel="View"
          value={view}
          onChange={(v) => setView(v as View)}
          options={[{ value: "runtime", label: "运行态" }, { value: "board", label: "看板" }]}
          size="sm"
        />
        <span className="flex-1" aria-hidden="true" />
        <Button variant="ghost" size="sm" iconOnly aria-label="通知 (3 未读)" className="relative">
          🔔<span className="absolute -right-1 -top-1"><Badge count={3} tone="urgent" /></span>
        </Button>
        <Button variant="ghost" size="sm">管理▾</Button>
        <Button variant="ghost" size="sm">设置▾</Button>
      </header>

      {/* body: left nav · stage · right context */}
      <div className="flex min-h-[520px]">
        <nav aria-label="meshes" className={`${navCollapsed ? "w-[56px]" : "w-[232px]"} shrink-0 border-r border-border bg-surface-raised p-2 transition-[width]`}>
          <div className="mb-2 flex items-center justify-between">
            {!navCollapsed ? <span className="px-1 text-xs uppercase tracking-wider text-text-muted">meshes</span> : null}
            <Button variant="ghost" size="sm" iconOnly aria-label={navCollapsed ? "展开导航" : "收起导航"} onClick={() => setNavCollapsed((c) => !c)}>{navCollapsed ? "»" : "«"}</Button>
          </div>
          {navCollapsed ? (
            <div className="flex flex-col items-center gap-2 pt-1">
              {MESHES.map((m) => <StatusChip key={m.id} status={m.status} variant="dot" />)}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {MESHES.map((m) => (
                <StatusListRow key={m.id} status={m.status} title={m.id} href={`/__ui-mockup?view=${view}`} active={m.id === mesh} />
              ))}
              <div className="mt-2"><Button variant="primary" size="sm" className="w-full">+ New mesh</Button></div>
            </div>
          )}
        </nav>

        <main className="min-w-0 flex-1 p-3"><StagePlaceholder view={view} /></main>

        {!ctxCollapsed ? (
          <aside aria-label="context" className="w-[288px] shrink-0 border-l border-border bg-surface-raised p-3">
            <PanelFrame
              title="Context"
              actions={<Button variant="ghost" size="sm" iconOnly aria-label="收起上下文" onClick={() => setCtxCollapsed(true)}>»</Button>}
            >
              <p className="text-sm text-text-secondary">按需上下文由当前视图拥有（运行态/看板各自填充）。</p>
            </PanelFrame>
          </aside>
        ) : (
          <div className="shrink-0 border-l border-border bg-surface-raised p-2">
            <Button variant="ghost" size="sm" iconOnly aria-label="展开上下文" onClick={() => setCtxCollapsed(false)}>«</Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── mobile shell ─────────────────────────────────────────────────────────────
type MobileTab = "runtime" | "board" | "more";
const MOBILE_TAB_LABEL: Record<MobileTab, string> = { runtime: "运行态", board: "看板", more: "更多" };

function MobileShell({ tab, setTab, mesh, setMesh }: { tab: MobileTab; setTab: (t: MobileTab) => void; mesh: string; setMesh: (m: string) => void }) {
  return (
    <div data-mockup="frame" data-device="mobile" className="relative flex h-[760px] w-[390px] max-w-full flex-col overflow-hidden rounded-[28px] border border-border bg-surface text-text-primary shadow-sm">
      {/* slim topbar */}
      <header className="flex items-center gap-2 border-b border-border bg-surface-raised px-3 py-2.5">
        <Brand />
        <ConnectionChip compact />
        <span className="flex-1" aria-hidden="true" />
        <select value={mesh} onChange={(e) => setMesh(e.target.value)} aria-label="active mesh" className="rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text-primary">
          {MESHES.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
        </select>
      </header>

      {/* active view */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === "more" ? (
          <PanelFrame title="更多">
            <div className="flex flex-col gap-1">
              <StatusListRow status="attention" title="🔔 通知" meta="3" href="/__ui-mockup?device=mobile" trailing={<Badge count={3} tone="urgent" />} />
              <StatusListRow status="ready" title="管理 · Assistant / Harnesses / Channels / Doctor" href="/__ui-mockup?device=mobile" />
              <StatusListRow status="ready" title="设置 · 主题 / 语言 / 鉴权 / 设备" href="/__ui-mockup?device=mobile" />
            </div>
          </PanelFrame>
        ) : (
          <StagePlaceholder view={tab} />
        )}
      </div>

      {/* bottom tabs */}
      <nav aria-label="主导航" role="tablist" className="flex items-stretch border-t border-border bg-surface-raised">
        {(["runtime", "board", "more"] as MobileTab[]).map((t) => {
          const active = t === tab;
          return (
            <button
              key={t}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t)}
              className={`flex-1 px-2 py-3 text-center text-xs font-medium ${active ? "text-accent" : "text-text-secondary"} focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring`}
            >
              {MOBILE_TAB_LABEL[t]}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

export function UiMockup() {
  const [sel, setSel] = useState<Sel>(readSel);
  const { device, view, mode, accent } = sel;
  const [mesh, setMesh] = useState(MESHES[0].id);
  const [mobileTab, setMobileTab] = useState<MobileTab>(view === "board" ? "board" : "runtime");

  useEffect(() => {
    applyComposition(compose(mode, accent));
  }, [mode, accent]);
  useEffect(() => {
    const onPop = () => setSel(readSel());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const nav = (next: Partial<Sel>) => {
    const merged = { ...sel, ...next };
    setSel(merged);
    const p = new URLSearchParams();
    p.set("device", merged.device);
    p.set("view", merged.view);
    p.set("mode", merged.mode);
    p.set("accent", merged.accent);
    window.history.replaceState({}, "", `/__ui-mockup?${p.toString()}`);
  };

  const setView = (v: View) => {
    nav({ view: v });
    if (v === "board" || v === "runtime") setMobileTab(v);
  };

  return (
    <div data-mockup="root" className="min-h-screen bg-surface text-text-primary font-sans p-6">
      {/* mockup tool chrome (outside the mocked app frame) */}
      <header className="mb-5">
        <h1 className="mb-1 text-xl font-semibold">Agent Mesh — 应用外壳终稿 mockup（Step 6 · {device === "mobile" ? "移动" : "桌面"}）</h1>
        <p className="mb-3 text-xs text-text-muted">真实 C5–C7 组件 + v2 compose 运行时 · fixture 数据 · 不连后端。Live: <code className="text-syntax-string">MESH_UI_PREVIEW=1 … /__ui-mockup</code></p>
        <div className="flex flex-wrap items-start gap-5">
          <div>
            <div className="mb-1.5 text-xs uppercase tracking-wider text-text-muted">设备</div>
            <SegmentedControl ariaLabel="Device" value={device} onChange={(d) => nav({ device: d as Device })} options={[{ value: "desktop", label: "桌面" }, { value: "mobile", label: "移动" }]} size="sm" />
          </div>
          <div>
            <div className="mb-1.5 text-xs uppercase tracking-wider text-text-muted">Background mode</div>
            <SegmentedControl ariaLabel="Background mode" value={mode} onChange={(m) => nav({ mode: m })} options={MODES.map((m) => ({ value: m, label: MODE_LABEL[m] }))} size="sm" />
          </div>
          <div>
            <div className="mb-1.5 text-xs uppercase tracking-wider text-text-muted">Accent</div>
            <SegmentedControl ariaLabel="Accent" value={accent} onChange={(a) => nav({ accent: a })} options={ACCENTS.map((a) => ({ value: a, label: ACCENT_LABEL[a] }))} size="sm" />
          </div>
        </div>
      </header>

      <div className="flex justify-center">
        {device === "mobile"
          ? <MobileShell tab={mobileTab} setTab={(t) => { setMobileTab(t); if (t === "runtime" || t === "board") nav({ view: t }); }} mesh={mesh} setMesh={setMesh} />
          : <DesktopShell view={view} setView={setView} mesh={mesh} setMesh={setMesh} />}
      </div>
    </div>
  );
}
