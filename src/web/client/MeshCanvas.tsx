import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Store } from "./store";
import type { MeshSummary, PerMeshState } from "../types";
import { Dot } from "./ui";
import { ChatPane } from "./ChatPane";
import { topologyNodePositions } from "./Topology";
import { useI18n } from "./i18n";

type Rect = { x: number; y: number; w: number; h: number };
type Layout = { sig: string; windows: Record<string, Rect> };

const DEFAULT_W = 360;
const DEFAULT_H = 320;
const MIN_W = 280;
const MIN_H = 220;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function layoutKey(mesh: string): string {
  return `mesh-canvas-layout:${mesh}`;
}

function signature(m: MeshSummary): string {
  const agents = m.agents.map((a) => a.id).sort().join("|");
  const edges = m.edges.map(([from, to]) => `${from}->${to}`).sort().join("|");
  return hash(`${agents}::${edges}`);
}

function hash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function autoLayout(m: MeshSummary): Record<string, Rect> {
  const seed = topologyNodePositions(m);
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const marginX = 44;
  const marginTop = 72;
  const marginBottom = 32;
  const availW = Math.max(DEFAULT_W, vw - marginX * 2);
  const availH = Math.max(DEFAULT_H, vh - marginTop - marginBottom);
  const rects: Record<string, Rect> = {};
  for (const a of m.agents) {
    const p = seed.positions.get(a.id) ?? { x: seed.width / 2, y: seed.height / 2 };
    const cx = marginX + (p.x / seed.width) * availW;
    const cy = marginTop + (p.y / seed.height) * availH;
    rects[a.id] = {
      x: clamp(cx - DEFAULT_W / 2, marginX, Math.max(marginX, vw - DEFAULT_W - marginX)),
      y: clamp(cy - DEFAULT_H / 2, marginTop, Math.max(marginTop, vh - DEFAULT_H - marginBottom)),
      w: DEFAULT_W,
      h: DEFAULT_H,
    };
  }
  const gap = 18;
  const ids = m.agents.map((a) => a.id);
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < ids.length; i++) {
      const a = rects[ids[i]];
      for (let j = i + 1; j < ids.length; j++) {
        const b = rects[ids[j]];
        if (!a || !b || !overlaps(a, b, gap)) continue;
        const right = a.x + a.w + gap;
        const left = a.x - b.w - gap;
        if (right + b.w <= vw - 8) {
          b.x = right;
        } else if (left >= 8) {
          b.x = left;
        } else {
          b.y = clamp(a.y + a.h + gap, marginTop, Math.max(marginTop, vh - b.h - marginBottom));
        }
      }
    }
  }
  return rects;
}

function overlaps(a: Rect, b: Rect, gap: number): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

function readLayout(m: MeshSummary): Layout {
  const sig = signature(m);
  const ids = new Set(m.agents.map((a) => a.id));
  try {
    const raw = localStorage.getItem(layoutKey(m.name));
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed?.sig === sig && parsed?.windows) {
      const windows: Record<string, Rect> = {};
      for (const id of ids) {
        const r = parsed.windows[id];
        if (!r) throw new Error("missing window");
        windows[id] = { x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) };
      }
      return { sig, windows };
    }
  } catch {
    /* stale or invalid localStorage entry */
  }
  const fresh = { sig, windows: autoLayout(m) };
  saveLayout(m.name, fresh);
  return fresh;
}

function saveLayout(mesh: string, layout: Layout): void {
  try {
    localStorage.setItem(layoutKey(mesh), JSON.stringify(layout));
  } catch {
    /* storage unavailable */
  }
}

function edgePoint(from: Rect, to: Rect): { x: number; y: number } {
  const ax = from.x + from.w / 2;
  const ay = from.y + from.h / 2;
  const bx = to.x + to.w / 2;
  const by = to.y + to.h / 2;
  const dx = bx - ax;
  const dy = by - ay;
  const sx = dx === 0 ? Infinity : from.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : from.h / 2 / Math.abs(dy);
  const t = Math.min(sx, sy);
  return { x: ax + dx * t, y: ay + dy * t };
}

