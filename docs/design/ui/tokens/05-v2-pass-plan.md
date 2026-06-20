# Step 3 token v2 — full-pass PLAN & artifact organization (checkpoint 0)

**This is the planning commit for the approved v2 pass.** It records the build contract (the 6 locked decisions), the v2 doc/file organization, the **9-state sample-board organization with reasoning**, and the stop-by-stop commit sequence. No palettes/artifacts are produced in this commit — those come in the subsequent stopped checkpoints. Base: main `36e8145` (the approved proposal `04-token-system-revision-proposal.md` is integrated). Still design/docs/artifact only — **no `src/web`, build config, or real `contrast.ts` changes in the whole pass.**

## Build contract — the 6 locked decisions (prdmgr/user)
1. **Scale depth: 11 stops, 50–950** (50,100,200,300,400,500,600,700,800,900,950).
2. **`surface-step`: report-only** (computed + reported, not a hard gate yet).
3. **`text-secondary`: ≥5.5 soft target** (AA 4.5 hard floor + 5.5 design goal).
4. **Accent per-mode stops allowed** — each accent may pick a different stop per background mode so all 9 combinations pass.
5. **Raw scales exposed in Tailwind but lint-discouraged** — generated `raw-*` utilities exist; component use of `raw-*` triggers lint and needs an explicit disable + reason (an implementation-time rule, recorded now).
6. **Default landing combo: Dark·Slate × Signal Teal** — default only; all 3 accents remain first-class runtime choices.

## v2 doc/file organization (under `docs/design/ui/tokens/`)
v1 docs `00`–`03` are **superseded** by v2 (content rewritten in place; v1 preserved in git history + noted in each change log). `04` (proposal) and this `05` (plan) stay as historical record.
| file | v2 content |
|---|---|
| `00-tokens.md` | v2 index + two-layer model + runtime `compose(mode,accent)` + the 6 decisions + **old↔new token comparison table** |
| `01-palettes.md` | v2 values: **raw 11-stop scales** (3 neutral: slate/cool/warm · status: green/amber/red/blue/gray · 3 accent: signal-teal/ember/fleet-azure) **+ semantic maps** per mode + accent derivatives (incl. per-mode accent stops) |
| `02-aa-evidence.md` | v2 **contrast report — all 9 combinations**, marking which pairs are AAA / stronger-than-AA vs v1, with the reproduction command |
| `03-themed-components.md` | v2 themed component drafts **annotated to semantic tokens**, + references to the 9-state sample boards |
| `04-…proposal.md` | unchanged (approved proposal, historical) |
| `05-v2-pass-plan.md` | this plan (historical record of the pass) |

(If the lead prefers brand-new `1x-*` files instead of rewriting `00`–`03`, say so; default plan is rewrite-in-place to keep the role-per-file structure and avoid sprawl.)

## Artifact organization (→ `$AGENT_MESH_ARTIFACTS`, NOT committed)
Constraint: **Feishu image scaling unsolved → keep each image ≤ ~1500px wide, or split by mode.** All boards rendered via the repo's known-good chromium (as in v1), `deviceScaleFactor` tuned so width stays ≤1500px.

### 9-state component sample board — **recommended: split per mode (3 images)**
The deliverable is "3 modes × 3 accents = 9 states" of the key Step 2 components (StatusListRow, PanelFrame, Button states, IssueListRow, Composer, ApprovalCard). Three layout options considered:
| option | layout | width | verdict |
|---|---|---|---|
| **A. one big 3×3 image** | 3 accent columns × 3 mode rows, each cell a component stack | ~2400–3000px wide (3 full component columns) | ✗ **breaks the ≤1500px Feishu rule**; also unreadable when scaled down |
| **B. split per mode (3 images)** | one image per background mode, 3 accent columns within | ~1300–1450px wide each | ✅ **recommended** — each fits the width rule, groups by the dominant visual context (background), and all 9 states are covered across the 3 images |
| C. split per component (6 images) | one image per component, 9 cells (3×3) | ~1400px but 6 files | good for comparing one component across themes, but fragments the "theme feel"; more files |

**Plan = Option B**: `v2-sample-dark-slate.png`, `v2-sample-light-cool.png`, `v2-sample-eye-care-warm.png`. Each shows that mode under Signal Teal · Ember · Fleet Azure across the component set. Reasoning: satisfies the width constraint without fragmenting, and "background mode" is the strongest grouping axis (surfaces/text change most between modes; accent is the smaller delta). If the lead wants single-component comparison too, I can add Option C as a supplement — flag if desired.

### Other artifacts (each ≤1500px or split per mode)
- **Old↔new token swatch comparison**: `v2-tokens-old-new.png` — v1 19-key swatches beside v2 raw-scales + semantic. If too wide, split into `…-raw.png` (the 11-stop ramps) + `…-semantic.png` (per-mode semantic + accent derivatives). Likely split per mode for the semantic half.
- **Raw scale board**: the 11-stop ramps (neutral×3 + status + accent×3) as labeled rows — narrow rows, one image fits.
- **Contrast report**: a doc/table (`02-aa-evidence.md`), no width issue; an optional compact per-combo pass-summary image only if useful.

## Commit sequence (each STOPS with a [REQ] report; docs-only; `git diff --check` each)
0. **(this commit)** v2 pass plan + 9-state board organization. → [REQ]
1. **v2 raw scales + semantic maps** (`01-palettes.md`): the 11-stop ramps + per-mode semantic maps + per-mode accent stops. Values chosen to pass §contrast; verified by the report in step 2. → [REQ]
2. **v2 contrast report, all 9** (`02-aa-evidence.md`): `compose(mode,accent)` × `AUDIT_PAIRS` over 9, via the repo's real contrast math in a throwaway `/tmp` script (as v1), marking AAA/stronger upgrades. (If a combo fails, tune step-1 values and re-run before reporting.) → [REQ]
3. **v2 index + model + old↔new comparison** (`00-tokens.md`) + **v2 themed component drafts** (`03-themed-components.md`, semantic-annotated). → [REQ]
4. **Artifacts**: render + publish the 3 per-mode sample boards + swatch/comparison boards to `$AGENT_MESH_ARTIFACTS` (not committed); add references in `03`. → [REQ]
5. **Step 4 re-review** (separate stopped checkpoint): re-check Steps 1–3 self-consistency after the v2 token docs — re-annotate Step 2/3 component docs from old token names to the v2 semantic names, update `04-cross-review.md`/logs. → [REQ]

(Steps 1–2 may be combined if values+report land together cleanly; I'll still stop with one [REQ] before moving on. Step 5 of THIS sequence — the Step-4 re-review — is explicitly a separate stopped checkpoint per the lead.)

## Discipline
- **Docs-only the entire pass**; no `src/web`, build config, or real `contrast.ts`. Contrast math is *exercised* via throwaway `/tmp` scripts that import the repo's current `contrast.ts` read-only (the v2 contract changes in §3 of the proposal are described for later Step-5 implementation, not applied to the file now).
- Generated PNGs go to `$AGENT_MESH_ARTIFACTS` only, **never committed**; kept ≤~1500px wide or split per mode.
- Every commit ends with a [REQ] checkpoint report (hash, files, summary, checks). `git diff --check` minimum; docs-only ⇒ code gates not run (stated explicitly each time).

## Change / review log
- 2026-06-20 — created (v2 pass, checkpoint 0): build contract (6 decisions), v2 doc organization, 9-state sample-board plan (Option B = split per mode, with reasoning + width math), commit sequence. No palettes/artifacts yet. Awaiting lead OK on the plan (esp. board organization + rewrite-in-place vs new files) before generating v2 values/artifacts.
