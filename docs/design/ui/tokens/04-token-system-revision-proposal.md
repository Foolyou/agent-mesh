# Step 3 token-system revision — PROPOSAL DRAFT (checkpoint 1)

**Status: proposal for prdmgr/user approval. Nothing here is final.** This is the *first checkpoint* of a Step-3 rework requested 2026-06-20: it proposes the **naming model + scale plan + contrast-threshold-upgrade plan + migration + artifact plan**. It does **not** ship final palettes, final sample boards, or any `src/web`/build code. Illustrative values below are explicitly marked **(non-final, illustrative)**. After approval, a second pass applies the full v2 token docs/palettes/artifacts, then Step 4 consistency is re-run.

Supersedes (on approval) the v1 single-layer model in `00`–`03`. We are still inside `ui-design-pipeline` Step 3; Step 5 remains blocked.

**Incorporates the 2026-06-20 accent-axis correction:** accent is an **orthogonal runtime axis**, not a build-time "pick-one slot". Background mode (3) and accent (3) are two independent, runtime-switchable axes; all **9 combinations** are first-class and a11y-gated (see §2 + §3f).

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
- **3 accent ramps**: `signal-teal`, `ember`, `fleet-azure` — each a full 11-stop ramp, **separate from the background ramps** and never referenced by background semantic tokens. The accent is its own **orthogonal runtime axis** (§2).

Raw layer lives as CSS custom properties too (`--raw-slate-500: #…`) but is **not** in the component-facing contract; lint/convention forbids `text-raw-*`/`bg-raw-*` utilities.

### Layer B — Semantic tokens (component-facing role aliases). *Components use ONLY these.*
Each semantic token is an **alias that maps to a raw stop**; a theme = a mapping, a custom palette = an overridden mapping. Proposed semantic set (covers every role the user listed + the v1 19):

| group | semantic token(s) |
|---|---|
| surfaces | `surface`, `surface-raised`, `surface-sunken`, `surface-overlay` (scrim) |
| borders | `border` (divider/hairline), `border-strong` (control/interactive edge) |
| text | `text-primary`, `text-secondary`, `text-muted`, `text-disabled`, `text-on-accent`, `text-on-selected`, `link` |
| status | `success`, `warning`, `danger`, `info` (+ `success-strong`/etc. only if needed for tints) |
| brand (accent axis) | `accent`, `accent-hover`, `accent-active`, `accent-subtle`, `on-accent` |
| syntax | `syntax-keyword`, `syntax-string`, `syntax-comment` (or keep mapping to status/info+good+muted) |
| interaction states | `hover` (surface wash), `active` (pressed wash), `focus-ring`, `selected` (bg) + `text-on-selected`, `disabled` (surface), plus role state variants `accent-hover`, `accent-active` |

Interaction-state modeling (recommended): a small set of **state overlay tokens** (`hover`, `active` as translucent washes over the current surface; `selected` as a fill; `focus-ring` as a ring color; `disabled` as the muted surface) **plus** per-role variants only where a fill changes (`accent-hover`, `accent-active`). This avoids a combinatorial explosion (every role × every state) while still being explicit for the common buttons/nav cases.

**Rule:** component docs (Step 2) and themed drafts (Step 3) reference semantic names only; theme/custom changes alter the A→B mapping, never the components.

---

## 2. Two orthogonal runtime axes → 9 live combinations (requirements 1 & 3)

The theme model is **two independent, runtime-switchable axes**; all 9 combinations are first-class:
- **Background/mode axis (3):** Dark·Slate / Light·Cool / Eye-care·Warm — drives `surface*`, `text*`, `border*`, status stops, neutral ramp.
- **Accent axis (3):** Signal Teal / Ember / Fleet Azure — drives `accent`, `accent-hover`, `accent-active`, `accent-subtle`, `on-accent` (and `focus-ring` if accent-derived).

The axes are **orthogonal**: the user picks one mode **and** one accent in the console, independently → **9 live combinations**. **No accent is ever baked into a background theme.**

### Raw layer keeps the axes separate
- **Background raw ramps** (mode-defining): `neutral-slate`, `neutral-cool`, `neutral-warm` + shared status ramps (`green/amber/red/blue/gray`). Each a complete 11-stop scale.
- **Accent raw ramps** (one per accent, complete 11-stop scale each): `signal-teal`, `ember`, `fleet-azure`. Separate from background ramps; background semantic tokens never reference them and vice-versa.

### Semantic resolution = compose(mode, accent)
A live theme is composed from **two independent selections**:
- background semantic tokens (`surface*`/`text*`/`border*`/`success`/`warning`/`danger`/`info`) ← selected **mode** map.
- accent semantic tokens (`accent`, `accent-hover`, `accent-active`, `accent-subtle`, `on-accent`, optionally `focus-ring`) ← selected **accent** ramp, **independent of mode**.

