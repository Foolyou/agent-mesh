# UI redesign — Step 3 token v2 · index & model

Pipeline `ui-design-pipeline` SKILL **Step 3** (theme & token design), **v2**. Branch `task/ui-redesign-pipeline`.
Input: Step 0 ground rules (ui-redesign.md + ui-redesign-tailwind.md), Step 1 interaction docs (`../interaction/`), Step 2 component inventory (`../components/`), the existing runtime theme system (`src/web/client/themes.ts`) + WCAG math (`src/web/client/contrast.ts`), and the approved revision proposal (`04-token-system-revision-proposal.md`) + pass plan (`05-v2-pass-plan.md`).

> **Fidelity & scope.** Design-doc/artifact level: token values + AA evidence + themed component drafts. **No `src/web`, build config, or real `contrast.ts` is changed.** Contrast is *exercised* by throwaway `/tmp` scripts that import the repo contract read-only (see `02-aa-evidence.md`).

Docs in this area:
- `00-tokens.md` — **(v2)** this index: two-layer model, runtime `compose(mode,accent)`, old→new comparison, Tailwind mapping, custom-palette model.
- `01-palettes.md` — **(v2)** raw 11-stop scales + per-mode semantic maps + accent axis.
- `02-aa-evidence.md` — **(v2)** full per-pair contrast evidence for all 9 combinations.
- `03-themed-components.md` — **(v2)** Step 2 components annotated to semantic tokens.
- `04-token-system-revision-proposal.md` — approved proposal (historical).
- `05-v2-pass-plan.md` — v2 pass plan (historical).

(v1 single-layer content for `00`–`03` is preserved in git history; v2 supersedes it.)

## Two-layer token model
A theme is **not** a flat palette anymore. There are two layers:

**Layer A — raw scales** (`--raw-<family>-<stop>`, 11 stops 50→950). Pure color ramps: 3 neutral (slate/cool/warm), 5 status (green/amber/red/blue/gray), 3 accent (signal-teal/ember/fleet-azure). **Components MUST NOT reference raw scales** (lint-discouraged — decision 5). Values in `01-palettes.md`.

**Layer B — semantic tokens** (component-facing role aliases). Components use **only** these. A theme = a *mapping* from semantic tokens to raw stops; switching theme/accent or editing a custom palette changes the mapping, never the components.

Semantic token catalogue:
| group | tokens |
|---|---|
| surfaces | `surface`, `surface-raised`, `surface-sunken`, `surface-overlay` (scrim) |
| borders | `border` (hairline), `border-strong` (interactive edge) |
| text | `text-primary`, `text-secondary`, `text-muted`, `text-disabled` |
| status | `success`, `warning`, `danger`, `info`, `link`, `idle`; per fill role: `success-subtle`/`warning-subtle`/`danger-subtle`/`info-subtle` + `on-success`/`on-warning`/`on-danger`/`on-info` (mode-driven, **accent-independent**; symmetric with `accent-subtle`/`on-accent`) |
| brand (accent axis) | `accent`, `accent-hover`, `accent-active`, `accent-subtle`, `on-accent` (a.k.a. `text-on-accent`) |
| interaction | `hover`, `active`, `selected`, `text-on-selected`, `focus-ring`, `disabled` |
| syntax | `syntax-keyword`, `syntax-string`, `syntax-comment` |

## Runtime composition — `compose(mode, accent)`
Two **orthogonal runtime axes**, both user-switchable in the console, independently:
- **Background/mode axis (3):** Dark·Slate / Light·Cool / Eye-care·Warm — drives `surface*`/`text*`/`border*`/status/idle/`focus-ring`/syntax.
- **Accent axis (3):** Signal Teal / Ember / Fleet Azure — drives `accent`, `accent-hover`, `accent-active`, `accent-subtle`, `on-accent`.

→ **9 live, a11y-gated combinations.** `compose(mode, accent)` resolves the mode's semantic map + the accent ramp (at its per-mode stop) onto `:root`. Two persisted selections (`mesh.theme.mode` + `mesh.theme.accent`); switching one axis rewrites only that axis's vars. **Default landing = Dark·Slate × Signal Teal** (default only; all 3 accents are first-class). Per-pair proof: `02-aa-evidence.md`.

