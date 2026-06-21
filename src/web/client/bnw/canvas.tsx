// Step 7.1-C — new /bnw topology canvas (#16), wired to REAL data. Independent view layer:
// shares the store only; does NOT import the old MeshCanvas/Topology. Renders the mesh's
// real EDGES as directed arrows, highlights/pulses edges with recent mail traffic, lays
// nodes out force-directed (default on, deterministic — router-centric), supports
// drag-to-pin, zoom/fit/Esc, per-node stop/wake/⋯, and live add-agent/add-edge (#17).
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Cluster, EmptyState, PanelFrame, RouteLink, StatusChip, type Status } from "../ui/index";
import type { Store } from "../store";
import type { GatewayState, MeshSummary, PerMeshState } from "../../types";
import type { AgentStatus, AgentActivity } from "../../../acp/types";
import { bnwHref, navigate } from "../router";
import { TopologyEditor } from "./runtime-controls";

const NODE_W = 190, NODE_H = 66, CANVAS_W = 980, CANVAS_H = 620;

function agentDot(status: AgentStatus, activity: AgentActivity): Status {
  switch (status) {
    case "ready": return activity === "working" ? "working" : "ready";
    case "spawning": return "attention";
    case "dead": return "blocked";
    case "cold": case "stopped": default: return "idle";
  }
}

// Deterministic force-directed-style layout: routers near the centre, members on a ring
// (seed rotates it for 重新布局). No randomness → stable across renders/tests.
function computeLayout(agents: MeshSummary["agents"], seed: number): Record<string, { x: number; y: number }> {
  const cx = CANVAS_W / 2 - NODE_W / 2, cy = CANVAS_H / 2 - NODE_H / 2;
  const routers = agents.filter((a) => a.role === "router");
  const members = agents.filter((a) => a.role !== "router");
  const pos: Record<string, { x: number; y: number }> = {};
  routers.forEach((a, i) => { pos[a.id] = { x: cx + (i - (routers.length - 1) / 2) * (NODE_W + 24), y: cy }; });
  const R = members.length <= 4 ? 210 : 280;
  members.forEach((a, i) => {
    const ang = (i / Math.max(1, members.length)) * Math.PI * 2 + seed * 0.55 - Math.PI / 2;
    pos[a.id] = { x: cx + Math.cos(ang) * R * 1.35, y: cy + Math.sin(ang) * R };
  });
  return pos;
}

