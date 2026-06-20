# Step 3 token v2 — contrast evidence (all 9 combinations)

**v2 (supersedes v1).** Full per-pair contrast evidence for the two-layer token system (`01-palettes.md`), computed for all **9 `compose(mode, accent)` combinations** using the repo's own contrast math — so the palettes are judged by the same arithmetic the shipped gate uses.

## Method
- **Math source (read-only):** `src/web/client/contrast.ts` — `contrastRatio` (WCAG 2.1 relative-luminance ratio) and `blend` (alpha compositing for translucent tints). Imported read-only by a throwaway generator; **no `src/web` / `contrast.ts` / build change in this pass.**
- **Composition:** `compose(mode, accent)` resolves the background semantic map (mode) + the accent ramp at its per-mode stop into concrete hex (per `01-palettes.md`), then every pair is evaluated for all 9 combinations.
- **v2 upgraded thresholds** (vs the v1 contract):
  - `text-primary` → **AAA 7.0** (was AA 4.5) — ⬆ upgrade.
  - `text-secondary` → AA 4.5 **+ ≥5.5 soft target** (new soft goal).
  - `focus-ring` → **4.5** (was 3.0) — ⬆ stronger non-text.
  - `border-strong` → **4.5** — ★ new family (stronger-than-AA non-text edge).
  - `border` (hairline) → **report-only** (was a 3.0 gate) — relaxed for purely decorative dividers.
  - `surface-step` (raised/sunken vs surface) → **report-only** (new, decision 2).
  - `on-accent`, `accent-subtle-text` → AA 4.5 — ★ new pairs.
  - Everything else (`text-muted`, `text-disabled` floor, `status-text`, `tinted-text`, `status-dot`, `syntax`, `selection`, `accent-text`) → **unchanged** vs v1.
- **Reproduce:**
  ```
  bun /tmp/v2_tokens.ts        # pass/fail per combo + soft-target + tight pairs + this report (after @@@REPORT@@@)
  ```
  (Throwaway script; imports the repo contract. When v2 lands in Step 5, `contrast.ts` gains `compose()` + the split families and `a11y-audit.ts`/`contrast.test.ts` iterate the 9 — see `04-token-system-revision-proposal.md` §3f.)

## Result
**All 9 combinations pass every hard (non-report-only) pair.** `text-secondary` meets the ≥5.5 soft target in all 9. `border` (hairline) and `surface-step` are report-only and listed for transparency.

### Per-combination roll-up
| combination | hard pairs | fails |
|---|---|---|
| Dark·Slate × Signal Teal | all | 0 |
| Dark·Slate × Ember | all | 0 |
| Dark·Slate × Fleet Azure | all | 0 |
| Light·Cool × Signal Teal | all | 0 |
| Light·Cool × Ember | all | 0 |
| Light·Cool × Fleet Azure | all | 0 |
| Eye-care·Warm × Signal Teal | all | 0 |
| Eye-care·Warm × Ember | all | 0 |
| Eye-care·Warm × Fleet Azure | all | 0 |

## Per-pair evidence
Legend for **vs v1**: ⬆ = upgraded to a stronger threshold · ★ = new pair/family · ＋soft = new soft target · ↓ = relaxed to report-only · = = unchanged from v1.