export function MeshCanvas({
  m,
  pm,
  store,
  onClose,
}: {
  m: MeshSummary;
  pm: PerMeshState;
  store: Store;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [layout, setLayout] = useState<Layout>(() => readLayout(m));
  const [order, setOrder] = useState<string[]>(() => m.agents.map((a) => a.id));
  const sig = useMemo(() => signature(m), [m]);
  const live = m.status === "running" || m.status === "starting";

  useEffect(() => {
    setLayout(readLayout(m));
    setOrder(m.agents.map((a) => a.id));
  }, [m.name, sig]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function persist(next: Layout): void {
    saveLayout(m.name, next);
  }

  function patchRect(id: string, patch: Partial<Rect>, shouldPersist = false): void {
    setLayout((cur) => {
      const prev = cur.windows[id];
      if (!prev) return cur;
      const next: Layout = {
        ...cur,
        windows: { ...cur.windows, [id]: { ...prev, ...patch } },
      };
      if (shouldPersist) persist(next);
      return next;
    });
  }

  function focus(id: string): void {
    setOrder((cur) => [...cur.filter((x) => x !== id), id]);
  }

  function startDrag(id: string, e: ReactPointerEvent): void {
    e.preventDefault();
    focus(id);
    const start = layout.windows[id];
    if (!start) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      patchRect(id, {
        x: clamp(start.x + ev.clientX - sx, 8, Math.max(8, window.innerWidth - start.w - 8)),
        y: clamp(start.y + ev.clientY - sy, 46, Math.max(46, window.innerHeight - start.h - 8)),
      });
    };
    const onEnd = (ev: PointerEvent) => {
      target.releasePointerCapture(e.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onEnd);
      target.removeEventListener("pointercancel", onEnd);
      const finalX = clamp(start.x + ev.clientX - sx, 8, Math.max(8, window.innerWidth - start.w - 8));
      const finalY = clamp(start.y + ev.clientY - sy, 46, Math.max(46, window.innerHeight - start.h - 8));
      patchRect(id, { x: finalX, y: finalY }, true);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onEnd);
    target.addEventListener("pointercancel", onEnd);
  }

  function startResize(id: string, e: ReactPointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    focus(id);
    const start = layout.windows[id];
    if (!start) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      patchRect(id, {
        w: clamp(start.w + ev.clientX - sx, MIN_W, Math.max(MIN_W, window.innerWidth - start.x - 8)),
        h: clamp(start.h + ev.clientY - sy, MIN_H, Math.max(MIN_H, window.innerHeight - start.y - 8)),
      });
    };
    const onEnd = (ev: PointerEvent) => {
      target.releasePointerCapture(e.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onEnd);
      target.removeEventListener("pointercancel", onEnd);
      const finalW = clamp(start.w + ev.clientX - sx, MIN_W, Math.max(MIN_W, window.innerWidth - start.x - 8));
      const finalH = clamp(start.h + ev.clientY - sy, MIN_H, Math.max(MIN_H, window.innerHeight - start.y - 8));
      patchRect(id, { w: finalW, h: finalH }, true);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onEnd);
    target.addEventListener("pointercancel", onEnd);
  }

  return (
    <div className="mesh-canvas">
      <div className="canvas-top">
        <span className="ttl">{t("canvas.title")}</span>
        <span className="sub">{m.name}</span>
        <span style={{ flex: 1 }} />
        <button className="btn sm ghost canvas-close" onClick={onClose}>
          ✕ {t("esc")}
        </button>
      </div>
      <svg className="canvas-edges">
        <defs>
          <marker id="canvas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" />
          </marker>
        </defs>
        {m.edges.map(([from, to], i) => {
          const a = layout.windows[from];
          const b = layout.windows[to];
          if (!a || !b) return null;
          const s = edgePoint(a, b);
          const e = edgePoint(b, a);
          return <line key={`${from}-${to}-${i}`} className="canvas-edge" data-from={from} data-to={to} x1={s.x} y1={s.y} x2={e.x} y2={e.y} markerEnd="url(#canvas-arrow)" />;
        })}
      </svg>
      <div className="canvas-windows">
        {m.agents.map((agent) => {
          const r = layout.windows[agent.id];
          if (!r) return null;
          const isRouter = agent.id === m.router;
          const z = 20 + order.indexOf(agent.id);
          const status = live ? agent.status : "stopped";
          return (
            <section
              className="canvas-window"
              data-agent={agent.id}
              key={agent.id}
              style={{ left: r.x, top: r.y, width: r.w, height: r.h, zIndex: z }}
              onPointerDown={() => focus(agent.id)}
            >
              <div className="canvas-window-head" onPointerDown={(e) => startDrag(agent.id, e)}>
                {isRouter ? <span className="pin">📌</span> : null}
                <Dot status={status} />
                <span className="agent-id">{agent.id}</span>
                <span className="sub">{agent.harness}</span>
              </div>
              <div className="canvas-window-body">
                <ChatPane
                  items={pm.transcripts[agent.id] ?? []}
                  placeholder={isRouter ? t("router.placeholder") : t("agent.placeholder", { id: agent.id })}
                  imageEnabled={!!pm.capabilities?.[agent.id]?.image}
                  imageDisabledReason="This agent does not advertise image input support"
                  onUploadImages={(files) => store.uploadImages(m.name, files)}
                  onSend={(msg, images) => (isRouter ? void store.promptRouter(m.name, msg, images) : void store.promptAgent(m.name, agent.id, msg, images))}
                />
              </div>
              <div className="canvas-resize-grip" onPointerDown={(e) => startResize(agent.id, e)} />
            </section>
          );
        })}
      </div>
    </div>
  );
}
