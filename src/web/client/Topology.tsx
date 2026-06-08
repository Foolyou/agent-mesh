// Hand-rolled SVG topology: router centered, members on a ring, directed mail edges
// with arrowheads, nodes colored by live agent status. Zero graph-lib dependency.
import { useState } from "react";
import type { MeshSummary, AgentStatus } from "../types";
import { Btn } from "./ui";
import { useI18n } from "./i18n";

const STATUS_COLOR: Record<string, string> = {
  ready: "var(--ok)",
  running: "var(--ok)",
  spawning: "var(--warn)",
  starting: "var(--warn)",
  dead: "var(--bad)",
  stopped: "var(--off)",
};

const NODE_W = 132;
const NODE_H = 46;
const ROUTER_EDGE_BEND = 22;
const MEMBER_EDGE_BEND = 150;

export function topologyNodePositions(summary: MeshSummary): { width: number; height: number; positions: Map<string, { x: number; y: number }> } {
  const router = summary.agents.find((a) => a.id === summary.router) ?? summary.agents[0];
  const members = summary.agents.filter((a) => a.id !== router?.id);

  const n = members.length;
  const R = Math.max(120, 30 * n);
  const width = 640;
  const height = n === 0 ? NODE_H + 60 : 2 * R + NODE_H + 70;
  const cx = width / 2;
  const cy = height / 2;

  const positions = new Map<string, { x: number; y: number }>();
  if (router) positions.set(router.id, { x: cx, y: cy });
  members.forEach((m, i) => {
    const theta = (2 * Math.PI * i) / Math.max(1, n) - Math.PI / 2;
    positions.set(m.id, { x: cx + R * Math.cos(theta), y: cy + R * Math.sin(theta) });
  });
  return { width, height, positions };
}

export function Topology({
  summary,
  selectedAgent,
  onSelect,
  flashId,
  maxHeight = 320,
}: {
  summary: MeshSummary;
  selectedAgent: string | null;
  onSelect: (id: string) => void;
  flashId?: string | null;
  maxHeight?: number;
}) {
  const live = summary.status === "running" || summary.status === "starting";
  const layout = topologyNodePositions(summary);
  const pos = layout.positions;
  const W = layout.width;
  const H = layout.height;

  function trim(from: { x: number; y: number }, to: { x: number; y: number }, inset: number) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: to.x - (dx / len) * inset, y: to.y - (dy / len) * inset };
  }

  function edgePath(fromId: string, toId: string, start: { x: number; y: number }, end: { x: number; y: number }) {
    const fromRouter = fromId === summary.router;
    const toRouter = toId === summary.router;
    const bend = fromRouter || toRouter ? ROUTER_EDGE_BEND : MEMBER_EDGE_BEND;
    const [lo, hi] = fromId < toId ? [fromId, toId] : [toId, fromId];
    const loPos = pos.get(lo) ?? start;
    const hiPos = pos.get(hi) ?? end;
    const dx = hiPos.x - loPos.x;
    const dy = hiPos.y - loPos.y;
    const len = Math.hypot(dx, dy) || 1;
    const side = fromId === lo ? 1 : -1;
    const nx = (-dy / len) * side;
    const ny = (dx / len) * side;
    const cx = (start.x + end.x) / 2 + nx * bend;
    const cy = (start.y + end.y) / 2 + ny * bend;
    return `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
  }

  function color(status: AgentStatus): string {
    if (!live) return STATUS_COLOR.stopped;
    return STATUS_COLOR[status] ?? STATUS_COLOR.stopped;
  }

  const svgH = Math.min(maxHeight, H);
  return (
    <div className="topo">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: "100%", height: svgH, display: "block" }}
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--line-bright)" />
          </marker>
        </defs>
        {/* edges first, nodes drawn over them */}
        {summary.edges.map(([from, to], i) => {
          const a = pos.get(from);
          const b = pos.get(to);
          if (!a || !b) return null;
          const start = trim(b, a, NODE_H / 2 + 6);
          const end = trim(a, b, NODE_H / 2 + 12);
          return <path key={i} className="edge" data-from={from} data-to={to} d={edgePath(from, to, start, end)} markerEnd="url(#arrow)" />;
        })}
        {summary.agents.map((a) => {
          const p = pos.get(a.id);
          if (!p) return null;
          const sel = a.id === selectedAgent;
          const flash = a.id === flashId;
          return (
            <g
              key={a.id}
              className={`node ${sel ? "sel" : ""} ${flash ? "flash" : ""}`}
              transform={`translate(${p.x - NODE_W / 2}, ${p.y - NODE_H / 2})`}
              onClick={() => onSelect(a.id)}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={3}
                style={{ stroke: color(a.status), strokeWidth: sel ? 2 : 1.2 }}
              />
              <circle cx={12} cy={12} r={4} fill={color(a.status)} />
              <text x={NODE_W / 2} y={20} textAnchor="middle">
                {a.id}
              </text>
              <text className="role" x={NODE_W / 2} y={34} textAnchor="middle">
                {a.role.toUpperCase()} · {a.harness}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Enlarged topology with zoom controls (overlay). */
export function TopologyModal({
  summary,
  selectedAgent,
  onSelect,
  onClose,
}: {
  summary: MeshSummary;
  selectedAgent: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [zoom, setZoom] = useState(1);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal topo-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mhead">
          <span style={{ flex: 1 }}>{t("topology")} — {summary.name}</span>
          <Btn small kind="ghost" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}>
            −
          </Btn>
          <span className="sub" style={{ width: 42, textAlign: "center" }}>
            {Math.round(zoom * 100)}%
          </span>
          <Btn small kind="ghost" onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}>
            +
          </Btn>
          <Btn small kind="ghost" onClick={() => setZoom(1)}>
            {t("reset")}
          </Btn>
          <Btn small kind="ghost" onClick={onClose}>
            ✕ {t("esc")}
          </Btn>
        </div>
        <div className="topo-zoomwrap">
          <div style={{ transform: `scale(${zoom})`, transformOrigin: "top center", width: "100%" }}>
            <Topology summary={summary} selectedAgent={selectedAgent} onSelect={onSelect} maxHeight={560} />
          </div>
        </div>
      </div>
    </div>
  );
}