### Background-axis pairs (accent-independent — 3 columns = the 3 modes)
| pair | family | threshold | vs v1 | Dark·Slate | Light·Cool | Eye-care·Warm |
|---|---|---|---|---|---|---|
| text-primary / surface | text-primary | AAA 7.0 | ⬆ AA→AAA | 16.2 | 15.75 | 12.95 |
| text-primary / raised | text-primary | AAA 7.0 | ⬆ AA→AAA | 13.87 | 16.95 | 14.24 |
| text-primary / sunken | text-primary | AAA 7.0 | ⬆ AA→AAA | 17.18 | 14.22 | 11.85 |
| text-secondary / surface | text | AA 4.5 (+5.5 soft) | ＋soft 5.5 | 11.66 | 8.31 | 8.61 |
| text-secondary / raised | text | AA 4.5 (+5.5 soft) | ＋soft 5.5 | 9.98 | 8.94 | 9.47 |
| text-secondary / sunken | text | AA 4.5 (+5.5 soft) | ＋soft 5.5 | 12.36 | 7.5 | 7.88 |
| text-muted / surface | text | AA 4.5 | = AA | 8.34 | 5.24 | 5.45 |
| text-muted / raised | text | AA 4.5 | = AA | 7.14 | 5.64 | 6 |
| text-muted / sunken | text | AA 4.5 | = AA | 8.84 | 4.73 | 4.99 |
| text-disabled / surface | disabled | 3.0 floor | = floor | 5.48 | 3.59 | 3.51 |
| text-disabled / raised | disabled | 3.0 floor | = floor | 4.69 | 3.87 | 3.86 |
| text-disabled / sunken | disabled | 3.0 floor | = floor | 5.81 | 3.24 | 3.22 |
| status-text:success / surface | status-text | AA 4.5 | = AA | 10.85 | 6.39 | 5.96 |
| status-text:success / raised | status-text | AA 4.5 | = AA | 9.29 | 6.87 | 6.55 |
| status-text:warning / surface | status-text | AA 4.5 | = AA | 11.32 | 6.35 | 5.93 |
| status-text:warning / raised | status-text | AA 4.5 | = AA | 9.69 | 6.84 | 6.52 |
| status-text:danger / surface | status-text | AA 4.5 | = AA | 6.83 | 7.44 | 6.95 |
| status-text:danger / raised | status-text | AA 4.5 | = AA | 5.85 | 8.01 | 7.64 |
| status-text:info / surface | status-text | AA 4.5 | = AA | 7.43 | 7.81 | 7.29 |
| status-text:info / raised | status-text | AA 4.5 | = AA | 6.37 | 8.41 | 8.02 |
| status-text:link / surface | status-text | AA 4.5 | = AA | 7.43 | 7.81 | 7.29 |
| status-text:link / raised | status-text | AA 4.5 | = AA | 6.37 | 8.41 | 8.02 |
| status-text:idle / surface | status-text | AA 4.5 | = AA | 7.44 | 6.77 | 6.32 |
| status-text:idle / raised | status-text | AA 4.5 | = AA | 6.37 | 7.29 | 6.95 |
| tinted:danger (12% over sunken) | tinted-text | AA 4.5 | = AA | 6.37 | 5.46 | 5.2 |
| tinted:warning (10% over sunken) | tinted-text | AA 4.5 | = AA | 10.38 | 4.95 | 4.71 |
| status-dot:success / surface | status-dot | 3.0 | = AA(non-text) | 10.85 | 6.39 | 5.96 |
| status-dot:warning / surface | status-dot | 3.0 | = AA(non-text) | 11.32 | 6.35 | 5.93 |
| status-dot:danger / surface | status-dot | 3.0 | = AA(non-text) | 6.83 | 7.44 | 6.95 |
| status-dot:info / surface | status-dot | 3.0 | = AA(non-text) | 7.43 | 7.81 | 7.29 |
| status-dot:idle / surface | status-dot | 3.0 | = AA(non-text) | 7.44 | 6.77 | 6.32 |
| syntax:keyword / sunken | syntax | AA 4.5 | = AA | 7.88 | 7.05 | 6.67 |
| syntax:string / sunken | syntax | AA 4.5 | = AA | 11.5 | 5.77 | 5.45 |
| syntax:comment / sunken | syntax | AA 4.5 | = AA | 8.84 | 4.73 | 4.99 |
| focus-ring / surface | focus | UI 4.5 | ⬆ 3.0→4.5 | 7.43 | 7.81 | 7.29 |
| focus-ring / raised | focus | UI 4.5 | ⬆ 3.0→4.5 | 6.37 | 8.41 | 8.02 |
| focus-ring / sunken | focus | UI 4.5 | ⬆ 3.0→4.5 | 7.88 | 7.05 | 6.67 |
| border-strong / surface | border-strong | UI 4.5 | ★ NEW stronger | 8.34 | 5.24 | 5.45 |
| border-strong / raised | border-strong | UI 4.5 | ★ NEW stronger | 7.14 | 5.64 | 6 |
| border (hairline) / surface | border | report-only | ↓ now report-only | 1.5 | 1.38 | 1.29 |
| border (hairline) / raised | border | report-only | ↓ now report-only | 1.29 | 1.48 | 1.42 |

