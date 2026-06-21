# 14 · Existing-capability audit — missed [E] capabilities (backward-consistency)

**Why.** prdmgr/user found confirmed existing-UI capabilities missing from the Phase A
coverage map and the signed-off Phase B mockups. This is a docs-only audit: read the
real `src/web/client/*` code, enumerate every visible capability, and list **only the
missing [E] (existing) capabilities** — those the shipped app has today but the
coverage docs (`01`–`13`) and/or the `/__ui-mockup` mockups do not represent.

**Method.** Three read passes over the real code (Explore inventory) + a grep/Read
verification pass on every capability cited below (per the verify-before-citing rule —
this caught one fabricated claim, see "Dropped"). Each row is grounded in a real
file/identifier. **No coverage docs or mockups were modified in this checkpoint.**

**Sources read / audited:** `MeshBuilder.tsx`, `MeshDetail.tsx`, `ChatPane.tsx`,
`ui.tsx`, `Transcript.tsx`, `VirtualTranscript.tsx`, `Sidebar.tsx`, `MeshCanvas.tsx`,
`HarnessPanel.tsx`, `BoardPanel.tsx`, `Theme.tsx`, `FileViewer.tsx`, `Markdown.tsx`,
`Boot.tsx`/`device-auth.ts`, `src/acp/types.ts`, `auto-compact.ts`.

**Legend.** Follow-up bucket: **C** = coverage-map patch, **M** = mockup patch, **C+M**
= both. ⭐ = lead/prdmgr seed miss (pre-confirmed).

## New-mesh builder (owning surface `04-new-mesh`)
| # | Missing [E] capability | Code location | Current behavior | Why missed | Bucket |
|---|---|---|---|---|---|
| 1 ⭐ | Per-agent **instructions** field (max 4000) | `MeshBuilder.tsx` `agent-instructions` textarea; `src/acp/types.ts:60` `instructions?`; validate `>4000` (`MeshBuilder.tsx:169`) | Free-text per-agent instructions injected into that agent's briefing | 04 mockup/coverage only showed id/harness/project/role | C+M |
| 2 ⭐ | **Expanded text-editor modal** (charter + instructions) | `MeshBuilder.tsx` `TextEditorDialog` (`text-editor-dialog`, `role="dialog"`, `aria-modal`), `openExpandedText`/`applyExpandedText`/`closeExpandedText`, Esc + Tab-trap, char-count | Click "expand" → focus-trapped full editor for long charter/instructions | dialog/modal family never inventoried | C+M |
| 3 | Per-agent **model** select + probe/retry | `MeshBuilder.tsx` `model` (`adv-sel`), `ModelProbeState`, retry on probe error | Pick model per agent (probed from harness; loading/error/retry) | builder coverage stopped at role | C+M |
| 4 | Per-agent **reasoning effort** select | `MeshBuilder.tsx` `effort` (`adv-sel`); `isEffortSupportedByHarness` | Pick effort where harness supports it | not inventoried | C+M |
| 5 | Per-agent **lazy** (lazy-spawn) checkbox | `MeshBuilder.tsx` `lazy`; "router agents cannot be lazy" | Mark a member lazy-spawned (router disallowed) | not inventoried | C+M |
| 6 | **opencode permission** select (ask/allow) | `MeshBuilder.tsx` `opencodePermission` | opencode-only permission mode | not inventoried | C+M |
| 7 | **Auto-compact** enable toggle + threshold input | `MeshBuilder.tsx` `auto-compact-section`, `mesh-auto-compact-threshold`; `auto-compact.ts` | Per-mesh auto-compact on/off + % threshold (validated) | mesh-level settings never inventoried | C+M |
| 8 | Mail-edge **steer** checkbox | `MeshBuilder.tsx` `EdgeDraft.steer`/`setEdgeSteer`; "cannot enable steer to the router" | Per-edge steer flag (declare an edge as steer-capable) | edges modeled as plain from→to only | C+M |

