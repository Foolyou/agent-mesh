# Canvas / Whiteboard Mode (Stage D)

Date: 2026-06-08
Status: design — pending implementation (after Stage C lands)

## Goal

A whiteboard view of a mesh: each agent becomes a freely **movable + resizable** window
holding its full conversation, laid out on a canvas. Mail edges (who-can-mail-whom) are
drawn as directed **Bézier curves** that try to route around windows; when a mail is sent
the corresponding curve pulses. The canvas is the topology graph "zoomed in".

## Decisions (from brainstorming, 2026-06-08)

- **Q1 window content = C**: each window is a full conversation (ChatPane: transcript +
  composer), and is **resizable** (drag-corner) in addition to movable.
- **Q2 scope = A**: one window per agent in **this mesh** (router + all members), fixed by
  roster regardless of activity. Master (Mesh Assistant) is NOT on the canvas (cross-mesh).
- **Q3 entry = C**: the canvas is launched by **expanding the topology panel** (the `⤢`
  button that today opens `TopologyModal`). It is a full-screen takeover; closing returns
  to the normal mesh detail. Conceptually the canvas == the topology, zoomed into live
  conversation windows.
- **Q4 bidirectional edges = A**: a bidirectional mail edge is drawn as **two separate
  one-way curves** (each direction independent so each can flash on its own).
- **Q5 routing = Bézier obstacle-avoidance**: curves try to bend around other window
  rectangles (best-effort); when boxed in and unavoidable, the curve renders **under** the
  windows ("压底"). Best-effort heuristic, not guaranteed-optimal pathfinding (see Routing).
- **Q6 flash = B**: while an edge is active the curve shows a **pulsing / flowing glow**.
  Timing (from original spec): a mail on that edge lights it; further mail re-arms; it goes
  dark **500ms after the last** mail (trailing debounce).
- **Q7 drag routing = A**: obstacle avoidance is recomputed **live during drag**
  (rAF-throttled). Focusing (click) or dragging a window brings it to front; other windows
  stack by most-recent-activation order; the edge layer sits beneath all windows.
- **Q8 persistence = A + relayout-on-topology-change**: window positions/sizes persist in
  **localStorage per mesh**. A stored layout carries a **topology signature** (hash of
  sorted agent ids + edges); on open, if the signature matches → restore; if it differs
  (agents or edges changed) → **discard the saved layout and auto-layout fresh**, then save
  the new signature. Initial layout (no/!matching saved state) = auto-layout from topology.

## Architecture

New component `MeshCanvas` (full-screen overlay), opened from the topology panel's `⤢`
(replacing/expanding today's `TopologyModal` path; the small in-rail `Topology` stays).

Layers, bottom to top:
1. **Canvas background** — dark grid, the positioning context.
2. **Edge layer** (single SVG, `pointer-events:none`) — all directed mail-edge curves.
   Sits *below* the window layer, so any curve segment overlapping a window is naturally
   hidden ("压底"); avoidance (Q5) tries to keep curves in the gaps so they stay visible.
3. **Window layer** — one `CanvasWindow` per agent, absolutely positioned; z-order managed
   (focused/dragged on top, others by activation order).

### CanvasWindow

- Header: `📌`(router only) + status `Dot` + agent id + harness; this is the drag handle.
- Body: the agent's `ChatPane` (reuse as-is; full transcript + composer), wired like the
  Stage C control row (`promptRouter` for the router, `promptAgent` otherwise; image cap
  from `pm.capabilities[id]`).
- Resizable via a bottom-right corner grip (min size enforced).
- Drag moves it; drag/click raises it to front.

### Edges

- Source data: `m.edges` (mesh config mail edges). Each directed edge → one curve with an
  arrowhead at the recipient. A bidirectional pair renders as two curves (Q4).
- Endpoints attach to the window borders (the curve meets each window's edge on the side
  facing the other window), recomputed when either window moves/resizes.

### Routing (Bézier obstacle-avoidance, best-effort)

For each edge, per recompute:
1. Compute straight source-edge → target-edge segment.
2. Test intersection against the *other* windows' rectangles (not the two endpoints' own).
3. If clear → a gentle cubic Bézier roughly along the straight line.
4. If blocked → offset the control point(s) perpendicular to the line, toward the side that
   clears the obstacle bounding box(es) (magnitude = enough to clear + margin). Re-test.
