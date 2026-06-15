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

**Scope clarification on "advisory-only".** The existing `board.ts:10-12` rule ("nothing is ever
auto-transitioned") is specifically about **dependency** warnings (cycles / blocked-by-incomplete) — those stay
advisory. This upgrade introduces an **intentional, separate** lifecycle mechanism that DOES auto-transition a
task's status (`todo → in_progress → in_review`) from machine-readable lifecycle events (§5). Dependency warnings
remain advisory; lifecycle status reflux is automatic. The two do not conflict.

1. **Issue ↔ slug / branch / dispatch linkage (stable fields).** Add to `Task`:
   - `taskSlug?: string` — the canonical mesh task slug (e.g. `builder-tab-names`); the git branch is
     `task/<slug>` by convention.
   - `branchName?: string` — the branch name (defaults to `task/${taskSlug}`), recorded/confirmed by a
     `branch_created` lifecycle event.
   - `dispatch?: { assignee:string; mailEventId?:string; threadKey:string; at:string; mailFailed?:boolean }` —
     *the* hand-off record (distinct from `mailEventIds`, which is all linked mail). `threadKey` (the slug, or the
     first dispatch mail id) keys the dispatch conversation so replies map back. `mailEventId` is back-filled on a
     retry if the initial `send_mail` failed (`mailFailed`).
   - `lifecycleEvents: BoardLifecycleEvent[]` — append-only audit driving auto status reflux (see below).
2. **Lifecycle event type (drives auto-reflux, §5).**
   `BoardLifecycleEvent = { kind: LifecycleKind; by: string; at: string; data?: {...} }` where
   `LifecycleKind = "dispatched" | "branch_created" | "accepted" | "review_requested" | "integration_ready" | "reopened"`.
   A new reducer command `record_lifecycle_event` appends the event AND applies the mapped, **monotonic** status
   transition (§5). Status rank `todo(0) < in_progress(1) < in_review(2) < done/cancelled(terminal)`; auto-reflux
   only moves **forward** to the mapped rank and never sets a terminal status (close stays privileged-explicit).
3. **Labels.** `BoardLabel = { id; name; color }` at board level (`BoardState.labels`), `Task.labelIds:string[]`;
   commands `create_label`/`update_label`/`delete_label` (privileged) + `set_task_labels` (privileged + assignee).
   Sanitizer drops unknown label refs. *(Postponed to a later phase — see §6.)*
4. **Filter/sort surface (no schema change; client-derived from the full board doc):** status, assignee, label,
   priority, epic, has-open-subtasks, blocked (from `computeBoardWarnings`), text (title/description/comment).
5. **Close acceptance gate (soft, does NOT replace auto-reflux).** `computeCloseReadiness(task)` (pure, derived)
   reports unmet conditions (open subtasks, non-done deps, no `integration_ready` event yet). It is a
   **confirmation surfaced at close**, not a reducer hard-block. The `integration_ready` lifecycle event marks a
   task **close-ready**; it never auto-moves to `done`. `done`/`cancelled` remain privileged-explicit (router/human).
6. **Member-scoped permission** stays `ownsItem` (assignee, `board.ts:190-195`) — no new field; matrix tightening
   enforced in the reducer (§4).

Migration: all new fields are optional / default-empty; `sanitizeBoard` (`board-store.ts:102-277`) defaults
`taskSlug`/`branchName` to undefined and `lifecycleEvents`/`labelIds` to `[]`, so old `boards/<mesh>.json` loads
cleanly.

Explicitly **not** adding: cross-mesh refs, milestones/iterations, story points, external GitHub API sync.

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
  subtask checklist, **comment thread**, a **lifecycle timeline** (`lifecycleEvents` — dispatched → in_progress →
  review_requested → in_review → integration_ready) showing how/when the status reflowed and by whom, and a
  **linked-mail timeline** (resolve `mailEventIds`/`dispatch` against recent mail) so the dispatch conversation is
  visible inline. Shows `taskSlug`/`branchName`. Close button shows the soft acceptance gate (§5.6).
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

## 5. Auto-dispatch + automatic status reflux (the keystone)

**Requirement (locked):** assigning (router) an issue hands it to the assignee — `send_mail` with the brief, link
the mail+slug+branch to the task — AND the task status **automatically reflows** `todo → in_progress → in_review`
as the lifecycle progresses (branch created / accepted → in_progress; handoff / review-request → in_review;
integration/acceptance → close-ready). Close to `done`/`cancelled` stays router/human-explicit.

### 5.1 Machine-readable lifecycle event source (no daemon git-watching)
The daemon does **not** observe git directly (§1.7). Instead, status reflux is driven by an explicit,
machine-readable **`record_lifecycle_event`** board command (reducer + control-plane funnel), emitted from three
concrete, already-existing actor paths:

1. **Dispatch tool** (`board_dispatch`, router) — emits `dispatched` (and, when the slug is known, treats the
   branch `task/<slug>` as expected). Maps → `in_progress` by default.
2. **Lifecycle tools / mail-thread markers** — the **assignee** signals progress without the daemon touching git;
   a lead/router may relay only through the privileged/router path (§5.2) or when it is itself the assignee — it
   gains no extra rights here. Via either:
   - a small role-gated MCP tool `board_lifecycle(taskId, kind, expectedRevision, expectedBoardRevision)` where the
     task's **assignee** (or a privileged actor) may emit `branch_created` / `accepted` (→ in_progress) and
     `review_requested` (→ in_review); a non-assignee member is rejected (`forbidden`); or
   - a **mail-thread marker**: `handleSendMail` already links a reply to the task by `task` ref (§5.4); a
     recognized structured marker on that thread (e.g. `send_mail(..., task:"<slug>", lifecycle:"review_requested")`,
     or a leading `[REVIEW]`/`[DONE]` intent token the plane parses) emits the same `record_lifecycle_event`.
     This reuses the existing mail channel as the lifecycle bus — the assignee's normal handoff mail moves the card.
3. **Integration flow** (router / prdmgr, the charter's integrator) — when integration/promotion happens, the
   router (or prdmgr via the REST/daemon path, actor `human`/`router`/`system`) emits `integration_ready`, which
   sets the task **close-ready** but does NOT move it to `done`.

`record_lifecycle_event` is **idempotent per `(taskId, kind, threadKey)`**: re-emitting an already-recorded event is
a no-op for status (and deduped in `lifecycleEvents`).

### 5.2 Event → status mapping (deterministic, monotonic, in the reducer)
| Lifecycle event | Source / actor | Status effect |
|---|---|---|
| `dispatched` | `board_dispatch` (router) | → `in_progress` (default; configurable to "stay `todo` until `accepted`") |
| `branch_created` / `accepted` | assignee (tool or mail marker) | → `in_progress` |
| `review_requested` (handoff) | assignee (tool or mail marker) | → `in_review` |
| `integration_ready` | router / human / system (integration) | sets `closeReady=true`; **no** status change |
| `reopened` | router / human | → `in_progress` (the only backward move; privileged-only) |

**Monotonic guard:** auto-reflux only advances to the mapped rank (`todo<in_progress<in_review`) and never
regresses (a late `dispatched` after `review_requested` is a no-op). Lifecycle events **never** set a terminal
status — `done`/`cancelled` are reached only via the existing privileged `set_task_status` (close). `reopened` is
the sole sanctioned backward transition and is privileged-only.

**Permission of lifecycle events** (reducer-enforced, consistent with §4): `dispatched`/`integration_ready`/
`reopened` are privileged (router/human/system); `branch_created`/`accepted`/`review_requested` are allowed for
the task's **assignee** (`ownsItem`) or a privileged actor. Thus a member can drive its own card up to `in_review`
but can neither dispatch, mark integration-ready, reopen, nor close — matching the locked matrix.

### 5.3 `board_dispatch` (recommended Alternative A, extended)
A **router-only** tool + internal `dispatchTask` funnel that, in one control-plane call, does more than assign+mail:
1. `assign_task(taskId, assignee)` (reducer, CAS-checked).
2. Set linkage on the task: `taskSlug = slug` (required/derived), `branchName = task/<slug>`,
   `dispatch = { assignee, threadKey: slug, at }`.
3. `handleSendMail(router → assignee, body = brief incl. `#N` + slug + instructions, task: "#N")` → `mailEventId`;
   the existing `link_mail` records it in `mailEventIds`, and `dispatch.mailEventId` is set.
4. `record_lifecycle_event("dispatched")` → status auto-moves to `in_progress` (per §5.2 default).
All board mutations go through the single `runBoardCommand` funnel (persisted + one `board_snapshot`).

**Why A over an outbox (Alternative B):** A reuses three existing primitives (`assign_task`, `handleSendMail`,
`link_mail`) + the new `record_lifecycle_event`, keeps dispatch an explicit deliberate router action (not a side
effect of every `board_assign`), needs no durable outbox/dedup machinery, and is in-process with the board so the
call is trivial and easy to test. Alternative B (assignment event → outbox → async `send_mail`, at-least-once +
dedup) only earns its complexity with cross-process or replayable dispatch, which we do not have; it would also
auto-dispatch on *every* assign including bookkeeping re-assigns. Keep `board_assign` as the pure "set the field"
op; `board_dispatch` is "assign + hand off + start lifecycle".

### 5.4 send_mail `task` field & link semantics
`handleSendMail`'s `task` field (§1.4) continues to accept **both** forms, resolved by an extended
`parseBoardTaskRef`: `#N`/`N` → resolve by board id (canonical); any other string → resolve by `Task.taskSlug`
match. `board_dispatch` writes `taskSlug`, so the mesh's existing `send_mail(task:"<slug>")` habit auto-links
replies to the right issue. `link_mail` (system, already idempotent on `mailEventId`, `board.ts:472`) maintains the
**issue↔mail** edge (`mailEventIds`); `taskSlug` maintains the **slug↔issue** edge; `dispatch.threadKey` (the slug)
maintains the **dispatch-thread↔issue** edge so a tagged reply on that thread routes its lifecycle event to the
right task.

### 5.5 Failure / retry / idempotency
- **Ordering:** board mutations (assign + linkage + `dispatched`) commit **first** (authoritative + persisted),
  then `send_mail` runs (already fire-and-forget). The status reflux therefore does not depend on mail succeeding.
- **Mail fails after board commit:** `dispatch.mailFailed=true`, `mailEventId` unset; the panel shows
  "dispatched (mail failed) — retry". A retry only re-sends the mail and back-fills `mailEventId`; it does **not**
  re-assign or re-emit `dispatched` (status already `in_progress`).
- **Duplicate dispatch (same assignee):** `record_lifecycle_event("dispatched")` is idempotent per
  `(taskId, kind, threadKey)`; the second call is a status no-op and just refreshes the thread/mail link.
- **Re-assign (different assignee):** `assign_task` updates the assignee, a new `dispatch` record + dispatch mail
  are made, a fresh `dispatched` event is appended (audit), status stays `in_progress` (monotonic — no regress).
- **Same-slug retry:** `taskSlug` is stable, so re-dispatching the same slug resolves the **same** issue (no
  duplicate task); `link_mail` idempotency prevents double mail links.
- **Out-of-order lifecycle events** (e.g. `review_requested` arrives before `dispatched` due to a fast worker):
  monotonic mapping still lands the correct max rank; both events are retained in `lifecycleEvents` for audit.

### 5.6 Close acceptance gate (kept, does not replace reflux)
`done`/`cancelled` remain privileged-explicit. The panel's close action surfaces `computeCloseReadiness` (open
subtasks / non-done deps / missing `integration_ready`) as a confirmation, never a hard block. `integration_ready`
sets `closeReady`; the router/human still performs the explicit close. This gate **supplements** auto-reflux (which
only runs up to `in_review`); it does not gate or replace it.

---

## 6. Phased plan (each phase independently shippable + testable)

The keystone (dispatch + lifecycle reflux) is pulled **early** into a vertical slice; labels/filter/kanban come
after. Each phase is independently shippable + testable.

- **Phase 0 — Model foundation (model-only, no UI).** Add the linkage + lifecycle fields (`taskSlug`,
  `branchName`, `dispatch`, `lifecycleEvents`, `closeReady`) and the `record_lifecycle_event` reducer command with
  its monotonic event→status mapping (§5.2) and permission gating; tighten `create_task` / `add_comment` to the
  matrix; scope member subtask ops to owned tasks; add `computeCloseReadiness`. Files: `board.ts`,
  `board-store.ts` (sanitizer defaults), `mesh-services.ts` (member tool set), tests. *Lowest risk; unblocks all.*
- **Phase 1 — Dispatch + lifecycle VERTICAL SLICE (keystone spike).** The minimal end-to-end closed loop:
  `board_dispatch` tool + `dispatchTask` control-plane funnel (`assign_task` + linkage + `send_mail` + `link_mail`
  + `record_lifecycle_event("dispatched")`→`in_progress`), the `board_lifecycle` tool / mail-thread marker path
  for `review_requested`→`in_review`, and the failure/retry/idempotency handling (§5.5). Minimal UI: the existing
  board tab's detail shows the dispatch + lifecycle timeline and reflowed status. Files: `control-plane.ts`,
  `board.ts`, `mesh-services.ts`, minimal `BoardPanel.tsx`, tests. *Proves the riskiest mechanism first.*
- **Phase 2 — List + detail views (semi-independent panel).** Panel layout, view switch, filter bar, list view,
  full detail view (read + gated edits + lifecycle/mail timeline). `BoardPanel.tsx` split into panel + views,
  store selectors; reuses GET/POST board. Component + e2e tests.
- **Phase 3 — Kanban view.** Columns by status, drag-to-status honoring per-actor permission + keyboard fallback.
  Drags emit the same status path (a member drag to `done` is rejected with a reason). UI-only + e2e.
- **Phase 4 — Labels + filter/search (postponed, as agreed).** Label CRUD (privileged), `set_task_labels`,
  filter/sort by label/status/assignee/text. `board.ts`, `mesh-services.ts`, `board-store.ts`, UI, tests.
- **Phase 5 — Integration/close UX polish.** `integration_ready` close-ready surfacing, close confirmation with
  `computeCloseReadiness`, reopened flow, linked-mail timeline polish. UI + control-plane, tests.

The keystone risk (dispatch + automatic lifecycle reflux) is proven in **Phase 1**, not deferred — views,
labels, and polish layer on top of an already-validated mechanism.

---

## 7. Risks / open questions / rejected alternatives

**Risks**
- **Lifecycle event delivery is only as reliable as its source.** Reflux depends on the assignee/router actually
  emitting `board_lifecycle` or a recognized mail marker (the daemon does not watch git). Mitigation: make
  `board_dispatch` auto-emit `dispatched`; make the assignee's normal handoff mail carry the marker; surface
  "stuck in in_progress with a replied thread" as a panel hint so a missed `review_requested` is visible.
- **Mail-marker parsing reliability.** Parsing `[REVIEW]`/`lifecycle:` markers off mail must be precise (avoid
  false positives from quoted text). Prefer an explicit structured `send_mail` field (`lifecycle:"…"`) over prose
  token scanning; the token path is a fallback. Pin with tests.
- **Whole-board CAS contention.** Every mutation carries `expectedBoardRevision` (`board.ts:205-208`); a busy board
  (router + members + kanban + lifecycle events) will see 409s. Mitigations: snappy re-fetch on conflict (small
  doc), optimistic UI with rollback. Open question: entity-only CAS for non-structural edits / lifecycle appends.
- **Dispatch partial success** (assigned + status moved, mail failed) must be visible, not silently "done" —
  mirror the `mutation-ack` saved-vs-applied lesson (§5.5).
- **Monotonic guard correctness.** Out-of-order / duplicate / re-assign lifecycle events must never regress or
  double-move status, and must never reach a terminal state — the single highest-value reducer test target.
- **Permission tightening is a behavior change** (members lose create / comment-anywhere); needs a clear
  `forbidden` message and a changelog note.
- **Migration**: old `boards/<mesh>.json` lacks the new fields; the sanitizer must default them (additive); assert
  in `board-store.test.ts`.
- **Full-screen panel vs mesh console**: don't regress the embedded board tab or the composer/canvas layout.

**DECIDED (locked by the user; Phase 0 implements the model for these)**
1. `dispatched` auto-sets `in_progress` directly (no separate accept step required). ✅ implemented in
   `record_lifecycle_event` (`forwardLifecycleStatus`).
2. `branch_created` / `review_requested` etc. are driven by **mail + tool** signals, never by the daemon reading
   git. ✅ the reducer command is source-agnostic; the emitting tool/mail path is Phase 1.
3. `integration_ready` is emitted by the **router** (privileged kind). ✅ `PRIVILEGED_LIFECYCLE`.
4. A **member may create/modify subtasks on a task it owns** (its assignee); non-owned is read-only. ✅
   `create_subtask` / `update_subtask` / `set_subtask_status` gate on `ownsItem(parentTask)`.
5. `board_assign` (pure set-field) and the future `board_dispatch` **coexist**. ✅ `assign_task` unchanged;
   `board_dispatch` arrives in Phase 1.
6. **Entity-level CAS** (supersedes the earlier whole-board-CAS suggestion): entity edits
   (`set_task_status` / `add_comment` / `update_task` / `assign`/`priority`/`deps` / subtask ops / lifecycle /
   `link_mail`) gate ONLY on the entity revision; **structural** changes (`create_task`, epic CRUD) still gate on
   the whole-board `expectedBoardRevision`. ✅ `STRUCTURAL_COMMANDS`. So concurrent edits to different tasks never
   false-conflict.

**Remaining open questions (later phases)**
- Human-assign-from-panel stays disabled (the reducer still allows the `human` actor for REST/automation) —
  confirm no operator override is wanted later.
- Kanban drag conflict UX under entity CAS (re-fetch + retry vs optimistic rollback) — Phase 3.

**Considered & rejected**
- **Auto-transition all the way to `done`** on an `integration_ready`/merge signal — rejected: close stays
  router/human-explicit (the locked matrix forbids member/auto close); integration only marks `closeReady`.
- **Daemon directly observing git** (watching `task/<slug>` branches / merges) — rejected for this design: it
  cross-cuts the daemon's process model (§1.7). Lifecycle events instead come from explicit machine-readable
  tool/mail sources, which a future git-watcher could *also* emit into without changing the reducer.
- **Outbox-driven async dispatch (Alternative B)** — over-engineered for a single in-process daemon; adds
  durability/dedup complexity with no current payoff.
- **Cross-mesh issues** — explicitly out of scope (per-mesh only).

---

## 8. Per-phase acceptance

- **Phase 0 (model foundation):** reducer unit tests assert — members get `forbidden` on `create_task` and on
  `add_comment` for non-owned items; assignee can comment/status own; `record_lifecycle_event` maps each kind to
  the right status with the **monotonic guard** (a late/duplicate/out-of-order event never regresses and never
  reaches a terminal status); lifecycle permission gating (member may emit `branch_created`/`accepted`/
  `review_requested` on owned task, but not `dispatched`/`integration_ready`/`reopened`/close); sanitizer defaults
  the new fields on a legacy board. `bunx tsc --noEmit`, `bun test src/board.test.ts src/board-store.test.ts`.
- **Phase 1 (dispatch + lifecycle vertical slice):** `control-plane-board.test.ts` asserts the closed loop —
  **`board_dispatch` → status becomes `in_progress`**, assigns, sends exactly one mail, `link_mail` records it,
  `taskSlug`/`branchName`/`dispatch` set; **`review_requested` (tool or mail marker) → status becomes `in_review`**;
  **`integration_ready` → `closeReady=true` but status stays `in_review` (NOT auto-`done`)**; `done`/`cancelled`
  only via privileged close; member cannot call `board_dispatch`/`integration_ready` (router-only); partial failure
  (mail fails → assignment + `in_progress` stand, `dispatch.mailFailed` surfaced); idempotent re-dispatch / re-assign
  do not double-move or regress status. `board.e2e.ts` (or a focused e2e): router dispatches, assignee receives
  mail, card shows `in_progress`; a review-request marker moves it to `in_review`. tsc + targeted tests + e2e.
- **Phase 2 (list + detail):** `BoardPanel.test.tsx` covers list + detail render, filter bar, gated edits running
  vs stopped, lifecycle/mail timeline; `board.e2e.ts` opens a detail by `#N` and round-trips a gated edit.
- **Phase 3 (kanban):** component test for kanban columns + permission-gated drag (member drag to `done` rejected
  with reason); keyboard fallback asserted; e2e drags a card and verifies status persisted via WS snapshot.
- **Phase 4 (labels/filter):** reducer tests for label CRUD + `set_task_labels` permissions; `board-store.test.ts`
  asserts label round-trip + default-on-missing migration; UI filter test.
- **Phase 5 (integration/close UX):** close confirmation surfaces `computeCloseReadiness` (open subtasks / non-done
  deps / missing `integration_ready`); `reopened` returns `in_progress` (privileged); explicit close still required
  for `done`/`cancelled`. (No "status frozen until manual action" assertion — auto-reflux up to `in_review` is the
  expected behavior, pinned in Phase 0/1.)

E2E/browser gates are opt-in/slow; each phase states which it runs.