## Runtime view (owning surface `02-runtime`)
| # | Missing [E] capability | Code location | Current behavior | Why missed | Bucket |
|---|---|---|---|---|---|
| 9 ⭐ | **Session fullscreen** toggle | `MeshDetail.tsx` `onToggleFull`, `⊞ full`/`⊟ exit` (`:444`) | Expand the conversation pane to fullscreen / restore split (desktop) | not inventoried | C+M |
| 10 | Per-agent **runtime selectors**: mode / model / effort / kimi-thinking | `MeshDetail.tsx` `ModeControl`/`ModelControl`/`EffortControl`/`KimiThinkingControl` | Live-change an agent's ACP mode, model, effort, kimi thinking variant | runtime coverage listed only steer/interrupt/approve/new-session | C+M |
| 11 | **Wake** lazy/cold agent | `MeshDetail.tsx` `store.wakeAgent`, "wake" (`:423`) | Wake a cold lazy agent | not inventoried | C+M |
| 12 | **Context usage chip + near-limit warning + silent-stop badge** | `MeshDetail.tsx` `ContextUsageChip`/`ContextWaterline` (`./health`), `silent-stop-badge` (`:407`) | Per-agent context/cost waterline, near-limit warning, silent task-complete badge | health/usage surfaces never inventoried | C+M |
| 13 | **Pending-turns queue** UI (prev/next nav + remove) | `ChatPane.tsx` `queue-box`, `queueNavState` (canPrev/canNext), `removeQueued` | Browse/remove queued prompts when an agent is busy | queue concept absent from coverage | C+M |
| 14 | **Transcript item expand toggles** (thought / tool-call / mail) | `Transcript.tsx` `setOpen` (thought `:60`), `setOverride` (tool `:95`), `mail-expand-btn` (`:239`) | Expand/collapse thoughts, tool input/output/files, long mail bodies | transcript modeled as flat bubbles | C+M |
| 15 | **Jump-to-bottom + load-older** transcript controls | `VirtualTranscript.tsx`/`Transcript.tsx` `jump-bottom`/`jumpToBottom`, `onLoadOlder` | Resume autoscroll; lazy-load older history | not inventoried | C+M |
| 16 | **Zoomable topology canvas** (MeshCanvas overlay) | `MeshDetail.tsx` `⤢`/`setTopoOpen` → `MeshCanvas.tsx`: window drag (`startDrag`)/resize (`startResize`)/focus, per-window stop/wake, actions menu, Esc close | Full draggable/resizable topology editor overlay (desktop) | coverage said "zoomable canvas deferred-on-mobile" but never enumerated its controls | C+M |
| 17 | **Live topology manage** (add agent / add edge to a running mesh) | `MeshDetail.tsx` `agent-add` / `edge-add` controls | Add an agent or edge to an already-running mesh | runtime coverage only had start/stop/restart | C+M (assigned to `02-runtime` by decision) |
| 18 | **Start-strategy select (resume/fresh)** + **new-all-sessions** | `MeshDetail.tsx` `start-session-sel`; `newAllSessions` two-click | Choose session strategy before start; reset all sessions on a live mesh | only generic start/stop captured | C+M |

## App shell (owning surface `01-app-shell`)
| # | Missing [E] capability | Code location | Current behavior | Why missed | Bucket |
|---|---|---|---|---|---|
| 19 | Mesh-list **pagination** (‹ ›, 4/page) | `Sidebar.tsx` `setPage`, `PER_PAGE` | Page through the mesh list | nav modeled as a flat scroll list | C+M |
| 20 | **Reload mesh definitions** (↻ two-click confirm) | `Sidebar.tsx` `store.reload`, `reload.confirm` | Re-read mesh defs from server | not inventoried | C+M |

