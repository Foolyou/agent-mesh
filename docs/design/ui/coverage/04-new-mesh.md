# 04 · New mesh builder — coverage

**Scope / routes.** Define or edit a mesh: name, agents (id/harness/project/role
router|member), mail edges (topology), optional team charter → a mesh definition the
runtime can start. `/mesh/new` · `/mesh/<m>/edit`.
**Desktop/mobile.** Desktop: full builder (agent rows + edge drawing). Mobile:
single-column stacked form, edge drawing simplified to from/to picker list — full
builder secondary on phone (creation is rare on mobile, △).
**Exists vs net-new.** [E] mesh create/define + `meshes/*.json`; [N] redesigned builder UI.
**Sources read.** `../interaction/04-new-mesh-builder.md`; repo: `MeshBuilder.tsx`,
`store.ts` `defineMesh(config: MeshConfig)`, `meshes/*.json` (reload API after edit).

## Function / control / action checklist
- **Set mesh name** [E] — validated (unique).
- **Add/remove agent** [E] — pick harness + project + role (router/member).
- **Per-agent instructions** [E] — free-text per-agent instructions (max 4000; `acp/types.ts` `instructions`), injected into that agent's briefing. (audit #1)
- **Expanded text-editor modal** [E] — `TextEditorDialog` (`text-editor-dialog`, `role=dialog`, `aria-modal`, Esc + Tab-trap, char-count) for charter + instructions long-text. (audit #2)
- **Per-agent model select** [E] — probed from harness; loading/error/retry (`adv-sel`). (audit #3)
- **Per-agent effort select** [E] — reasoning effort where harness supports it. (audit #4)
- **Per-agent lazy checkbox** [E] — lazy-spawn member (router disallowed). (audit #5)
- **opencode permission select** [E] — ask/allow (opencode-only). (audit #6)
- **Auto-compact settings** [E] — per-mesh enable toggle + threshold % input (`auto-compact.ts`). (audit #7, stays in new-mesh per triage)
- **Draw/declare mail edges** [E] — topology (desktop draw; mobile from/to picker).
- **Mail-edge steer checkbox** [E] — per-edge steer flag (cannot steer to the router). (audit #8)
- **Write charter** [E] — optional team charter text.
- **Save (define) / Cancel** [E] — `defineMesh`; save disabled until valid.

## Function × state matrix
✓ designed · △ partial/deferred (reason) · N/A not applicable

| Function | empty | loading | populated | error | permission | busy | offline | boundary/scale | desktop | mobile |
|---|---|---|---|---|---|---|---|---|---|---|
| Set mesh name [E] | ✓(blank) | N/A | ✓(hydrated on edit) | ✓(dup-name inline) | N/A | △(locked while saving) | △(disabled offline) | ✓(long name trunc) | ✓ | ✓ |
| Add/remove agent [E] | ✓(1 router prefilled) | N/A | ✓ | ✓(no-router error) | N/A | △(locked) | △(disabled) | ✓(N agents scroll) | ✓ | △(accordion) |
| Mail edges [E] | ✓(none) | N/A | ✓ | ✓(bad-edge inline) | N/A | △(locked) | △(disabled) | ✓(dense graph) | ✓(draw) | △(from/to list) |
| Charter [E] | ✓(empty) | N/A | ✓ | ✓ | N/A | △(locked) | △(disabled) | ✓(long text) | ✓ | ✓ |
| Save / Cancel [E] | ✓(save disabled until valid) | N/A | ✓ | ✓(save failed→banner+retry) | △(perm to create) | ✓(spinner) | △(disabled offline) | N/A | ✓ | ✓ |
| Per-agent instructions [E] (audit #1) | ✓(empty) | N/A | ✓(hydrated) | ✓(>4000 inline error) | N/A | △(locked) | △(disabled) | ✓(long text→expand) | ✓ | ✓ |
| Expanded text-editor modal [E] (audit #2) | N/A | N/A | ✓(charter/instructions) | ✓(over-limit) | N/A | △(locked) | △(disabled) | ✓(very long text scroll) | ✓(focus-trap dialog) | ✓(full-screen sheet) |
| Per-agent model [E] (audit #3) | ✓(default) | ✓(probing) | ✓(selected) | ✓(probe fail→retry) | N/A | △(locked) | △(disabled) | N/A | ✓ | ✓ |
| Per-agent effort [E] (audit #4) | ✓(default) | N/A | ✓ | ✓(invalid-for-harness) | N/A | △(locked) | △(disabled) | N/A | ✓ | ✓ |
| Per-agent lazy [E] (audit #5) | ✓(off) | N/A | ✓ | ✓(router-cannot-be-lazy) | N/A | △(locked) | △(disabled) | N/A | ✓ | ✓ |
| opencode permission [E] (audit #6) | N/A(non-opencode) | N/A | ✓(opencode only) | ✓(misapplied error) | N/A | △(locked) | △(disabled) | N/A | ✓ | ✓ |
| Auto-compact settings [E] (audit #7) | ✓(default 85%) | N/A | ✓(toggle+threshold) | ✓(bad-threshold inline) | N/A | △(locked) | △(disabled) | N/A | ✓ | ✓ |
| Mail-edge steer checkbox [E] (audit #8) | N/A(no edges) | N/A | ✓(per-edge) | ✓(steer-to-router error) | N/A | △(locked) | △(disabled) | ✓(many edges) | ✓ | △(in from/to picker) |

## Change log / sources read
- 2026-06-21 — created (Phase A commit 3). Sources: `../interaction/04-new-mesh-builder.md`;
  `MeshBuilder.tsx`, `store.ts` `defineMesh`, `meshes/*.json`.
- 2026-06-21 — backward-consistency completion (audit `14`): +per-agent instructions (#1),
  +expanded text-editor modal (#2), +model (#3), +effort (#4), +lazy (#5), +opencode
  permission (#6), +auto-compact settings (#7, stays here per triage), +edge steer (#8).
  `MeshBuilder.tsx` (`TextEditorDialog`/`openExpandedText`), `acp/types.ts`, `auto-compact.ts`.
- 2026-06-21 — Phase B user-review **C3 (long-form scrolling)**: boundary fixture raised to
  **12 agents** (the long-form verification target). The whole page scrolls as one — the
  agent list is **never** a nested fixed-height overflow region (no scroll-within-scroll
  trap), so the last row is always reachable. The mesh-name echo + Cancel/Save action area
  stays reachable while scrolling: **desktop** = a `sticky top-0` action bar
  (`data-newmesh-actionbar="sticky"`); **mobile** = whole screen scrolls with Save in a
  **fixed bottom footer** (`data-newmesh-actionbar="footer"`), agent cards keep the C1
  vertical stacking. `+ Add agent` (`data-newmesh-addflow`) mocks the add flow as
  *auto-scroll-the-new-row-into-view + focus its first field* — represented statically by
  the highlighted "just-added" 12th row (`data-newmesh-newest`, accent ring + focused
  `agent id`). Tradeoff: real `position:sticky` pins against the runtime viewport (Step 7);
  in the static doc card the desktop frame grows so all 12 rows render in one screenshot.
