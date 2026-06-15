# Issue Panel — Design (per-mesh GitHub-Issues-like board)

Status: **design only** (no implementation in this branch). Owner: team1_builder. Task: `issue-panel-design`.

Goal: upgrade today's per-mesh *passive* board (Epic → Task#N → Subtask, advisory-only) into a
semi-independent, feature-rich, GitHub-Issues-like panel with **three views (list / detail / kanban)**,
that doubles as the **router's dispatch desk**: assigning an issue can auto-`send_mail` the assignee, and
status reflows from the task lifecycle. Granularity is **per-mesh** (no cross-mesh).

All current-state claims below cite files in this repo as read on branch `task/issue-panel-design`
(base `main` `ce4a424`).

---

## 1. Current state inventory

### 1.1 Data model & reducer — `src/board.ts`
- Hierarchy `Epic → Task → Subtask` (`Epic`/`Task`/`Subtask`/`BoardState` interfaces, `board.ts:31-83`).
  - `Task` (`board.ts:43-60`): `id:number` (`#N`), `epicId?`, `title`, `description?`, `status`, `assignee?`,
    `priority`, `deps:number[]` (advisory DAG), `subtasks`, `revision`, `createdBy`, timestamps, `comments`,
    `mailEventIds:string[]` (mail↔task back-ref).
  - `BoardStatus = todo | in_progress | in_review | done | cancelled` (`board.ts:14`).
  - `BoardPriority = low | normal | high | urgent` (`board.ts:15`).
- Pure reducer `applyBoardCommand(state, cmd, ctx)` (`board.ts:199-483`) — the **single mutation authority**:
  owns permissions, CAS, id allocation, timestamps; no IO, no clock/random (caller passes `now`).
- Actor model `BoardActor` (`board.ts:89-93`): `human` / `system` / `router` are **privileged**
  (`isPrivileged`, `board.ts:156-158`); `agent` is restricted. `ownsItem` (`board.ts:190-195`):
  an agent "owns" an item if it is the `assignee`, or (unassigned) the `createdBy`.
- Commands `BoardCommand` (`board.ts:109-123`). Notable gates **today**:
  - `create_task` is allowed by **any** agent; only epic-membership / assignee / deps / `priority>normal`
    are router-only (`board.ts:271-275`). **Members can currently create tasks.**
  - `add_comment` (`board.ts:431-461`) has **no ownership/role gate** — **any** actor can comment on anything.
  - `assign_task`, `set_task_priority`, `set_task_deps`, epic CRUD: privileged-only.
  - `set_task_status` via `canAgentSetStatus` (`board.ts:181-188`): an agent may move an item it owns up to
    `in_review`; `done`/`cancelled` are privileged-only (close gate already exists).
  - `link_mail` is `system`-only (`board.ts:463-475`).
- CAS is two-level: **board-level** `expectedBoardRevision` gates every mutation (`board.ts:205-208`) and
  **entity-level** `expectedRevision` per item (`casCheck`, `board.ts:487-493`).
- Derived views are pure: `taskProgress`/`epicProgress` (`board.ts:525-541`), `computeBoardWarnings`
  (`board.ts:551-600`) — dependency cycles / dangling / blocked-by-incomplete, **advisory only, never
  auto-transitioned or hard-gated** (`board.ts:10-12`).

### 1.2 MCP tools & permission points — `src/mcp/mesh-services.ts`
- `registerBoardTools(server, role, ctx, services)` (`mesh-services.ts:72-257`). Member-visible tools are
  registered first; **router-only tools after an `if (role !== "router") return;` guard (`mesh-services.ts:172`)**.
  - Member-visible: `board_list`, `board_create_task`, `board_create_subtask`, `board_set_status`, `board_comment`.
  - Router-only: `board_create_epic`, `board_update_epic`, `board_delete_epic`, `board_assign`,
    `board_set_priority`, `board_set_deps`.
- The MCP context `MeshToolContext = { agentId, role }` (`mesh-services.ts:11-13`, built at `:346`).
  `role: AgentRole` is the mesh role (`router` vs `member`). Tool visibility is a **first gate**; the reducer
  re-derives the actor and re-checks (defense in depth, `mesh-services.ts:69`).

### 1.3 Control-plane board surface — `src/control-plane.ts`
- In-memory `private board: BoardState` (`:218`), seeded `createEmptyBoard` (`:305`), hydrated from disk on
  `start()` (`:1036`).