The accent *ramp* is always the accent's own; only the *stop* may differ per mode to hold contrast (a darker teal on light modes, a brighter teal on dark). (non-final, illustrative) Dark·Slate background: `surface=slate-950`, `surface-raised=slate-900`, `surface-sunken=slate-975/black`, `border=slate-800`, `border-strong=slate-600`, `text-primary=slate-50`, `text-secondary=slate-300`, `text-muted=slate-400` (Light·Cool inverts; Eye-care·Warm gentler). Accent (any mode): `accent → signal-teal-{400@dark | 700@light}`, `accent-hover → ±1 stop`, `accent-subtle → signal-teal-{900@dark | 100@light} or a translucent tint`, `on-accent → contrast-correct text on the accent fill`.

### 9-state matrix
|  | **Signal Teal** | **Ember** | **Fleet Azure** |
|---|---|---|---|
| **Dark·Slate** | slate bg + teal accent | slate bg + ember accent | slate bg + azure accent |
| **Light·Cool** | cool bg + teal accent | cool bg + ember accent | cool bg + azure accent |
| **Eye-care·Warm** | warm bg + teal accent | warm bg + ember accent | warm bg + azure accent |

All 9 are runtime-selectable and **all 9 are a11y-gated** (§3 / §3f).

### Runtime accent switching
Two independent persisted selections (e.g. `mesh.theme.mode` + `mesh.theme.accent` in localStorage). `applyPalette()` composes both onto `:root`:
- Switching **accent** rebinds only `accent-*` / `on-accent` (/ `focus-ring`) vars → instant; background unchanged.
- Switching **mode** rebinds background/text/border/status vars → instant; accent unchanged.
- **Custom palette** can override either axis's map (advanced) or individual raw stops (simple); the editor shows a live `contrast.ts` readout per semantic pair, evaluated against the **current** mode+accent composition.

Implementation note: "3 mode maps × 3 accent ramps, composed at runtime = 9 live combos" — **not** 9 hand-authored palettes, but (unlike the earlier, incorrect "pick-one slot" framing) all 9 are real runtime states and all 9 are validated. Data-driven: a 4th mode = +1 neutral ramp + map; a 4th accent = +1 accent ramp → the new row/column is gated automatically.

---

## 3. Contrast threshold upgrade plan (requirement 2)

Goal: stronger than bare AA where it matters — clearer surface separation, more visible borders, sharper text hierarchy, AAA for primary body text. All changes are to the **contract in `contrast.ts`** (proposed for the approved pass; not edited now). Mapping each change to the current code:

**All thresholds below are gated across all 9 mode×accent combinations (§3f), not a single palette.** Every accent-related pair must pass in every background mode, and the AAA-upgraded text pairs must pass under all 9 compositions.

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

