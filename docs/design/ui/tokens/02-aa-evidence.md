# Step 3 — WCAG AA evidence

All ratios below are computed with the **repo's own contrast contract** — not a separate calculator — so the Step 3 palettes are judged by exactly the pairs the real UI paints and the thresholds the gate enforces.

## Method
- Source of truth: `src/web/client/contrast.ts` — `AUDIT_PAIRS` (the enumerated (fg,bg) pairs the UI actually renders, incl. `color-mix` status tints resolved via `resolveColor`/`blend`), `evalPair` (ratio + per-family threshold), `FAMILY_THRESHOLD`, `contrastRatio`.
- Thresholds (WCAG 2.1): text/status-text/selection/syntax/tinted-text = **AA 4.5**; status-dot/focus/border = **non-text 3.0**; `disabled` = hard **3.0** usability floor (prdmgr requirement; WCAG technically exempts disabled).
- Each of the 9 palettes (mode base + accent) is run through **all 47 pairs**. A palette "passes" iff every non-advisory pair ≥ its threshold. (0 pairs are advisory in the current contract, so all 47 are hard gates.)
- Reproduce: a throwaway generator at `/tmp/step3_evidence.ts` (NOT committed) imports the contract from the worktree and emits the tables below:
  ```
  bun /tmp/step3_evidence.ts        # full evidence
  bun /tmp/step3_tokens.ts          # pass/fail summary + accent ratios
  ```
  (When these palettes land as `BUILTIN_THEMES` in Step 5, the existing `bun run src/web/a11y-audit.ts` + `contrast.test.ts` gate them with no test changes — they already enumerate `AUDIT_PAIRS`.)

## Result
**All 9 palettes pass every non-advisory pair (47/47 each, 0 failures).**

### Full-contract roll-up
| mode | accent | pairs | fails |
|---|---|---|---|
| Dark·Slate | Teal | 47 | 0 |
| Dark·Slate | Ember | 47 | 0 |
| Dark·Slate | Azure | 47 | 0 |
| Light·Cool | Teal | 47 | 0 |
| Light·Cool | Ember | 47 | 0 |
| Light·Cool | Azure | 47 | 0 |
| Eye-care·Warm | Teal | 47 | 0 |
| Eye-care·Warm | Ember | 47 | 0 |
| Eye-care·Warm | Azure | 47 | 0 |

### Per-family worst-case ratio (non-advisory pairs), per base mode
Each cell = the **lowest** ratio among all pairs of that family in the mode (accent handled separately below). All ≥ the threshold in ().

| family (need) | Dark·Slate | Light·Cool | Eye-care·Warm |
|---|---|---|---|
| text (4.5) | 7.63 | 4.53 | 4.99 |
| selection (4.5) | 16.02 | 13.73 | 12.95 |
| status-text (4.5) | 5.16 | 4.83 | 5.03 |
| tinted-text (4.5) | 5.15 | 4.59 | 4.60 |
| status-dot (3.0) | 5.07 | 4.52 | 4.18 |
| syntax (4.5) | 5.77 | 4.83 | 5.03 |
| focus (3.0) | 6.85 | 5.74 | 5.56 |
| border (3.0) | 4.64 | 3.59 | 3.51 |
| disabled (3.0) | 7.63 | 4.53 | 4.99 |

(The tightest margins are `border` on light modes — `line-bright` at 3.51–3.59 vs the 3.0 non-text floor — and `tinted-text` at ~4.6 vs 4.5; both clear AA with headroom but should not be lightened further.)

### Accent token — AA as text on base & raised surfaces
Accent varies per mode×accent; each is AA 4.5 as a label on `bg` and `bg-raise`.

| mode | accent | hex | on bg | on bg-raise | AA |
|---|---|---|---|---|---|
| Dark·Slate | Teal | `#2dd4bf` | 10.17 | 9.29 | ✅ |
| Dark·Slate | Ember | `#fb923c` | 8.36 | 7.64 | ✅ |
| Dark·Slate | Azure | `#7cc4ff` | 10.09 | 9.22 | ✅ |
| Light·Cool | Teal | `#0f766e` | 4.90 | 5.28 | ✅ |
| Light·Cool | Ember | `#b8460a` | 4.80 | 5.17 | ✅ |
| Light·Cool | Azure | `#0369a1` | 5.32 | 5.72 | ✅ |
| Eye-care·Warm | Teal | `#0f6f5c` | 5.09 | 5.60 | ✅ |
| Eye-care·Warm | Ember | `#b04708` | 4.68 | 5.15 | ✅ |
| Eye-care·Warm | Azure | `#1f5f8f` | 5.68 | 6.24 | ✅ |

## What the contract covers (so "AA" is meaningful, not cherry-picked)
The 47 pairs/palette include: primary/secondary/tertiary text on all 3 surfaces; status hues (ok/warn/bad/info/link) as **readable text** on all 3 surfaces; status hues on their **own translucent tints** (bad/warn `color-mix` panels); status hues as **dots/borders** (non-text); syntax tokens on the code surface; the **focus ring** on all 3 surfaces; the **accent "thinking" label** on base + raised; control **borders** (`line-bright`); the **inverted selection** pair; the **hover-wash** secondary text; and **disabled** control text on all 3 surfaces. This is the same enumeration the shipped a11y gate uses, so a green here = a green in `contrast.test.ts`.

## Change / review log
- 2026-06-20 — created (Step 3): evidence generated from the repo pair contract; all 9 palettes 47/47. Tightest margins (light-mode border ~3.5, tinted-text ~4.6) noted as do-not-lighten.