- `boardActor(ctx)` (`:1898-1900`): `ctx.role === "router" → {kind:"router"}` else `{kind:"agent"}`.
  **The `human` actor is REST-only** (web operator path), never produced from an MCP role.
- `runBoardCommand(command, actor, expectedBoardRevision)` (`:1912-1934`) — the single funnel for MCP, REST,
  and the internal mail-link path: calls `applyBoardCommand`, updates in-memory board, **best-effort persists**
  via `writeBoard` (failure only logs; memory stays authoritative), then emits
  `{ kind:"board_snapshot", board }` (`:1931`).
- `applyBoard(actor, command, rev)` (`:1905`) is the explicit-actor entry (REST/daemon); `handleApplyBoard(ctx,…)`
  (`:1936`) is the MCP entry using `boardActor(ctx)`.
- `getBoard()` (`:1892-1894`) returns the live board.

### 1.4 send_mail dispatch flow — `src/control-plane.ts`
- `handleSendMail(ctx, to, body, opts)` (`:1631-1683`). `SendMailOptions = { replyTo?, task? }`
  (`mesh-services.ts:16-19`). The `task` string is parsed by `parseBoardTaskRef(opts.task, board)` (`:2073`)
  into a numeric `boardTaskId` **only when it matches `#N`/`N`**; otherwise it is just an informational slug.
- When a `boardTaskId` resolves, after the mail is persisted the plane applies `link_mail` as the **system**
  actor (`:1656-1664`), recording the mail event id in `Task.mailEventIds` (the task→mail half; the mail→task
  half is `MailMeta.boardTaskId`, `mailbox.ts:96-108`).
- Delivery is fire-and-forget from the sender: `wake()` / `wakeLazy()` / `steerWake()` (`:1668-1672`).
- **There is no assignment→mail coupling today.** `board_assign` only sets `Task.assignee`; nothing mails the
  assignee or moves status. The mail `task` field is a *manual* link, not a dispatch mechanism.

### 1.5 Persistence — `src/board-store.ts`
- `boards/<mesh>.json` under the mesh run root (`boardsDirFor`/`boardPath`, `:24-37`; name validated by
  `assertSafeBoardName`, `:31`). Atomic write = tmp-file + `rename`, mode 0600, serialized by an in-process
  per-path lock `withBoardLock` (`writeBoard`, `:82-93`). `readBoard` (`:64-79`) returns an empty board on
  ENOENT / parse error; `sanitizeBoard` (`:102-277`) defensively rebuilds from arbitrary JSON (drops malformed
  entries, normalizes seq/revision). This is the **CAS-on-disk mirror**; the in-memory board is authoritative.

### 1.6 UI wiring — `src/web/client/`
- `BoardPanel.tsx` (`:12-99`): renders the Epic→Task→Subtask hierarchy with progress bars; **editable when
  `running`, read-only pills when stopped** (`:174-197`). Reads `board: BoardDocument | null` from props.
- Mounted as one segmented tab in `MeshDetail.tsx`: `tab` union includes `"board"` (`MeshDetail.tsx:614`),
  tab button at `:625-627` (shows a task count badge), panel render gated on `tab === "board"`.
- Store (`store.ts`): `getBoard(name)` (`:203`, REST GET), `boardCommand(name, command, expectedBoardRevision)`
  (`:206`, REST POST), `ensureBoardLoaded(name)` (`:502-519`, coalesced one-shot fetch), WS `board` message
  folds into `pm.board` (`:137-139`).
- Gateway (`gateway.ts`): `getBoard` (`:764`, live `pm.board` running else `manager.readBoard`),
  `applyBoard` (`:772`); `board_snapshot` event → broadcast `{ t:"board", name, board }` (`:473-477`).
- API (`api.ts`): `GET /api/meshes/:name/board` (`:169-171`); `POST /api/meshes/:name/board` (`:173-189`) maps
  `BoardCommandResult` codes to HTTP (409 conflict, 403 forbidden, 404 not_found, 400 invalid, 409 stopped).

### 1.7 Execution-flow hooks we must engage
- **Dispatch:** `send_mail` (`handleSendMail`) is the only outbound work-handoff channel; `task` slug + `link_mail`
  is the only existing mail↔task tie.