### 3f. Gate ALL 9 combinations (accent-axis parameterization of the contract)
Today `evalPair(pair, palette)` takes a **single** `Palette` and `AUDIT_PAIRS` is built once; the v1 evidence ran it per palette manually. To gate the orthogonal model:
- Add a **composition helper** `compose(mode, accent) → Palette` (the mode's semantic map + the accent ramp resolved into accent tokens). `Palette` / `ColorSpec` / `resolveColor` / `evalPair` shapes are **unchanged** — we just feed 9 composed palettes.
- Run **`AUDIT_PAIRS` × 9 composed palettes** (a small `for mode × for accent` loop in `a11y-audit.ts` / `contrast.test.ts`); a combination passes iff every non-advisory pair passes. No rewrite of the pair builder's core, just iterate the compositions.
- **Add explicit accent pairs** to `buildPairs()` (or a parallel accent-pair set), so accent is gated in every mode:
  - `on-accent` — text on the accent fill (button / selected nav) → **AA 4.5** (text-on-colored-surface).
  - `accent-text` — accent as a label/word on `surface` / `surface-raised` → **AA 4.5** (generalizes today's `status-text:accent/bg(-raise)` rows).
  - `accent-subtle-text` — text on the translucent `accent-subtle` tint → **AA 4.5** (tinted-text family, like the existing bad/warn tints).
  - if `focus-ring` is accent-derived: the `focus` family (proposed **4.5**, §3c) must hold for **every accent in every mode**.
- `FAMILY_THRESHOLD` gains the accent families above, all **AA 4.5** — accent text/fills are colored, so AAA would wash the hue (same rationale as status text). `evalPair`'s logic is **unchanged**.
- **AAA-upgraded text (§3a)** is background-driven (mode-dependent, accent-independent), but the gate still verifies it under each of the 9 compositions — cheap, and future-proofs against any accent-tinted text surface.

**Net:** primary body text → AAA; borders & focus more visible; surfaces measured for the first time; colored text (incl. accent) stays AA by design; **and the whole contract is evaluated across all 9 mode×accent combinations**. Exact ratios proven in the approved pass's contrast report (§5).

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
| `accent` | `accent` (+ `accent-hover` / `accent-active` / `accent-subtle` / `on-accent`) — **accent axis** |
| `focus` | `focus-ring` (neutral, or accent-derived → then gated per accent×mode) |
| `sel-bg` / `sel-fg` | `selected` / `text-on-selected` |
| (new) | `hover`, `active`, `disabled`(surface), `surface-overlay` |
- Each Step 2 doc + the Step 3 `03-themed-components.md` re-annotated to semantic names (LabelChip stays data-driven/outside the contract, unchanged). Change/review logs updated; Step 1 unaffected (it doesn't name tokens).

### Theme system (`themes.ts`) & custom palette
- **Two independent persisted selections** replace the single active-theme key: `mesh.theme.mode` (Dark·Slate / Light·Cool / Eye-care·Warm) + `mesh.theme.accent` (Signal Teal / Ember / Fleet Azure). `loadActive()`/`saveActive()` split into per-axis load/save; a one-time migration maps any stored v1 single theme to a `{mode, accent}` pair.
- `THEME_KEYS` grows from 19 → the semantic set; raw scales (background + accent) are separate CSS (not in `THEME_KEYS`). **Back-compat shim**: `migratePalette()` gains an old-19→new-semantic mapping so a stored v1 custom palette still loads (and `link`-from-`info`-style seeding extends to the new keys). This keeps the existing sanitize-at-boundary guarantee.
- `applyPalette()` becomes `compose(mode, accent)` then writes semantic vars; a separate one-time emit writes the raw scale vars. Switching one axis rewrites only that axis's vars.

### Tailwind `@theme`
- Utilities map to **semantic** vars (`--color-surface: var(--surface)`, `--color-text-primary: var(--text-primary)`, …). Raw scales optionally exposed as `--color-slate-500` etc. for rare escapes, but discouraged by convention/lint.

### Step 5 implementation
- The component library consumes semantic utilities only; a mode/accent switch rebinds the A→B map at runtime. AAA/stronger thresholds are enforced by the rebuilt `AUDIT_PAIRS` in `contrast.test.ts` (no test rewrite — they read the contract).

### Step 4 (after v2 applied)
- Re-run the cross-review: verify every component doc uses semantic names, the matrix maps cleanly, and the contrast report passes the upgraded thresholds.

---

## 5. Artifact plan (for the later APPROVED pass — not produced now)
1. **Old↔new token comparison** — a mapping table (as §4) + a side-by-side swatch board PNG (v1 19-key vs v2 raw-scales+semantic), in `$AGENT_MESH_ARTIFACTS`.
2. **Sample renderings across the axes** — the key Step 2 components (StatusListRow, PanelFrame, Button states, IssueListRow, Composer, ApprovalCard) rendered for the **3 background modes**, each shown with **all 3 accents** (a 3×3 board, or 3 mode boards with an accent strip), demonstrating runtime accent switching (rendered via the repo's known-good chromium, as in v1).
3. **Contrast report with AAA-upgraded pairs, all 9 combinations** — run the rebuilt `AUDIT_PAIRS` (split text, border-strong, focus@4.5, surface-step + accent pairs) over the **9 `compose(mode,accent)` palettes**; table of ratios + pass at the new thresholds per combination, plus the reproduction command. Mirrors v1 `02-aa-evidence.md` but against the upgraded contract and the full 9-state matrix.
All PNGs to artifacts only (not committed), filenames reported.

---

## 6. Open questions for prdmgr/user (decide before the v2 pass)
1. **Scale depth**: 11 stops (50–950) vs 9 (100–900)? (recommend 11.)
2. **`surface-step`**: gate hard immediately, or report-only for one release then promote? (recommend report-only first.)
3. **`text-secondary` target**: AA 4.5 floor only, or adopt the ≥5.5 design target as a soft goal? (recommend soft goal.)
4. **Accent stop-per-mode**: allow each accent to pick a different *stop* per background mode to hold contrast (recommended — e.g. brighter teal on dark, darker teal on light), or force one fixed stop per accent across modes? (recommend per-mode stop.) — *(accent axis itself is settled: orthogonal, all 3 retained, 9 live combos; only the default landing combo needs picking — recommend Dark·Slate × Signal Teal, the v1 default.)*
5. **Raw exposure**: expose raw scales as Tailwind colors at all (escape hatch), or hard-forbid? (recommend expose-but-discourage.)

---

## Change / review log
- 2026-06-20 — created (Step 3 revision, checkpoint 1): proposal draft only — two-layer model, 11-stop scales, AAA/stronger-contrast upgrade plan mapped to the live `contrast.ts` contract, migration map, artifact plan. No final palettes/boards; no `src/web` code. Awaiting prdmgr/user approval before the v2 pass + Step 4 re-review.
- 2026-06-20 — accent-axis correction (prdmgr/user): accent is an **orthogonal runtime axis**, not a pick-one slot. Reworked §1 (accent semantic group: accent/-hover/-active/-subtle/on-accent), §2 (two orthogonal axes + 9-state matrix + runtime accent switching + separate accent raw ramps), §3 (+§3f: gate all 9 compositions, accent pairs, `compose(mode,accent)` helper — `evalPair`/`Palette` shapes unchanged), §4 (two-axis persistence + accent token map), §5 (9-combo artifacts), §6 (accent settled; stop-per-mode open Q).
