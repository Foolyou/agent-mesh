// Hand-rolled SVG topology: router centered, members on a ring, directed mail edges
// with arrowheads, nodes colored by live agent status. Zero graph-lib dependency.
import type { MeshSummary, AgentStatus } from "../types";

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

export function Topology({
  summary,
  selectedAgent,
  onSelect,
  flashId,
}: {
  summary: MeshSummary;
  selectedAgent: string | null;
  onSelect: (id: string) => void;
  flashId?: string | null;
}) {
  const live = summary.status === "running" || summary.status === "starting";
  const router = summary.agents.find((a) => a.id === summary.router) ?? summary.agents[0];
  const members = summary.agents.filter((a) => a.id !== router?.id);

  const n = members.length;
  const R = Math.max(120, 30 * n);
  const W = 640;
  const H = n === 0 ? NODE_H + 60 : 2 * R + NODE_H + 70;
  const cx = W / 2;
  const cy = H / 2;

  const pos = new Map<string, { x: number; y: number }>();
  if (router) pos.set(router.id, { x: cx, y: cy });
  members.forEach((m, i) => {
    const theta = (2 * Math.PI * i) / Math.max(1, n) - Math.PI / 2;
    pos.set(m.id, { x: cx + R * Math.cos(theta), y: cy + R * Math.sin(theta) });
  });

  function trim(from: { x: number; y: number }, to: { x: number; y: number }, inset: number) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: to.x - (dx / len) * inset, y: to.y - (dy / len) * inset };
  }

  function color(status: AgentStatus): string {
    if (!live) return STATUS_COLOR.stopped;
    return STATUS_COLOR[status] ?? STATUS_COLOR.stopped;
  }

  const svgH = Math.min(320, H);
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
          return <line key={i} className="edge" x1={start.x} y1={start.y} x2={end.x} y2={end.y} markerEnd="url(#arrow)" />;
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