- **`task/<slug>` git branch lifecycle:** **no machine-readable signal exists.** Nothing in the codebase ties a
  board task #N to a git branch or to integration/merge events; the control plane does not observe git. The
  `task/<slug>` convention lives only in mesh-dev's *human/agent* workflow (CLAUDE.md / mail), not in code.
- **Status reflux candidates that DO exist as events:** `agent_activity`, `mail`, and explicit `board_set_status`.
  These are the only hooks available; any reflux must be built from them (or stay manual).

### 1.8 Tests today
- `src/board.test.ts` (reducer: CRUD, permission gates, CAS, deps/cycles, comments).
- `src/board-store.test.ts` (atomic write, round-trip, corruption recovery, lock serialization).
- `src/control-plane-board.test.ts` (role→actor, snapshot emission, MCP routing, mail→board link).
- `src/web/client/BoardPanel.test.tsx` (running vs stopped rendering, warnings, empty state).
- `src/web/board.e2e.ts` (full-stack browser flow).

### 1.9 Current limitations (the gap to close)
1. **One flat hierarchical view**, editable/read-only only — no list, no detail, no kanban, no filtering.
2. **No labels**, no saved filters, no search.
3. **Assignment ≠ dispatch:** `board_assign` sets a field; the router still has to hand-write a `send_mail`.
4. **No status reflux:** finishing/integrating work never moves the task; the router must remember to close it.
5. **Permission matrix mismatch** vs the locked product matrix (§4): members can currently *create tasks*
   (`board.ts:271-275`) and *comment on anything* (`board.ts:431`), which the new matrix forbids.
6. **No close acceptance gate** beyond "privileged only" — no subtask/deps completeness surfacing at close.

---

## 2. Data-model increment

Built on the existing model; additive and migration-safe (sanitizer defaults missing fields).

1. **Labels.** `BoardLabel = { id:string; name:string; color:string }` stored at board level
   (`BoardState.labels: BoardLabel[]`); `Task.labelIds: string[]`. New commands `create_label` / `update_label`
   / `delete_label` (privileged) and `set_task_labels` (privileged + assignee). Sanitizer drops unknown label
   refs. *Why board-level:* labels are shared vocabulary; per-task free-text would not support filtering.
2. **Filter/sort surface (no schema change needed, just indexes the UI reads):** status, assignee, label,
   priority, epic, has-open-subtasks, blocked (from `computeBoardWarnings`), text (title/description/comment).
   Derived client-side from the full board document (Phase-1 still ships the whole board).
3. **Assignment ↔ dispatch link.** New optional `Task.dispatch?: { assignee:string; mailEventId:string; at:string }`
   recording the dispatch that handed the task to its assignee. Distinct from `mailEventIds` (all linked mail);
   `dispatch` is *the* hand-off. Lets the detail view show "dispatched to X at T (mail #M)".
4. **Status auto-flow hooks (opt-in, advisory).** No hard auto-transition (preserves `board.ts:10-12`). Instead a
   derived, non-persisted **suggestion**: when an assignee replies on the dispatch thread (`link_mail` on a task
   whose `assignee` sent it), surface a "ready to mark in_review?" hint in the detail/kanban; never auto-move.
5. **Close acceptance gate (soft).** At `done`, `computeCloseReadiness(task)` (pure, derived) reports unmet
   conditions (open subtasks, non-done deps). Privileged-only close is unchanged; the gate is a **confirmation
   surfaced in the panel**, not a reducer hard-block — consistent with the advisory-only principle.