5. If still blocked after a bounded number of attempts (boxed in by multiple windows) →
   give up avoidance and draw the curve straight (it will be hidden under windows = "压底").

This is a heuristic, not a full routing engine. Recomputed live during drag, rAF-throttled
(Q7). Keep the per-edge cost low (rect intersection + a couple of control-point trials).

### Flash

- The client store already folds mail into `pm.mail` (entries `{id, ts, from, to, body}`)
  and broadcasts mail events. `MeshCanvas` watches for **new** mail entries (by id); each
  new entry maps to the directed edge `from → to` and (re)arms that edge's 500ms trailing
  timer. While an edge's timer is pending it renders the pulsing/flowing glow (Q6); on
  expiry it returns to idle. Per-edge timers (a rapid burst keeps it lit; quiet 500ms ends).

### Layout & persistence

- localStorage key e.g. `mesh-canvas-layout:<meshName>` storing
  `{ sig, windows: { [agentId]: {x,y,w,h} } }`.
- `sig` = stable hash of sorted agent ids + sorted edges.
- On open: read entry; if `sig` matches current mesh → restore window rects; else (or no
  entry) → run **auto-layout** (reuse the topology graph's node layout from `Topology.tsx`
  as seed positions; default window size) and persist with the new `sig`.
- Save (debounced) on drag-end / resize-end.

## Implementation staging (within Stage D)

D is the largest stage; build incrementally so each step is demoable and testable:
1. **D-core**: `MeshCanvas` opened from topology `⤢`; one `CanvasWindow` per agent with
   ChatPane; drag + resize + z-order; auto-layout + localStorage persistence + relayout on
   topology-change. Edges as **straight** under-window curves (no avoidance yet).
2. **D-flash**: per-edge flash (Q6 pulsing + 500ms trailing debounce) wired to mail events.
3. **D-avoid**: Bézier obstacle-avoidance (Q5) + live recompute during drag (Q7).

Each sub-step: own commit(s), tests green, browser-verified, then I (lead) review → review
verifies → merge. (Whether to ship D-core/-flash before -avoid is merged is a later call.)

## Testing

Extend `src/web/browser.e2e.ts` (the `--fake` mesh has router + 2 members and emits mail
codex-1 → opencode-1):
- topology `⤢` opens the canvas; one window per agent (router + members), none for master.
- a window is draggable and resizable; dragging/clicking raises it above others (z-order).
- edges render between mail-connected agents with arrowheads; bidirectional shows two.
- a mail event makes the matching edge enter its active/glow state, then clears after the
  trailing timeout.
- positions persist across re-open (localStorage); changing the roster/edges (simulate a
  different sig) triggers a fresh auto-layout rather than restoring stale positions.
- (D-avoid) with a window placed on a straight edge's path, the curve bends to avoid it;
  when boxed in, it falls back under the windows.

Keep `bun test` green throughout.

## Scope / non-goals

- No master window; no cross-mesh canvas.
- No minimap, no zoom/pan of the canvas itself (windows move, canvas is fixed) — revisit if needed.
- No server-side layout sync (localStorage only).
- Avoidance is best-effort heuristic, not optimal routing.

## Risks / notes

- Reuse `ChatPane`, `Dot`, the Stage C prompt wiring, and the topology layout seed; do not
  fork conversation rendering.
- Live avoidance during drag (Q7=A) is the perf-sensitive part; rAF-throttle and keep the
  per-edge math cheap. If it can't hold frame rate with many windows, revisit (fallback to
  Q7-B drop-time routing) — flag to user rather than silently degrading.
- Edge endpoints + routing must recompute on window move AND resize.
