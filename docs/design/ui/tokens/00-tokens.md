# UI redesign — Step 3 theme & token design · index

Pipeline `ui-design-pipeline` SKILL **Step 3** (theme & token design). Branch `task/ui-redesign-pipeline`.
Input: Step 0 ground rules (ui-redesign.md + ui-redesign-tailwind.md), Step 1 interaction docs (`../interaction/`), Step 2 component inventory (`../components/`), and the **existing** runtime theme system (`src/web/client/themes.ts`) + WCAG math (`src/web/client/contrast.ts`).

> **Fidelity & scope.** Step 3 is design-doc/artifact level: token values + themed component drafts + AA evidence. **No `src/web` functional code is changed.** The only code touched is a throwaway evidence/board generator under `/tmp` (not in the repo) that imports the repo's real contrast contract to compute ratios — see `02-aa-evidence.md`.

Docs in this area:
- `00-tokens.md` — this index: token model, role catalogue, mode×accent matrix, Tailwind mapping, custom-palette model.
- `01-palettes.md` — the concrete values: 3 base mode palettes (19 tokens each) + 9 accent values; full token tables.
- `02-aa-evidence.md` — WCAG AA evidence computed via the repo pair contract (`AUDIT_PAIRS`/`evalPair`), with the reproduction command.
- `03-themed-components.md` — Step 2 components rendered under the tokens (role-annotated drafts), per-mode notes.

## Token model (unchanged contract — we design *values*, not new keys)
A "theme" is a **palette of 19 runtime CSS custom properties** (`THEME_KEYS` in `themes.ts`). `applyPalette()` writes `--<key>` on `:root`; switching theme just rewrites those vars (no rebuild, no reflow of class names). Step 3 supplies *values* for the new 3×3 matrix — it does **not** add or rename tokens (keeping the existing `contrast.ts` pair contract valid as-is).

Tailwind v4 (Step 0 decision: 100% Tailwind + preflight + `@theme`) maps **semantic utility names to these vars**, so utilities stay theme-driven:
```css
@theme {
  --color-bg: var(--bg);
  --color-bg-raise: var(--bg-raise);
  --color-fg: var(--fg);
  --color-fg-dim: var(--fg-dim);
  --color-accent: var(--accent);
  --color-ok: var(--ok);   /* …one mapping per THEME_KEY… */
}
```
`bg-bg-raise`, `text-fg-dim`, `border-line`, `text-accent`, etc. all resolve through the runtime var, so a theme swap recolors every utility instantly. (Step 5 wires this; Step 3 only specifies the values + mappings.)

## The 19 token roles (source: `THEME_KEYS`)
| token | role |
|---|---|
| `bg` / `bg-raise` / `bg-inset` | base surface / raised panel/card / inset (code, wells) |
| `line` / `line-bright` | hairline divider / perceivable control border (≥3:1) |
| `fg` / `fg-dim` / `fg-faint` | primary / secondary / tertiary text (all AA 4.5 on every surface) |
| `ok` / `warn` / `bad` / `off` | status: ready·good / attention / error·blocked / idle·neutral |
| `info` / `link` / `good` | informational hue / hyperlink (own token, defaults to info) / syntax-string·success |
| `accent` | brand / "thinking·compacting" / selected-nav — **the only intra-mode variant** |
| `focus` | focus ring (≥3:1 on every surface) |
| `sel-bg` / `sel-fg` | inverted selection / hover-fill surface + its text |

Status semantics map to the Step 1 status vocabulary (`00-index.md`): ready→`ok`, working→`accent`/`info`, blocked·error→`bad`, attention→`warn`, idle→`off`, done→`ok`/`good`.

## Theme matrix — 3 modes × 3 accents (+ custom)
**Modes** (each a full base palette; surfaces/text/status/lines/selection):
- **Dark·Slate** — neutral cool-grey dark, the default landing theme.
- **Light·Cool** — crisp blue-white light.
- **Eye-care·Warm** — warm sepia, reduced blue light, gentler luminance — still full AA.

**Accents** (the single token that varies within a mode): **Teal · Ember · Azure.**
This yields **9 presets**; values in `01-palettes.md`, AA proof in `02-aa-evidence.md`.

> **Accent/status hue note.** `Azure` accent is blue-family and `info`/`link`/`focus` are also blue. They never collide in *meaning* because accent paints brand/selection/"thinking" surfaces while `info` paints status text/dots — distinct contexts — but a theme author picking Azure should keep selected-nav vs info-status visually distinguishable by *weight/placement*, not hue alone. Teal and Ember have no status-hue overlap (Teal is its own family; Ember is warmer/redder than `warn` amber and is used only as brand, never as a status word). Flagged for the gate; not a blocker.

## Custom palette model (unchanged)
The existing **custom palette** stays: a full 19-key user-editable palette, persisted in `localStorage`, **sanitized at the boundary** by `migratePalette()` (every value kept only if valid hex, else falls back to the default preset; missing keys back-filled; `link` seeds from `info`). The ThemePicker (Step 2 `05-domain.md`) exposes mode×accent presets + an advanced custom editor. Custom palettes are **not** AA-guaranteed (user's choice); the 9 built-ins are (this step). The editor should surface a live contrast readout reusing `contrast.ts` so a user editing a custom palette sees AA pass/fail per role (recommended for Step 5; design-noted here).

## Change / review log
- 2026-06-20 — created (Step 3): token model + 3×3 matrix specified; values in `01`, AA evidence in `02`, themed component drafts in `03`. No `src/web` code changed; tokens reuse the existing 19-key contract so `contrast.ts` audits the new palettes unmodified.
- 2026-06-20 — Step 4 cross-review (`../04-cross-review.md`): confirmed token contract consistent with Steps 1–2 (19-key, accent axis, status→token mapping). **No token value changes.** Clarified that **LabelChip colors are data-driven and OUTSIDE the 19-key contract** (Step-5), aligning `01`/`03` with `../components/06-board.md`.