6. **Member-scoped permission flag.** No new field needed: "assigned member" = `ownsItem` with `assignee===id`.
   The matrix tightening (members can't create; comment only when owning) is enforced in the reducer (§4),
   not via a new flag.

Explicitly **not** adding: cross-mesh refs, milestones/iterations, story points, external GitHub sync.

---

## 3. Three-view UI design

A **semi-independent panel** — promoted from one cramped tab to a board workspace with its own sub-navigation,
while still living inside the mesh detail (per-mesh granularity).

- **Entry & layout.** Keep the existing `board` segmented tab as the entry (`MeshDetail.tsx:625`). Selecting it
  opens the **Issue Panel** with an internal view switch `List · Board(kanban) · (detail opens on row/card click)`
  and a filter bar. Optional "expand" affordance to a full-width/full-screen layout (mirrors the existing
  `text-editor`/canvas full-screen pattern) for a focused workspace; default stays embedded so it doesn't
  regress the mesh console.
- **Routing.** Add a lightweight in-panel route state `{ view: "list" | "kanban"; selected?: TaskRef }`, persisted
  in the URL query (mirrors `parseFileRoute` style in `FileViewer`) so a deep link to `#N` reopens the detail.
  No new top-level app route — stays under the mesh.
- **List view.** GitHub-issues-style rows: `#N`, title, status chip, assignee avatar/id, labels, priority,
  subtask progress (`taskProgress`), blocked badge (from warnings), updated-at. Filter bar (status/assignee/
  label/epic/text) + sort. Grouping toggle by epic. Click → detail.
- **Detail view.** Title/description (markdown), status/assignee/priority/labels/deps controls (gated per §4),
  subtask checklist, **comment thread**, and a **linked-mail timeline** (resolve `mailEventIds`/`dispatch` against
  recent mail) so the dispatch conversation is visible inline. Close button shows the soft acceptance gate (§2.5).
- **Kanban view.** Columns = the five statuses. Cards are tasks; drag a card to a column = `set_task_status`
  (subject to per-actor permission: a member can only drag own cards up to `in_review`; `done`/`cancelled`
  columns reject member drops with an inline reason). Optional swimlanes by epic or assignee.
- **Live + concurrency.** All three views render from `pm.board` and refresh on the WS `board` snapshot
  (`store.ts:137`). Mutations go through `store.boardCommand` carrying `expectedBoardRevision`; a 409 conflict
  re-fetches and re-renders (the board doc is small). Read-only when the mesh is stopped (existing behavior).
- **Accessibility:** keep role/aria patterns already used; kanban drag must have a keyboard alternative
  (status select on the card), per the project's a11y posture.

---

## 4. Permission + assignment matrix → code layer

The locked matrix, mapped to **actor model (`board.ts`) + tool guard (`mesh-services.ts`) + UI gating**. The
reducer is the authority; tool visibility and UI are first/second gates.

| Action | human | router | assigned member | unassigned member | Where enforced / change needed |
|---|---|---|---|---|---|
| Create issue (task) | ✓ | ✓ | ✗ | ✗ | **CHANGE** `create_task` to privileged-only (`board.ts:265-275`); drop `board_create_task` from member tool set (`mesh-services.ts`). |
| Assign assignee | ✗ (panel) | ✓ | ✗ | ✗ | `assign_task` already privileged (`board.ts:342-351`). Human **technically** allowed by reducer but **panel must not expose** assign UI; humans ask the router (product decision). Optionally add a `dispatch` tool router-only (§5). |
| Status → in_progress / in_review | ✓ | ✓ | ✓ (own) | ✗ | Already correct via `canAgentSetStatus` + `ownsItem` (`board.ts:181-195, 330-340`). After members can't create, "own" = assignee only. |
| Close → done / cancelled | ✓ | ✓ | ✗ | ✗ | Already correct (terminal statuses privileged-only, `board.ts:184-187`). Add soft close gate (§2.5) in UI. |
| Comment / update content | ✓ | ✓ | ✓ (own) | ✗ | **CHANGE** `add_comment` to require privileged **or** `ownsItem(target)` (`board.ts:431`); today it's ungated. `update_task` already needs owner/privileged (`board.ts:306`). |
| Read | ✓ | ✓ | ✓ | ✓ | `board_list` / GET board — unchanged. |

Notes:
- **"human cannot assign from the panel"** is a *UI* constraint, not a reducer change (the reducer keeps `human`
  privileged so REST/automation still works). Document this divergence explicitly so a future reviewer doesn't
  "fix" the panel to expose assign.
- Member tool surface after the change: `board_list`, `board_set_status` (own, ≤in_review), `board_comment`
  (own), `board_create_subtask` (under a task they own?) — **open question** whether members may still create
  subtasks on their assigned task; the matrix only speaks of tasks. Recommend: allow subtask create/update/status
  only on a task the member is assigned to (owns), else read-only. Enforce in reducer + tool guard.
- Every tightening needs reducer tests asserting the new `forbidden` results (members create/comment) so the
  matrix is pinned.

---

## 5. Auto-dispatch mechanism (the keystone)

**Requirement:** assigning (router) an issue should hand it to the assignee — `send_mail` with the brief, link the
mail to the task, and let status reflow as work proceeds — without the router hand-writing a mail each time.

### Alternative A — synchronous router action: assign + dispatch in one funnel (RECOMMENDED)
A new **router-only** MCP tool / board path `board_dispatch(taskId, instructions?, expectedRevision, expectedBoardRevision)`
(and an internal `dispatchTask`) that, in one control-plane call:
1. `assign_task(taskId, assignee=instructions.assignee)` (reuses the reducer; CAS-checked).
2. `handleSendMail(router → assignee, body = dispatch brief incl. `#N` + title + instructions, task:"#N")` —
   reusing the **existing** `send_mail` path so `link_mail` records the mail (and sets `Task.dispatch`).
3. Optionally `set_task_status(in_progress)` (or leave `todo` until the member starts — product choice; default:
   leave status, let the assignee move it).
- **Ordering / failure:** apply the board mutations first (authoritative + persisted), then send the mail
  best-effort (mail send is already fire-and-forget). If mail fails, the assignment still stands and the panel
  shows "dispatch mail failed — retry"; never roll back the assignment on a transport hiccup.
- **Pros:** one atomic-feeling action; reuses existing reducer + send_mail + link_mail; no new durable state
  machine; the router is *already* the synchronous dispatcher, and the board is in-process with the control
  plane so a direct call is trivial. Easiest to test (one funnel).
- **Cons:** board mutation and mail are coupled in one tool; partial success (assigned but mail failed) must be
  surfaced, not hidden.

### Alternative B — assignment event / outbox drives mail asynchronously
`assign_task` emits an internal "assignment" event (or appends to a durable **outbox**); a listener consumes it
and performs `send_mail` + `link_mail`, with at-least-once delivery + dedup.
- **Pros:** decouples board writes from mail; survives restart (replay the outbox); a single `board_assign`
  uniformly triggers dispatch regardless of caller.
- **Cons:** real complexity for a single-daemon, in-process board — needs an outbox table, idempotency keys,
  retry/backoff, and dedup so a replayed event doesn't double-mail. Harder to reason about ordering vs the WS
  snapshot. Over-engineered for current scale; also it would auto-dispatch on *every* assign, including
  re-assignment/bookkeeping edits, which may be unwanted.

### Recommendation
**Adopt A.** It matches the "router is the dispatch desk" model, reuses three existing primitives
(`assign_task`, `handleSendMail`, `link_mail`), keeps dispatch an explicit deliberate action (not a side effect of
any assign), and is straightforward to test. Keep `board_assign` as the pure "set the field" op for bookkeeping;
`board_dispatch` is the "assign **and** hand off" op. Revisit B only if we later need cross-process or replayable
dispatch.

### Status reflux (how status flows back from the lifecycle)
Keep the project's **advisory-only** principle (`board.ts:10-12`): **no auto-transition.** The reflux is:
- The assignee works the dispatched task and **explicitly** `board_set_status(in_review)` when handing back
  (already permitted). The panel surfaces a one-click "mark in_review" on the assignee's own card.
- When the assignee replies on the dispatch mail thread (`link_mail` ties it), the detail/kanban shows a
  **suggestion** ("assignee replied — ready for review?") — never moves status itself.
- **Close gate:** `done`/`cancelled` stay router/human-only; the panel's close action shows `computeCloseReadiness`
  (open subtasks / non-done deps) as a confirmation, not a block.
- **`task/<slug>` git events:** out of scope to wire (no machine signal exists, §1.7). The mail `task:"#N"` link is
  the carrier; if branch/integration events ever become observable, they slot in here as additional *suggestion*
  inputs, not auto-transitions. Recorded as an open question (§7), not built now.

---

## 6. Phased plan (each phase independently shippable + testable)

- **Phase 0 — Permission alignment + close gate (model-only).** Tighten `create_task` and `add_comment` to the
  locked matrix; scope member subtask ops to owned tasks; add `computeCloseReadiness` (pure). Files: `board.ts`,
  `mesh-services.ts` (member tool set), tests. No UI. *Lowest risk, unblocks everything; ships first.*
- **Phase 1 — List + detail (read-first) in a semi-independent panel.** New panel layout, view switch, filter bar,
  list view, detail view (read + existing gated edits). Files: `BoardPanel.tsx` split into panel + views, store
  selectors, no new server surface (reuses GET/POST board). Component + e2e tests.
- **Phase 2 — Kanban view.** Columns by status, drag-to-status honoring per-actor permission, keyboard fallback.
  UI-only + e2e.
- **Phase 3 — Labels + filter/search.** Label CRUD (privileged), `set_task_labels`, filter/sort by label/status/
  assignee/text. `board.ts` (labels), `mesh-services.ts` (tools), `board-store.ts` sanitizer, UI, tests.
- **Phase 4 — Auto-dispatch (Alternative A).** `board_dispatch` tool + `dispatchTask` funnel + `Task.dispatch`
  field; detail-view linked-mail timeline. `control-plane.ts`, `board.ts`, `mesh-services.ts`, UI, tests.
- **Phase 5 — Status reflux suggestions + close acceptance UX.** Assignee "mark in_review" affordance, reply→review
  suggestion, close confirmation surfacing `computeCloseReadiness`. UI + control-plane suggestion derivation, tests.

Critical risk (auto-dispatch) lands in Phase 4 with read/permission/views already proven — not deferred to the end
as one big-bang.

---

## 7. Risks / open questions / rejected alternatives

**Risks**
- **Whole-board CAS contention.** Every mutation carries `expectedBoardRevision` (`board.ts:205-208`); a busy board
  with router + members + kanban drags will see 409s. Phase-1 mitigations: snappy re-fetch on conflict (small doc),
  optimistic UI with rollback. Open question: move to entity-only CAS for non-structural edits.
- **Dispatch partial success** (assigned, mail failed) must be visible, not silently "done" — mirror the
  `mutation-ack` saved-vs-applied lesson.
- **Permission tightening is a behavior change**: members losing create/comment-anywhere could break existing
  member habits; needs a clear error message and a changelog note.
- **Label migration**: old `boards/<mesh>.json` lacks `labels`/`labelIds`; the sanitizer must default them
  (additive, low risk) — but assert it in `board-store.test.ts`.
- **Full-screen panel vs mesh console**: don't regress the embedded board tab or the composer/canvas layout.

**Open questions**
- May members create/update subtasks on their assigned task, or are subtasks also router-only? (Recommend:
  owned-task only.)
- Does dispatch auto-set `in_progress`, or leave `todo` until the member starts? (Recommend: leave; member moves it.)
- Should `board_assign` (pure set) remain, or fold into `board_dispatch`? (Recommend: keep both.)
- Whole-board vs entity-only CAS for the kanban path.
- Human-assign-from-panel stays disabled — confirm we don't want an operator override later.

**Considered & rejected**
- **Auto status transitions** on mail/branch/integration events — violates the explicit "advisory-only, no
  auto-flow" product rule (`board.ts:10-12`); kept as *suggestions* only.
- **Outbox-driven dispatch (Alternative B)** — over-engineered for a single in-process daemon; adds durability/
  dedup complexity with no current payoff.
- **Git `task/<slug>` branch coupling** — no machine-readable signal exists (§1.7); wiring an external git observer
  is out of scope and cross-cuts the daemon's process model.
- **Cross-mesh issues** — explicitly out of scope (per-mesh only).

---

## 8. Per-phase acceptance

- **Phase 0:** reducer unit tests assert members get `forbidden` on `create_task` and on `add_comment` for
  non-owned items; assignee can comment/status own; `computeCloseReadiness` pure tests. `bunx tsc --noEmit`,
  `bun test src/board.test.ts src/control-plane-board.test.ts`.
- **Phase 1:** `BoardPanel.test.tsx` covers list + detail render, filter bar, gated edits running vs stopped;
  `board.e2e.ts` extends to open a detail by `#N` and round-trip an edit. tsc + targeted tests + the board e2e.
- **Phase 2:** component test for kanban columns + permission-gated drag (member can't drop to done); keyboard
  fallback asserted; e2e drag a card and verify status persisted via WS snapshot.
- **Phase 3:** reducer tests for label CRUD + `set_task_labels` permissions; `board-store.test.ts` asserts label
  round-trip + default-on-missing migration; UI filter test.
- **Phase 4:** `control-plane-board.test.ts` asserts `board_dispatch` assigns + sends one mail + `link_mail` records
  it + `Task.dispatch` set + partial-failure (mail fails → assignment stands, surfaced); e2e router dispatches and
  the assignee receives mail; member cannot call `board_dispatch` (router-only).
- **Phase 5:** tests for the in_review affordance (assignee only), reply→review suggestion derivation, and close
  confirmation surfacing unmet readiness; no auto-transition asserted (status unchanged until explicit action).

E2E/browser gates are opt-in/slow; each phase states which it runs.
