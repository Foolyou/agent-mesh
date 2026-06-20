# Step 3 token-system revision — PROPOSAL DRAFT (checkpoint 1)

**Status: proposal for prdmgr/user approval. Nothing here is final.** This is the *first checkpoint* of a Step-3 rework requested 2026-06-20: it proposes the **naming model + scale plan + contrast-threshold-upgrade plan + migration + artifact plan**. It does **not** ship final palettes, final sample boards, or any `src/web`/build code. Illustrative values below are explicitly marked **(non-final, illustrative)**. After approval, a second pass applies the full v2 token docs/palettes/artifacts, then Step 4 consistency is re-run.

Supersedes (on approval) the v1 single-layer model in `00`–`03`. We are still inside `ui-design-pipeline` Step 3; Step 5 remains blocked.

---

## 0. Current code facts (inspected live on `a10a2f5`, not from memory)
From `src/web/client/contrast.ts` + `themes.ts` as they exist now:
- **Thresholds**: `AA_TEXT=4.5`, `AA_LARGE=3.0`, `AAA_TEXT=7.0`, `UI_COMPONENT=3.0`.
- **9 families** (`type Family`) → `FAMILY_THRESHOLD`:
  - `text`, `status-text`, `selection`, `syntax`, `tinted-text` → **4.5**
  - `status-dot`, `focus`, `border`, `disabled` → **3.0** (`disabled` is a hard usability floor, WCAG-exempt but enforced)
- **`AUDIT_PAIRS = buildPairs()`** enumerates **47 pairs** over `SURFACES = [bg, bg-raise, bg-inset]`; the `advisory?` flag exists on `AuditPair` but **no pair currently sets it**, so all 47 are hard gates. `evalPair` = `pass = advisory ? true : ratio >= FAMILY_THRESHOLD[family]`; tints are resolved via `resolveColor` (`color-mix` → `blend`).
- **`THEME_KEYS`** = **19** single-layer tokens (`bg, bg-raise, bg-inset, line, line-bright, fg, fg-dim, fg-faint, ok, warn, bad, off, info, link, good, accent, focus, sel-bg, sel-fg`). `applyPalette()` writes `--<key>` on `:root`. 8 legacy builtins still in code; the v1 3×3 palettes are design-only (Step 5 blocked).

This is the contract any upgrade must extend; the rebuild plans in §3 are written against these exact names.

---

## 1. Two-layer token model (requirement 1)

### Layer A — Raw palette (primitive scales). *Components MUST NOT reference these.*
Pure color ramps, named `--raw-<family>-<stop>`. **Stops: 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950 (11 stops)** — Tailwind-v4-aligned; `950` gives dark-mode depth, `50` gives light-mode tint. (Open option: 9 stops 100–900 if 11 proves excessive — recommend 11.)

Raw families:
- **3 neutral ramps** (mode-defining hue): `neutral-slate` (Dark·Slate), `neutral-cool` (Light·Cool), `neutral-warm` (Eye-care·Warm). Each is a full 11-stop ramp.
- **Shared status ramps**: `green`, `amber`, `red`, `blue`, plus `gray` (idle/off). Each 11 stops; modes pick AA-correct stops (light modes pick darker stops, dark modes lighter).
- **3 accent ramps**: `teal`, `ember`, `azure` — each a full 11-stop ramp. The accent is a **replaceable slot** (§2).

Raw layer lives as CSS custom properties too (`--raw-slate-500: #…`) but is **not** in the component-facing contract; lint/convention forbids `text-raw-*`/`bg-raw-*` utilities.

### Layer B — Semantic tokens (component-facing role aliases). *Components use ONLY these.*
Each semantic token is an **alias that maps to a raw stop**; a theme = a mapping, a custom palette = an overridden mapping. Proposed semantic set (covers every role the user listed + the v1 19):

| group | semantic token(s) |
|---|---|
| surfaces | `surface`, `surface-raised`, `surface-sunken`, `surface-overlay` (scrim) |
| borders | `border` (divider/hairline), `border-strong` (control/interactive edge) |
| text | `text-primary`, `text-secondary`, `text-muted`, `text-disabled`, `text-on-accent`, `text-on-selected`, `link` |
| status | `success`, `warning`, `danger`, `info` (+ `success-strong`/etc. only if needed for tints) |
| brand | `accent`, `accent-strong` |
| syntax | `syntax-keyword`, `syntax-string`, `syntax-comment` (or keep mapping to status/info+good+muted) |
| interaction states | `hover` (surface wash), `active` (pressed wash), `focus-ring`, `selected` (bg) + `text-on-selected`, `disabled` (surface), plus role state variants `accent-hover`, `accent-active` |

Interaction-state modeling (recommended): a small set of **state overlay tokens** (`hover`, `active` as translucent washes over the current surface; `selected` as a fill; `focus-ring` as a ring color; `disabled` as the muted surface) **plus** per-role variants only where a fill changes (`accent-hover`, `accent-active`). This avoids a combinatorial explosion (every role × every state) while still being explicit for the common buttons/nav cases.