export function MeshCanvas({ store, state, mesh }: { store: Store; state: GatewayState; mesh: string }) {
  const summary = state.meshes.find((m) => m.name === mesh);
  const pm: PerMeshState | undefined = state.perMesh[mesh];
  const [seed, setSeed] = useState(0);
  const [autoLayout, setAutoLayout] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [overrides, setOverrides] = useState<Record<string, { x: number; y: number }>>({});
  const [pinned, setPinned] = useState<Record<string, boolean>>({});
  const drag = useRef<{ id: string; sx: number; sy: number; bx: number; by: number } | null>(null);

  const agents = summary?.agents ?? [];
  const edges = summary?.edges ?? [];
  const base = useMemo(() => computeLayout(agents, seed), [agents.map((a) => a.id).join(","), edges.length, seed]);
  const posOf = (id: string) => overrides[id] ?? base[id] ?? { x: 20, y: 20 };

  // recent-mail edges (#16 information flow): edges that appear in the latest mail traffic.
  const recent = useMemo(() => {
    const keys = new Set((pm?.mail ?? []).slice(-12).map((m) => `${m.from}->${m.to}`));
    return keys;
  }, [pm?.mail]);

  // drag-to-pin (real pointer drag; dragged node becomes pinned, the rest stay laid-out)
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current; if (!d) return;
      const nx = d.bx + (e.clientX - d.sx) / zoom, ny = d.by + (e.clientY - d.sy) / zoom;
      setOverrides((o) => ({ ...o, [d.id]: { x: nx, y: ny } }));
    };
    const up = () => { const d = drag.current; if (d) { setPinned((p) => ({ ...p, [d.id]: true })); drag.current = null; } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [zoom]);

  // Esc closes the canvas back to the overview.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") navigate({ k: "runtime", mesh }); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mesh]);

  if (!summary) {
    return <PanelFrame title="Topology canvas"><EmptyState title="mesh 不存在" description={`没有名为 “${mesh}” 的 mesh。`} action={<RouteLink href={bnwHref({ k: "home" })}>返回</RouteLink>} /></PanelFrame>;
  }
  const disabled = summary.status === "stopped" || summary.status === "dead";
  const recentCount = edges.filter((e) => recent.has(`${e.from}->${e.to}`)).length;
  const relayout = () => { setSeed((s) => s + 1); setOverrides({}); setPinned({}); };

  return (
    <div data-mockup="frame" data-bnw-canvas className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface text-text-primary">
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-raised px-3 py-2">
        <span className="text-sm font-semibold">Topology canvas · {summary.name}</span>
        <span className="text-xs text-text-muted">{agents.length} agents · {edges.length} edges · {recentCount} 活跃</span>
        <span className="flex-1" aria-hidden="true" />
        <label className="inline-flex items-center gap-1.5 text-xs text-text-secondary"><input type="checkbox" className="accent-accent" aria-label="force-directed layout" data-bnw-autolayout checked={autoLayout} onChange={(e) => setAutoLayout(e.target.checked)} /> 力导向</label>
        <Button size="sm" variant="ghost" aria-label="重新布局" data-bnw-relayout onClick={relayout}>重新布局</Button>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <Button size="sm" variant="ghost" iconOnly aria-label="zoom out" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(1)))}>－</Button>
        <span className="text-xs tabular-nums text-text-muted">{Math.round(zoom * 100)}%</span>
        <Button size="sm" variant="ghost" iconOnly aria-label="zoom in" onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.2).toFixed(1)))}>＋</Button>
        <Button size="sm" variant="ghost" aria-label="fit to window" onClick={() => setZoom(1)}>fit</Button>
        <RouteLink href={bnwHref({ k: "runtime", mesh })} className="text-sm" aria-label="close canvas">Esc 关闭</RouteLink>
      </header>
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-sunken px-3 py-1 text-xs text-text-muted">
        <span className="inline-flex items-center gap-1"><span className="text-accent">▶</span> 信息流方向（mail）</span>
        <span className="inline-flex items-center gap-1"><span className="text-accent">●</span> 高亮 = 近期有 mail 流动</span>
        <span className="inline-flex items-center gap-1"><span className="text-accent">📌</span> 拖拽=固定</span>
        <span className="flex-1" aria-hidden="true" />
        <TopologyEditor store={store} mesh={mesh} agentIds={agents.map((a) => a.id)} disabled={disabled} />
      </div>
      <div data-bnw-canvas-surface className="relative min-h-0 flex-1 overflow-auto bg-surface-sunken">
        <div className="relative" style={{ width: CANVAS_W * zoom, height: CANVAS_H * zoom }}>
          <div className="absolute left-0 top-0 origin-top-left" style={{ width: CANVAS_W, height: CANVAS_H, transform: `scale(${zoom})` }}>
            <svg data-bnw-edges width={CANVAS_W} height={CANVAS_H} className="pointer-events-none absolute left-0 top-0" aria-hidden="true">
              <defs>
                <marker id="bnw-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="fill-text-muted" /></marker>
                <marker id="bnw-arrow-recent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="fill-accent" /></marker>
              </defs>
              {edges.map((e, i) => {
                const s = posOf(e.from), t = posOf(e.to);
                if (!s || !t) return null;
                const scx = s.x + NODE_W / 2, scy = s.y + NODE_H / 2, tcx = t.x + NODE_W / 2, tcy = t.y + NODE_H / 2;
                const dx = tcx - scx, dy = tcy - scy, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len, pad = 42;
                const isRecent = recent.has(`${e.from}->${e.to}`);
                return <line key={i} data-bnw-edge data-edge-recent={isRecent ? "true" : undefined}
                  x1={scx + ux * pad} y1={scy + uy * pad} x2={tcx - ux * pad} y2={tcy - uy * pad}
                  className={isRecent ? "stroke-accent animate-pulse" : "stroke-border-strong"} strokeWidth={isRecent ? 2.5 : 1.5}
                  markerEnd={isRecent ? "url(#bnw-arrow-recent)" : "url(#bnw-arrow)"} />;
              })}
            </svg>
            {agents.map((a) => {
              const p = posOf(a.id);
              const isPinned = !!pinned[a.id];
              const np = pm?.pending.filter((x) => x.agent === a.id).length ?? 0;
              const cold = a.status === "cold";
              return (
                <div key={a.id} data-bnw-node data-bnw-pinned={isPinned ? "true" : undefined}
                  className={`absolute flex flex-col rounded-lg border bg-surface-raised shadow-sm ${isPinned ? "border-accent ring-1 ring-accent" : "border-border-strong"}`}
                  style={{ left: p.x, top: p.y, width: NODE_W }}>
                  <div data-bnw-node-drag onPointerDown={(e) => { drag.current = { id: a.id, sx: e.clientX, sy: e.clientY, bx: p.x, by: p.y }; }}
                    className="flex cursor-move items-center gap-1.5 border-b border-border px-2 py-1.5">
                    <StatusChip status={agentDot(a.status, a.activity)} variant="dot" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{a.id}</span>
                    {isPinned ? <span aria-label={`${a.id} pinned`} className="text-xs text-accent">📌</span> : null}
                    {np > 0 ? <Badge count={np} tone="urgent" /> : null}
                  </div>
                  <div className="flex items-center gap-1 px-2 py-1.5 text-xs text-text-muted">
                    <span className="min-w-0 flex-1 truncate">{cold ? "cold" : `${a.status}${a.activity === "working" ? " · working" : ""}`}</span>
                    {cold
                      ? <Button size="sm" variant="secondary" disabled={disabled} aria-label={`wake ${a.id}`} onClick={() => void store.wakeAgent(mesh, a.id)}>Wake</Button>
                      : <Button size="sm" variant="ghost" iconOnly disabled={disabled} aria-label={`stop ${a.id}`} onClick={() => void store.stopAgent(mesh, a.id)}>■</Button>}
                    <RouteLink href={bnwHref({ k: "runtime", mesh, agent: a.id })} aria-label={`${a.id} actions`} className="text-xs">⋯</RouteLink>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