### Accent-axis pairs (9 columns = mode×accent)
| pair (family, threshold, vs v1) | Dark·teal | Dark·ember | Dark·azure | Light·teal | Light·ember | Light·azure | Eye·teal | Eye·ember | Eye·azure |
|---|---|---|---|---|---|---|---|---|---|
| accent-text / surface (status-text, AA 4.5, = AA) | 10.15 | 8.35 | 8.82 | 4.9 | 4.64 | 5.32 | 4.57 | 6.11 | 4.96 |
| accent-text / raised (status-text, AA 4.5, = AA) | 8.69 | 7.15 | 7.55 | 5.28 | 4.99 | 5.72 | 5.03 | 6.72 | 5.45 |
| on-accent (text-on-fill, AA 4.5, ★ NEW) | 10.57 | 8.7 | 9.19 | 5.47 | 5.18 | 5.93 | 5.47 | 7.31 | 5.93 |
| accent-subtle-text (tinted-text, AA 4.5, ★ NEW) | 13.25 | 13.54 | 13.38 | 14.03 | 13.79 | 13.84 | 11.57 | 11.43 | 11.39 |
| selection (selection, AA 4.5, = AA) | 13.25 | 13.54 | 13.38 | 14.03 | 13.79 | 13.84 | 11.57 | 11.43 | 11.39 |

### surface-step (report-only, decision 2 — not gated)
Elevation is intentionally subtle on near-monochrome surfaces; reinforced by `border` + (future) shadow. Reported, not gated.
| step | Dark·Slate | Light·Cool | Eye-care·Warm |
|---|---|---|---|
| raised / surface | 1.17 | 1.08 | 1.1 |
| sunken / surface | 1.06 | 1.11 | 1.09 |

## Upgraded-pair summary (what changed vs v1)
- **⬆ AAA:** `text-primary` on all 3 surfaces, all 3 modes — now ≥11.85 (AAA 7.0 cleared with large headroom).
- **⬆ stronger non-text:** `focus-ring` 3.0→4.5 (now ≥6.37 everywhere).
- **★ new family:** `border-strong` 4.5 (≥5.24 everywhere) — the visible interactive edge.
- **★ new accent pairs:** `on-accent` (≥5.18) and `accent-subtle-text` (≥11.39).
- **＋soft:** `text-secondary` ≥5.5 soft target met in all 9 (min 7.5).
- **↓ relaxed:** `border` hairline now report-only (1.29–1.5) — purely decorative dividers no longer forced to 3.0.
- **= unchanged AA:** `text-muted`, `text-disabled` floor, `status-text`, `tinted-text`, `status-dot`, `syntax`, `selection`, `accent-text`.

## Tightest passing pairs (≥ need, low margin — do not push further)
| pair | combo(s) | ratio | need |
|---|---|---|---|
| text-disabled / sunken | Eye-care (all accents) | 3.22 | 3.0 |
| text-disabled / sunken | Light (all accents) | 3.24 | 3.0 |
| text-disabled / surface | Eye-care | 3.51 | 3.0 |
| accent-text / surface | Eye-care × Teal | 4.57 | 4.5 |
| accent-text / surface | Light × Ember | 4.64 | 4.5 |
| tinted:warning | Eye-care | 4.71 | 4.5 |
| text-muted / sunken · syntax:comment | Light | 4.73 | 4.5 |

(Report-only `border` hairline is below 3.0 by design and is not a tight *pass* — it is a relaxed, ungated decorative divider.)

## Change / review log
- 2026-06-20 — **v2 (supersedes v1)**: full per-pair contrast evidence for all 9 `compose(mode,accent)` combinations via the repo contrast math; every pair tagged with family + upgrade-vs-v1 (AAA / stronger / new / report-only / unchanged). All 9 pass hard gates; text-secondary ≥5.5 soft met everywhere; surface-step + hairline border reported (not gated). v1 evidence preserved in git history.