## Mesh Assistant (owning surface `05-assistant`)
| # | Missing [E] capability | Code location | Current behavior | Why missed | Bucket |
|---|---|---|---|---|---|
| 21 | Assistant chat **fullscreen** toggle | `Sidebar.tsx` `AssistantChat` `onToggleFull`, `⊟`/`⊞` | Expand assistant chat to fill the column | not inventoried (05 not yet mocked, but it's an existing [E]) | C (M when 05 ships) |

## Board (owning surface `03-board`)
| # | Missing [E] capability | Code location | Current behavior | Why missed | Bucket |
|---|---|---|---|---|---|
| 22 | Board **fullscreen** toggle | `BoardPanel.tsx` `board-fs-btn`, `setFullscreen` | Expand the board panel to fullscreen | not inventoried | C+M |
| 23 | **Group-by-epic** toggle | `BoardPanel.tsx` `groupByEpic`/`setGroupByEpic` | Toggle list grouping by epic | coverage mentioned epic grouping but not the control | C+M |
| 24 | **Manage-labels** CRUD + accessible color **palette picker** | `BoardPanel.tsx` `LabelManager`/`setManage` (`board-manage-labels`), `PalettePicker` (create/rename/recolor/delete) | Create/rename/recolor/delete board labels with an AA color palette | label management never inventoried | C+M |
| 25 | **create-epic** row + **reopen** closed task | `BoardPanel.tsx` `CreateRow` (epic), reopen lifecycle (`:940`) | Create epics from the board; reopen a done/cancelled issue | only implied by lifecycle; now explicit in board | C+M (explicit in `03-board` by decision) |

## Harnesses (owning surface `06-harnesses`)
| # | Missing [E] capability | Code location | Current behavior | Why missed | Bucket |
|---|---|---|---|---|---|
| 26 | **Install progress** live log + retry-stream + close | `HarnessPanel.tsx` `InstallProgress` (running/done/error/interrupted) | Stream install output; retry a dropped stream; dismiss | coverage said "install streaming" but not the retry/close affordances | C+M |
| 27 | **Self-install guide**: copy command + official-docs link + reprobe | `HarnessPanel.tsx` `SelfInstallerGuide` (`copy command`, official docs, "reprobe to detect") | Copy a self-install command + open docs + reprobe (for npm-locked harnesses) | not inventoried | C+M |
| 28 | **Restart old-version agents**: force vs after-idle + cancel-pending | `HarnessPanel.tsx` `OldVersionAgents` `respawnAgent("force"|"after-idle"|"cancel")` | After-idle / force (two-click) restart + cancel a pending restart | coverage had a single "restart old-version" row | C+M |

## Dropped (verification rejected a subagent claim)
- **Theme custom-palette JSON import/export** — an inventory pass claimed `Apply JSON`/
  `From current` in `Theme.tsx`, but grep found **no** `json`/`export`/`apply` strings
  there. Not a real capability → **excluded**. (Theme's real editor = preset select +
  per-key color/hex inputs + save/cancel, already covered by `09-settings`.)

## Summary
- **Missing [E] capabilities: 28** (incl. 3 confirmed seed misses ⭐: #1 instructions,
  #2 expanded-text dialog, #9 session fullscreen).
- Owning-surface spread: 04 ×8, 02 ×10, 01 ×2, 05 ×1, 03 ×4, 06 ×3.
- Follow-up: ownership is fully resolved (see below); most rows are **C+M** (patch both the
  coverage matrix row and the mockup state); #21 (assistant fullscreen) is **C now, M when
  surface 05 ships**.

## Resolved ownership decisions (prdmgr/user, final)
- **#17 live add agent / add edge** → `02-runtime` (in scope for the runtime redesign).
- **#25 create-epic / reopen** → `03-board` (explicit in the board surface).
- **#7 auto-compact settings** → `04-new-mesh` (stays in the builder).
- **#12 context / health usage UI** → `02-runtime`.
All four are reflected in the owning surface docs (Step 1 coverage completion) and slated
for mockup patches (M) in Step 2.

## Status
- **Coverage-map completion (Step 1) DONE 2026-06-21**: all 28 rows folded into the owning
  surface docs (`01`×2, `02`×10, `03`×4, `04`×8, `05`×1, `06`×3) — each added to the
  function checklist **and** the rectangular Function × state matrix (cells filled
  ✓/△(reason)/N/A). Resolved ownership decisions applied (see section above): #17 live
  add agent/edge → `02-runtime`; #25 create-epic/reopen explicit in `03-board`; #7
  auto-compact stays in `04-new-mesh`; #12 context/health → `02-runtime`. Mockup patches
  (M) deferred to a later released step.

## Change log / sources read
- 2026-06-21 — created (backward-consistency audit, step 1+2 only). Sources audited +
  grep-verified per the list above; one fabricated claim dropped. No coverage/mockup
  files modified at audit time.
- 2026-06-21 — Step 1 coverage-map completion: 28/28 folded into `01`–`06` (this commit).