**Rule:** component docs (Step 2) and themed drafts (Step 3) reference semantic names only; theme/custom changes alter the A→B mapping, never the components.

---

## 2. Scales & the 3×3 matrix, made systemic (requirement 3)

- **Mode = neutral ramp + status-stop selection.** Each of the 3 modes binds `surface*`/`text*`/`border*` to its neutral ramp's stops and picks AA/AAA-correct status stops. (non-final, illustrative) Dark·Slate: `surface=slate-950`, `surface-raised=slate-900`, `surface-sunken=slate-975/black`, `border=slate-800`, `border-strong=slate-600`, `text-primary=slate-50`, `text-secondary=slate-300`, `text-muted=slate-400`. Light·Cool inverts (`surface=cool-50`, `text-primary=cool-950`, …). Eye-care·Warm uses the warm ramp at gentler steps.
- **Accent = a replaceable slot bound to one accent ramp.** `accent → <chosen>-{stop}`, `accent-strong → <chosen>-{stop±1}`, `text-on-accent → contrast pick`. Choosing Teal/Ember/Azure later = rebinding the slot to `teal`/`ember`/`azure` ramps; **no component or other-token change**. The "3×3" is therefore *3 mode maps × 1 accent slot with 3 candidate ramps*, not 9 hand-built palettes.
- **Custom palette** overrides the semantic map (advanced) or a few raw stops (simple); the editor shows a live `contrast.ts` readout per semantic pair (carry-over from v1 recommendation, now per-semantic-role).

This makes the matrix data-driven: add a 4th mode = add a neutral ramp + a mode map; add a 4th accent = add one ramp. The combinatorics collapse from "9 palettes" to "3 maps + N accent ramps".

---

## 3. Contrast threshold upgrade plan (requirement 2)

Goal: stronger than bare AA where it matters — clearer surface separation, more visible borders, sharper text hierarchy, AAA for primary body text. All changes are to the **contract in `contrast.ts`** (proposed for the approved pass; not edited now). Mapping each change to the current code:

### 3a. Text hierarchy — split the `text` family by role
Today `buildPairs()` emits one `text` family at 4.5 for `fg`/`fg-dim`/`fg-faint` on all 3 surfaces. Proposed split:
| new family | maps from | current | **proposed** | why |
|---|---|---|---|---|
| `text-primary` | `fg`/`text-primary` | 4.5 | **AAA 7.0** | primary body legibility (the key body pairs the user named) |
| `text-secondary` | `fg-dim`/`text-secondary` | 4.5 | **AA 4.5, design target ≥5.5** | a clear, perceptible step below primary |
| `text-muted` | `fg-faint`/`text-muted` | 4.5 | **AA 4.5** (floor) | muted yet legible; must stay *below* secondary to preserve hierarchy |
| `text-disabled` | `fg-faint`(disabled) | 3.0 | **3.0** (unchanged) | usability floor |

(Note: status-text/tinted-text/syntax stay **AA 4.5** — pushing colored text to 7:1 forces near-black/near-white and destroys hue identity; documented as a deliberate non-upgrade.)

### 3b. Borders — split `border` into structural vs interactive, add a stronger non-text bar
Today one `border` family at 3.0 (`line-bright` on bg/bg-raise). Proposed:
| new family | current | **proposed** | why |
|---|---|---|---|
| `border` (hairline/divider, decorative) | 3.0 | **advisory / ≥1.5** (report-only) | pure dividers needn't meet 3.0; lets us keep subtle hairlines honestly |
| `border-strong` (input/control/interactive edge) | 3.0 | **UI_STRONG 4.5 (new constant)** | controls users must find/operate get a visibly stronger edge |

### 3c. Focus ring — stronger than the WCAG floor
| family | current | **proposed** | why |
|---|---|---|---|
| `focus` | 3.0 | **UI_STRONG 4.5 (new constant)** | the focus ring is a primary a11y affordance; 3.0 is the bare minimum |

### 3d. NEW family — surface separation (today unmeasured)
Surface↔surface contrast is **not** in the contract today (AUDIT_PAIRS only checks fg-on-bg). The user wants stronger surface/raised/sunken separation, so:
| NEW family | pairs | **proposed metric** | why |
|---|---|---|---|
| `surface-step` | (raised vs surface), (sunken vs surface), (raised vs sunken) | house rule: **contrast ratio ≥ 1.2** (≈ a perceptible ΔL); report-only at first, then gate | makes the 3 surfaces distinguishable without relying on borders alone |

(Open question for prdmgr: gate `surface-step` hard, or keep advisory/report-only? Recommend report-only for one release, then promote — same path the disabled floor took.)

### 3e. New constants / shape changes in `contrast.ts` (for the approved pass)
- Add `export const UI_STRONG = 4.5;` (used by `border-strong`, `focus`).
- Extend `type Family` with `text-primary | text-secondary | text-muted | border-strong | surface-step` (and retire the umbrella `text`/`border`); update `FAMILY_THRESHOLD` accordingly.
- `buildPairs()` rebuild: emit the split text families, the split borders, the focus-at-4.5, and the new `surface-step` pairs; mark `border`(hairline)/`surface-step` `advisory:true` initially.
- `evalPair` logic is **unchanged** (already threshold-by-family + advisory-aware). `contrast.test.ts` + `a11y-audit.ts` auto-follow because they enumerate `AUDIT_PAIRS`.