## Old → new token comparison (v1 19-key → v2 semantic)
| v1 (19-key) | v2 semantic | note |
|---|---|---|
| `bg` | `surface` | |
| `bg-raise` | `surface-raised` | |
| `bg-inset` | `surface-sunken` | |
| `line` | `border` | now report-only contrast (decorative hairline) |
| `line-bright` | `border-strong` | now a **stronger** (≥4.5) interactive edge |
| `fg` | `text-primary` | now **AAA 7.0** |
| `fg-dim` | `text-secondary` | AA 4.5 + ≥5.5 soft target |
| `fg-faint` | `text-muted` | AA 4.5 |
| *(opacity-faded disabled)* | `text-disabled` | now an **explicit token** (3.0 floor, no opacity fade) |
| `ok` | `success` | |
| `warn` | `warning` | |
| `bad` | `danger` | |
| `off` | `idle` | |
| `info` | `info` | |
| `link` | `link` | |
| `good` | `success` / `syntax-string` | folded into success + syntax |
| `accent` | `accent` (+ `accent-hover`/`-active`/`-subtle`, `on-accent`) | now a full accent **axis** |
| `focus` | `focus-ring` | now **≥4.5** (was 3.0) |
| `sel-bg` | `selected` | |
| `sel-fg` | `text-on-selected` | |
| *(new)* | `hover`, `active`, `surface-overlay` | explicit interaction/scrim tokens |

## Tailwind mapping (Step 0 decision: 100% Tailwind + preflight + `@theme`)
`@theme` maps **semantic** tokens to utility colors so utilities stay theme-driven; raw scales are also generated but lint-discouraged for component use (decision 5):
```css
@theme {
  /* semantic (components use these) */
  --color-surface: var(--surface);
  --color-surface-raised: var(--surface-raised);
  --color-accent: var(--accent);
  --color-on-accent: var(--on-accent);
  --color-success: var(--success);  /* …one per semantic token… */
  /* raw scales: generated for escape-hatch use, but `raw-*` utilities trigger lint
     and require an explicit disable + reason in Step-5 implementation */
  --color-raw-slate-500: var(--raw-slate-500);
}
```
Utility-naming detail (the doubled-prefix question for text/border, e.g. `text-text-primary` vs an alias like `text-fg`) is a Step-5 implementation choice; the **canonical contract is the semantic token names above**.

## Custom palette model (v2)
The custom palette stays, upgraded for two layers + two axes:
- Persistence splits into the two axis selections + an optional **custom map** override (advanced: remap semantic→raw) or a few raw-stop overrides (simple).
- **Sanitized at the boundary** (`migratePalette()` gains an old-19→new-semantic shim so stored v1 custom palettes still load; missing keys back-filled; `link` seeds from `info`).
- The ThemePicker (`../components/05-domain.md`) exposes mode + accent (independent) + an advanced editor with a **live `contrast.ts` readout per semantic pair**, evaluated against the current `compose(mode,accent)`. Built-ins are AA/AAA-guaranteed (`02`); custom palettes are the user's responsibility (readout warns sub-AA).

## Contrast posture (v2)
`text-primary` **AAA 7.0**; `text-secondary` AA 4.5 + ≥5.5 soft; `text-muted` AA 4.5; `text-disabled` 3.0 floor; `focus-ring` & `border-strong` **≥4.5** (stronger non-text); `surface-step` (raised/sunken vs surface) **report-only** (decision 2); status/tinted/syntax/accent/selection AA 4.5; status-dot 3.0; **`on-*` (filled status/accent fg) ≥4.5 resolved per mode by measured contrast; status `*-subtle` carry status-text & text-primary ≥4.5**. All 9 combinations pass the hard gates — `02-aa-evidence.md`.

## Change / review log
- 2026-06-20 — created (Step 3 v1): single-layer 19-key model.
- 2026-06-20 — Step 4 cross-review (`../04-cross-review.md`): label colors data-driven/outside contract.
- 2026-06-20 — **v2 (supersedes v1)**: rewrote the index/model for the two-layer system (raw 11-stop scales + semantic tokens), runtime `compose(mode,accent)` over two orthogonal axes (9 combos), old→new comparison, Tailwind semantic mapping (raw lint-discouraged), v2 custom-palette model, and the upgraded contrast posture. Values → `01`, evidence → `02`, themed drafts → `03`.
- 2026-06-20 — **v2.1 status tokens**: added `*-subtle` + `on-*` for the 4 status fill roles (mode-driven, accent-independent; symmetric with `accent-subtle`/`on-accent`) to the catalogue + contrast posture. `on-*` resolved per mode by measured contrast.
