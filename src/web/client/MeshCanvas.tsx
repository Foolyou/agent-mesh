import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Store } from "./store";
import type { MeshSummary, PerMeshState } from "../types";
import { Btn, ConfirmButton, Dot } from "./ui";
import { ChatPane } from "./ChatPane";
import { AgentHealthBadges } from "./health";
import { topologyNodePositions } from "./Topology";
import { useI18n } from "./i18n";

type Rect = { x: number; y: number; w: number; h: number };
type Layout = { sig: string; windows: Record<string, Rect> };
type FlashTimer = number;
type Point = { x: number; y: number };
type EdgeRoute = { d: string; route: "clear" | "avoid" | "fallback" };

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

function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

function signature(m: MeshSummary): string {
  const agents = m.agents.map((a) => a.id).sort().join("|");
  const edges = m.edges.map((edge) => edgeKey(edge.from, edge.to)).sort().join("|");
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

function edgePoint(from: Rect, to: Rect): Point {
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

function pathNum(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : "0.0";
}

function pathLine(s: Point, e: Point): string {
  return `M ${pathNum(s.x)} ${pathNum(s.y)} L ${pathNum(e.x)} ${pathNum(e.y)}`;
}

function pathCubic(s: Point, c1: Point, c2: Point, e: Point): string {
  return `M ${pathNum(s.x)} ${pathNum(s.y)} C ${pathNum(c1.x)} ${pathNum(c1.y)} ${pathNum(c2.x)} ${pathNum(c2.y)} ${pathNum(e.x)} ${pathNum(e.y)}`;
}

function expanded(r: Rect, margin: number): Rect {
  return { x: r.x - margin, y: r.y - margin, w: r.w + margin * 2, h: r.h + margin * 2 };
}

function inRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

function orient(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function between(a: number, b: number, c: number): boolean {
  return Math.min(a, b) <= c + 0.001 && c <= Math.max(a, b) + 0.001;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (Math.abs(o1) < 0.001 && between(a.x, b.x, c.x) && between(a.y, b.y, c.y)) return true;
  if (Math.abs(o2) < 0.001 && between(a.x, b.x, d.x) && between(a.y, b.y, d.y)) return true;
  if (Math.abs(o3) < 0.001 && between(c.x, d.x, a.x) && between(c.y, d.y, a.y)) return true;
  if (Math.abs(o4) < 0.001 && between(c.x, d.x, b.x) && between(c.y, d.y, b.y)) return true;
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

function segmentIntersectsRect(a: Point, b: Point, r: Rect): boolean {
  if (inRect(a, r) || inRect(b, r)) return true;
  const tl = { x: r.x, y: r.y };
  const tr = { x: r.x + r.w, y: r.y };
  const br = { x: r.x + r.w, y: r.y + r.h };
  const bl = { x: r.x, y: r.y + r.h };
  return segmentsIntersect(a, b, tl, tr) || segmentsIntersect(a, b, tr, br) || segmentsIntersect(a, b, br, bl) || segmentsIntersect(a, b, bl, tl);
}

function cubicPoint(s: Point, c1: Point, c2: Point, e: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt * mt * mt * s.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * e.x,
    y: mt * mt * mt * s.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * e.y,
  };
}

function cubicHitsRects(s: Point, c1: Point, c2: Point, e: Point, rects: Rect[]): boolean {
  for (let i = 1; i < 32; i++) {
    const p = cubicPoint(s, c1, c2, e, i / 32);
    if (rects.some((r) => inRect(p, r))) return true;
  }
  return false;
}

function controlsFor(s: Point, e: Point, nx: number, ny: number, offset: number): [Point, Point] {
  const dx = e.x - s.x;
  const dy = e.y - s.y;
  return [
    { x: s.x + dx * 0.33 + nx * offset, y: s.y + dy * 0.33 + ny * offset },
    { x: s.x + dx * 0.67 + nx * offset, y: s.y + dy * 0.67 + ny * offset },
  ];
}

function routeEdge(fromId: string, toId: string, windows: Record<string, Rect>): EdgeRoute | null {
  const from = windows[fromId];
  const to = windows[toId];
  if (!from || !to) return null;
  const s = edgePoint(from, to);
  const e = edgePoint(to, from);
  const dx = e.x - s.x;
  const dy = e.y - s.y;
  const len = Math.hypot(dx, dy);
  if (!len) return { d: pathLine(s, e), route: "fallback" };
  const blockers = Object.entries(windows)
    .filter(([id]) => id !== fromId && id !== toId)
    .map(([, r]) => expanded(r, 10));
  const directHits = blockers.filter((r) => segmentIntersectsRect(s, e, r));
  const nx = -dy / len;
  const ny = dx / len;
  if (!directHits.length) {
    const [c1, c2] = controlsFor(s, e, nx, ny, Math.min(18, len * 0.04));
    return { d: pathCubic(s, c1, c2, e), route: "clear" };
  }

  const base = s.x * nx + s.y * ny;
  const margin = 18;
  const candidates = [1, -1].map((sign) => {
    let needed = 48;
    for (const r of directHits) {
      const dots = [
        r.x * nx + r.y * ny,
        (r.x + r.w) * nx + r.y * ny,
        (r.x + r.w) * nx + (r.y + r.h) * ny,
        r.x * nx + (r.y + r.h) * ny,
      ];
      if (sign > 0) needed = Math.max(needed, Math.max(...dots) + margin - base);
      else needed = Math.max(needed, base - (Math.min(...dots) - margin));
    }
    return sign * Math.max(48, needed / 0.5);
  });
  candidates.sort((a, b) => Math.abs(a) - Math.abs(b));
  for (const offset of candidates) {
    const [c1, c2] = controlsFor(s, e, nx, ny, offset);
    if (!cubicHitsRects(s, c1, c2, e, blockers)) return { d: pathCubic(s, c1, c2, e), route: "avoid" };
  }
  return { d: pathLine(s, e), route: "fallback" };
}

export function MeshCanvas({
  m,
  pm,
  store,
  onClose,
  onEdit,
  onDeleted,
}: {
  m: MeshSummary;
  pm: PerMeshState;
  store: Store;
  onClose: () => void;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const [layout, setLayout] = useState<Layout>(() => readLayout(m));
  const [order, setOrder] = useState<string[]>(() => m.agents.map((a) => a.id));
  const [activeEdges, setActiveEdges] = useState<Set<string>>(() => new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const actionsRef = useRef<HTMLSpanElement | null>(null);
  const seenMailIds = useRef<Set<string>>(new Set(pm.mail.map((mail) => mail.id)));
  const flashTimers = useRef<Map<string, FlashTimer>>(new Map());
  const scheduledPatches = useRef<Map<string, Partial<Rect>>>(new Map());
  const patchFrame = useRef<number | null>(null);
  const sig = useMemo(() => signature(m), [m]);
  const edgeKeys = useMemo(() => new Set(m.edges.map((edge) => edgeKey(edge.from, edge.to))), [m.edges]);
  const live = m.status === "running" || m.status === "starting";

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!actionsRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    setLayout(readLayout(m));
    setOrder(m.agents.map((a) => a.id));
    seenMailIds.current = new Set(pm.mail.map((mail) => mail.id));
    for (const timer of flashTimers.current.values()) window.clearTimeout(timer);
    flashTimers.current.clear();
    setActiveEdges(new Set());
  }, [m.name, sig]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (menuOpen) {
        setMenuOpen(false);
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen, onClose]);

  useEffect(() => {
    const nextSeen = new Set(seenMailIds.current);
    for (const mail of pm.mail) {
      if (nextSeen.has(mail.id)) continue;
      nextSeen.add(mail.id);
      const key = edgeKey(mail.from, mail.to);
      if (!edgeKeys.has(key)) continue;
      const prior = flashTimers.current.get(key);
      if (prior) window.clearTimeout(prior);
      setActiveEdges((cur) => (cur.has(key) ? cur : new Set(cur).add(key)));
      const timer = window.setTimeout(() => {
        flashTimers.current.delete(key);
        setActiveEdges((cur) => {
          if (!cur.has(key)) return cur;
          const next = new Set(cur);
          next.delete(key);
          return next;
        });
      }, 500);
      flashTimers.current.set(key, timer);
    }
    seenMailIds.current = nextSeen;
  }, [pm.mail, edgeKeys]);

  useEffect(() => {
    return () => {
      for (const timer of flashTimers.current.values()) window.clearTimeout(timer);
      flashTimers.current.clear();
      if (patchFrame.current !== null) window.cancelAnimationFrame(patchFrame.current);
    };
  }, []);

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

  function scheduleRectPatch(id: string, patch: Partial<Rect>): void {
    scheduledPatches.current.set(id, { ...(scheduledPatches.current.get(id) ?? {}), ...patch });
    if (patchFrame.current !== null) return;
    patchFrame.current = window.requestAnimationFrame(() => {
      patchFrame.current = null;
      const patches = scheduledPatches.current;
      scheduledPatches.current = new Map();
      setLayout((cur) => {
        let changed = false;
        const windows = { ...cur.windows };
        for (const [patchId, rectPatch] of patches) {
          const prev = windows[patchId];
          if (!prev) continue;
          windows[patchId] = { ...prev, ...rectPatch };
          changed = true;
        }
        return changed ? { ...cur, windows } : cur;
      });
    });
  }

  function cancelScheduledPatches(): void {
    scheduledPatches.current.clear();
    if (patchFrame.current !== null) {
      window.cancelAnimationFrame(patchFrame.current);
      patchFrame.current = null;
    }
  }

  function focus(id: string): void {
    setOrder((cur) => [...cur.filter((x) => x !== id), id]);
  }

  function stopDrag(e: ReactPointerEvent): void {
    e.stopPropagation();
  }

  function canWakeAgent(status: string): boolean {
    return live && (status === "cold" || status === "stopped" || status === "dead");
  }

  function canStopAgent(status: string): boolean {
    return live && status === "ready";
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
      scheduleRectPatch(id, {
        x: clamp(start.x + ev.clientX - sx, 8, Math.max(8, window.innerWidth - start.w - 8)),
        y: clamp(start.y + ev.clientY - sy, 46, Math.max(46, window.innerHeight - start.h - 8)),
      });
    };
    const onEnd = (ev: PointerEvent) => {
      cancelScheduledPatches();
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
      scheduleRectPatch(id, {
        w: clamp(start.w + ev.clientX - sx, MIN_W, Math.max(MIN_W, window.innerWidth - start.x - 8)),
        h: clamp(start.h + ev.clientY - sy, MIN_H, Math.max(MIN_H, window.innerHeight - start.y - 8)),
      });
    };
    const onEnd = (ev: PointerEvent) => {
      cancelScheduledPatches();
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
        <span className="canvas-actions detail-overflow" ref={actionsRef}>
          <Btn kind="ghost" title={t("actions")} ariaLabel={t("actions")} onClick={() => setMenuOpen((o) => !o)}>
            ⋯
          </Btn>
          {menuOpen ? (
            <span className="detail-overflow-menu">
              {live ? (
                <>
                  <ConfirmButton kind="ghost" confirmLabel={t("new sessions all.confirm")} title={t("new sessions all.hint")} onConfirm={() => void store.newAllSessions(m.name)}>
                    {t("new sessions all")}
                  </ConfirmButton>
                  <ConfirmButton kind="stop" confirmLabel={t("stop.confirm")} ariaLabel={t("stop mesh")} onConfirm={() => void store.stopMesh(m.name)}>
                    {t("stop mesh")}
                  </ConfirmButton>
                </>
              ) : (
                <>
                  <Btn kind="go" onClick={() => void store.startMesh(m.name)}>
                    {t("start mesh")}
                  </Btn>
                  <Btn kind="ghost" title={t("edit")} onClick={onEdit}>
                    {t("edit")}
                  </Btn>
                  <ConfirmButton
                    kind="stop"
                    confirmLabel={t("del.confirm")}
                    title={t("del")}
                    onConfirm={() => {
                      void store.deleteMesh(m.name).then(onDeleted, () => {});
                    }}
                  >
                    {t("del")}
                  </ConfirmButton>
                </>
              )}
            </span>
          ) : null}
        </span>
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
        {m.edges.map((edge, i) => {
          const { from, to } = edge;
          const routed = routeEdge(from, to, layout.windows);
          if (!routed) return null;
          const key = edgeKey(from, to);
          return <path key={`${from}-${to}-${i}`} className={`canvas-edge ${activeEdges.has(key) ? "active" : ""}`} data-from={from} data-to={to} data-route={routed.route} d={routed.d} markerEnd="url(#canvas-arrow)" />;
        })}
      </svg>
      <div className="canvas-windows">
        {m.agents.map((agent) => {
          const r = layout.windows[agent.id];
          if (!r) return null;
          const isRouter = agent.id === m.router;
          const z = 20 + order.indexOf(agent.id);
          const status = live ? agent.status : "stopped";
          const working = live && agent.activity === "working";
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
                <AgentHealthBadges agent={agent.id} entry={pm.health?.[agent.id]} />
                <span className="sub">{agent.harness}</span>
                <span className="canvas-agent-actions" onPointerDown={stopDrag}>
                  {canStopAgent(status) ? (
                    <Btn small kind="stop" onClick={() => void store.stopAgent(m.name, agent.id)} title={t("agent.stop.hint")} ariaLabel={`${t("agent.stop")} ${agent.id}`}>
                      {t("agent.stop")}
                    </Btn>
                  ) : canWakeAgent(status) ? (
                    <Btn small kind="go" onClick={() => void store.wakeAgent(m.name, agent.id)} title={t("wake.hint")} ariaLabel={`${t("wake")} ${agent.id}`}>
                      {t("wake")}
                    </Btn>
                  ) : (
                    <Btn small kind="ghost" disabled title={t("agent.spawning.hint")} ariaLabel={`${t("agent.spawning")} ${agent.id}`}>
                      {t("agent.spawning")}
                    </Btn>
                  )}
                </span>
              </div>
              <div className="canvas-window-body">
                <ChatPane
                  items={pm.transcripts[agent.id] ?? []}
                  queue={pm.queues?.[agent.id]}
                  author={{ meshId: m.name, agent: agent.id }}
                  placeholder={isRouter ? t("router.placeholder") : t("agent.placeholder", { id: agent.id })}
                  imageEnabled={!!pm.capabilities?.[agent.id]?.image}
                  imageDisabledReason="This agent does not advertise image input support"
                  onUploadImages={(files) => store.uploadImages(m.name, files)}
                  onRemoveQueued={(item) => store.removeQueuedTurn(m.name, agent.id, item.id)}
                  working={working}
                  onInterrupt={live ? () => store.interruptAgent(m.name, agent.id) : undefined}
                  onSend={(msg, images, opts) =>
                    isRouter
                      ? void store.promptRouter(m.name, msg, images)
                      : opts?.steer
                        ? void store.steerAgent(m.name, agent.id, msg, images)
                        : void store.promptAgent(m.name, agent.id, msg, images)
                  }
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