**Net:** primary body text → AAA; borders & focus more visible; surfaces measured for the first time; colored text stays AA by design. Exact ratios proven in the approved pass's contrast report (§5).

---

## 4. Migration implications

### Step 2 component docs (`../components/`)
All reference v1 token names. Proposed **old→new semantic map** to apply in the v2 pass:
| v1 (19-key) | v2 semantic |
|---|---|
| `bg` / `bg-raise` / `bg-inset` | `surface` / `surface-raised` / `surface-sunken` |
| `line` / `line-bright` | `border` / `border-strong` |
| `fg` / `fg-dim` / `fg-faint` | `text-primary` / `text-secondary` / `text-muted` |
| `ok` / `warn` / `bad` / `info` | `success` / `warning` / `danger` / `info` |
| `off` | `text-muted`/`neutral` (idle) — TBD per use |
| `link` | `link` |
| `good` | `success`/`syntax-string` per use |
| `accent` | `accent` (+ `accent-strong`) |
| `focus` | `focus-ring` |
| `sel-bg` / `sel-fg` | `selected` / `text-on-selected` |
| (new) | `hover`, `active`, `disabled`(surface), `text-on-accent`, `surface-overlay` |
- Each Step 2 doc + the Step 3 `03-themed-components.md` re-annotated to semantic names (LabelChip stays data-driven/outside the contract, unchanged). Change/review logs updated; Step 1 unaffected (it doesn't name tokens).

### Theme system (`themes.ts`) & custom palette
- `THEME_KEYS` grows from 19 → the semantic set; raw scales are separate CSS (not in `THEME_KEYS`). **Back-compat shim**: `migratePalette()` gains an old-19→new-semantic mapping so a stored v1 custom palette still loads (and `link`-from-`info`-style seeding extends to the new keys). This keeps the existing sanitize-at-boundary guarantee.
- `applyPalette()` writes semantic vars; a separate one-time emit writes the raw scale vars.

### Tailwind `@theme`
- Utilities map to **semantic** vars (`--color-surface: var(--surface)`, `--color-text-primary: var(--text-primary)`, …). Raw scales optionally exposed as `--color-slate-500` etc. for rare escapes, but discouraged by convention/lint.

### Step 5 implementation
- The component library consumes semantic utilities only; a mode/accent switch rebinds the A→B map at runtime. AAA/stronger thresholds are enforced by the rebuilt `AUDIT_PAIRS` in `contrast.test.ts` (no test rewrite — they read the contract).

### Step 4 (after v2 applied)
- Re-run the cross-review: verify every component doc uses semantic names, the matrix maps cleanly, and the contrast report passes the upgraded thresholds.

---

## 5. Artifact plan (for the later APPROVED pass — not produced now)
1. **Old↔new token comparison** — a mapping table (as §4) + a side-by-side swatch board PNG (v1 19-key vs v2 raw-scales+semantic), in `$AGENT_MESH_ARTIFACTS`.
2. **Three-theme sample renderings** — the key Step 2 components (StatusListRow, PanelFrame, Button states, IssueListRow, Composer, ApprovalCard) rendered under Dark·Slate / Light·Cool / Eye-care·Warm with the accent slot shown for one accent, PNG per mode (rendered via the repo's known-good chromium, as in v1).
3. **Contrast report with AAA-upgraded pairs** — run the rebuilt `AUDIT_PAIRS` (split text, border-strong, focus@4.5, surface-step) over the v2 palettes; table of ratios + pass at the new thresholds, plus the reproduction command. Mirrors v1 `02-aa-evidence.md` but against the upgraded contract.
All PNGs to artifacts only (not committed), filenames reported.

---

## 6. Open questions for prdmgr/user (decide before the v2 pass)
1. **Scale depth**: 11 stops (50–950) vs 9 (100–900)? (recommend 11.)
2. **`surface-step`**: gate hard immediately, or report-only for one release then promote? (recommend report-only first.)
3. **`text-secondary` target**: AA 4.5 floor only, or adopt the ≥5.5 design target as a soft goal? (recommend soft goal.)
4. **Accent**: keep the slot abstract for now (Teal/Ember/Azure all pre-validated later), or pick the default accent at v2 time? (proposal designs it as a replaceable slot either way.)
5. **Raw exposure**: expose raw scales as Tailwind colors at all (escape hatch), or hard-forbid? (recommend expose-but-discourage.)

---

## Change / review log
- 2026-06-20 — created (Step 3 revision, checkpoint 1): proposal draft only — two-layer model, 11-stop scales, AAA/stronger-contrast upgrade plan mapped to the live `contrast.ts` contract, migration map, artifact plan. No final palettes/boards; no `src/web` code. Awaiting prdmgr/user approval before the v2 pass + Step 4 re-review.
