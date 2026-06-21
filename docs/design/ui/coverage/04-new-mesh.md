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
- **Draw/declare mail edges** [E] — topology (desktop draw; mobile from/to picker).
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

## Change log / sources read
- 2026-06-21 — created (Phase A commit 3). Sources: `../interaction/04-new-mesh-builder.md`;
  `MeshBuilder.tsx`, `store.ts` `defineMesh`, `meshes/*.json`.
