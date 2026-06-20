# Step 3 token v2 — raw scales + semantic maps

**v2 (supersedes v1).** Two-layer model (see `04-token-system-revision-proposal.md` for the full model + `05-v2-pass-plan.md` for the pass plan). This doc gives the **raw 11-stop scales** and the **per-mode semantic maps** + **accent axis** stops. Background mode (3) × accent (3) compose at runtime → 9 combinations.

> **Verified.** All values below were composed via `compose(mode,accent)` and run through the repo's real contrast math (`contrast.ts` `contrastRatio`/`blend`) under the v2 upgraded thresholds across **all 9 combinations** — **all 9 pass the hard gates**; `text-secondary` meets the ≥5.5 soft target everywhere. Full per-pair report = `02-aa-evidence.md` (next checkpoint). Headline + tight pairs at the bottom of this doc. (Verifier: throwaway `/tmp/v2_tokens.ts`, imports the repo contract read-only; no `src/web`/`contrast.ts` change.)

## Layer A — raw 11-stop scales (50→950). Components MUST NOT reference these.

### Neutral / background ramps (one per mode)
| stop | `neutral-slate` (Dark) | `neutral-cool` (Light) | `neutral-warm` (Eye-care) |
|---|---|---|---|
| 50 | `#e9eef4` | `#f9fbfd` | `#fbf5e6` |
| 100 | `#d9e0e8` | `#eef3f8` | `#f3ead6` |
| 200 | `#c4ccd6` | `#e0e8f1` | `#ece0c8` |
| 300 | `#a4adba` | `#c4d2e2` | `#ddcfb0` |
| 400 | `#828b97` | `#93a8bf` | `#c2ad84` |
| 500 | `#5f6772` | `#6c8199` | `#8a7a55` |
| 600 | `#444c56` | `#51677e` | `#6a5c41` |
| 700 | `#2d343d` | `#36495c` | `#4a3f2c` |
| 800 | `#1b212a` | `#233547` | `#382f1f` |
| 900 | `#0e1117` | `#15222f` | `#2b2317` |
| 950 | `#06080c` | `#0e1a26` | `#1c160d` |

### Shared status ramps
| stop | `green` | `amber` | `red` | `blue` | `gray` (idle) |
|---|---|---|---|---|---|
| 50 | `#f0fdf4` | `#fffbeb` | `#fef2f2` | `#eff6ff` | `#f9fafb` |
| 100 | `#dcfce7` | `#fef3c7` | `#fee2e2` | `#dbeafe` | `#f3f4f6` |
| 200 | `#bbf7d0` | `#fde68a` | `#fecaca` | `#bfdbfe` | `#e5e7eb` |
| 300 | `#86efac` | `#fcd34d` | `#fca5a5` | `#93c5fd` | `#d1d5db` |
| 400 | `#4ade80` | `#fbbf24` | `#f87171` | `#60a5fa` | `#9ca3af` |
| 500 | `#22c55e` | `#f59e0b` | `#ef4444` | `#3b82f6` | `#6b7280` |
| 600 | `#16a34a` | `#d97706` | `#dc2626` | `#2563eb` | `#4b5563` |
| 700 | `#15803d` | `#b45309` | `#b91c1c` | `#1d4ed8` | `#374151` |
| 800 | `#166534` | `#92400e` | `#991b1b` | `#1e40af` | `#1f2937` |
| 900 | `#14532d` | `#78350f` | `#7f1d1d` | `#1e3a8a` | `#111827` |
| 950 | `#052e16` | `#451a03` | `#450a0a` | `#172554` | `#030712` |

### Accent ramps (one per accent; orthogonal axis, separate from background)
| stop | `signal-teal` | `ember` | `fleet-azure` |
|---|---|---|---|
| 50 | `#f0fdfa` | `#fff7ed` | `#f0f9ff` |
| 100 | `#ccfbf1` | `#ffedd5` | `#e0f2fe` |
| 200 | `#99f6e4` | `#fed7aa` | `#bae6fd` |
| 300 | `#5eead4` | `#fdba74` | `#7dd3fc` |
| 400 | `#2dd4bf` | `#fb923c` | `#38bdf8` |
| 500 | `#14b8a6` | `#f97316` | `#0ea5e9` |
| 600 | `#0d9488` | `#ea580c` | `#0284c7` |
| 700 | `#0f766e` | `#c2410c` | `#0369a1` |
| 800 | `#115e59` | `#9a3412` | `#075985` |
| 900 | `#134e4a` | `#7c2d12` | `#0c4a6e` |
| 950 | `#042f2e` | `#431407` | `#082f49` |

## Layer B — semantic maps (background axis). Components use ONLY these.
Each cell = `ramp-stop` → resolved hex. Status uses stop 400 in Dark, 800 in Light/Eye-care (darker for AA on light fields). `border-strong` deliberately coincides with `text-muted`'s stop (a strong, visible edge — the contrast-upgrade intent).

| semantic token | Dark·Slate | Light·Cool | Eye-care·Warm |
|---|---|---|---|
| `surface` | slate-900 `#0e1117` | cool-100 `#eef3f8` | warm-100 `#f3ead6` |
| `surface-raised` | slate-800 `#1b212a` | cool-50 `#f9fbfd` | warm-50 `#fbf5e6` |
| `surface-sunken` | slate-950 `#06080c` | cool-200 `#e0e8f1` | warm-200 `#ece0c8` |
| `border` (hairline) | slate-700 `#2d343d` | cool-300 `#c4d2e2` | warm-300 `#ddcfb0` |
| `border-strong` | slate-300 `#a4adba` | cool-600 `#51677e` | warm-600 `#6a5c41` |
| `text-primary` | slate-50 `#e9eef4` | cool-950 `#0e1a26` | warm-900 `#2b2317` |
| `text-secondary` | slate-200 `#c4ccd6` | cool-700 `#36495c` | warm-700 `#4a3f2c` |
| `text-muted` | slate-300 `#a4adba` | cool-600 `#51677e` | warm-600 `#6a5c41` |
| `text-disabled` | slate-400 `#828b97` | cool-500 `#6c8199` | warm-500 `#8a7a55` |
| `success` | green-400 `#4ade80` | green-800 `#166534` | green-800 `#166534` |
| `warning` | amber-400 `#fbbf24` | amber-800 `#92400e` | amber-800 `#92400e` |
| `danger` | red-400 `#f87171` | red-800 `#991b1b` | red-800 `#991b1b` |
| `info` / `link` | blue-400 `#60a5fa` | blue-800 `#1e40af` | blue-800 `#1e40af` |
| `idle` (neutral) | gray-400 `#9ca3af` | gray-600 `#4b5563` | gray-600 `#4b5563` |
| `focus-ring` (default neutral) | blue-400 `#60a5fa` | blue-800 `#1e40af` | blue-800 `#1e40af` |
| `syntax-keyword / -string / -comment` | blue-400 / green-400 / slate-300 | blue-800 / green-800 / cool-600 | blue-800 / green-800 / warm-600 |

## Accent axis — per-mode stops (decision 4) + resolved values
Accent tokens resolve from the **selected accent ramp**, independent of mode; only the **stop** varies per mode to hold contrast. Stops: **Dark = 400**, **Light = 700**, **Eye-care = 700** (exception: **Eye-care × Ember = 800** so accent-text passes on the cream field).

| combination | `accent` | `accent-hover` (stop−100) | `on-accent` | accent-text on raised | on-accent ratio |
|---|---|---|---|---|---|
| Dark·Slate × Signal Teal | `#2dd4bf` | `#5eead4` | `#0b0b0b` | 8.69 | 10.57 |
| Dark·Slate × Ember | `#fb923c` | `#fdba74` | `#0b0b0b` | 7.15 | 8.70 |
| Dark·Slate × Fleet Azure | `#38bdf8` | `#7dd3fc` | `#0b0b0b` | 7.55 | 9.19 |
| Light·Cool × Signal Teal | `#0f766e` | `#0d9488` | `#ffffff` | 5.28 | 5.47 |
| Light·Cool × Ember | `#c2410c` | `#ea580c` | `#ffffff` | 4.99 | 5.18 |
| Light·Cool × Fleet Azure | `#0369a1` | `#0284c7` | `#ffffff` | 5.72 | 5.93 |
| Eye-care·Warm × Signal Teal | `#0f766e` | `#0d9488` | `#ffffff` | 5.03 | 5.47 |
| Eye-care·Warm × Ember (stop 800) | `#9a3412` | `#c2410c` | `#ffffff` | 6.72 | 7.31 |
| Eye-care·Warm × Fleet Azure | `#0369a1` | `#0284c7` | `#ffffff` | 5.45 | 5.93 |

`on-accent` (a.k.a. `text-on-accent`) is auto-picked (black on the bright Dark accents, white on the darker Light/Eye-care accents) and verified ≥4.5.

## Derived / interaction tokens (formula, not per-combo enumerated)
- `accent-subtle` = `blend(accent-500, 14%, surface)` — a faint accent tint on the current surface; carries `text-primary` (verified ≥4.5 in all 9).
- `selected` (nav/row selected bg) = `accent-subtle`; `text-on-selected` = `text-primary`.
- `accent-active` = accent stop **+100** (pressed); `accent-hover` = stop **−100** (table above).
- `hover` = neutral wash `text-primary @ ~5%` over surface; `active` = `~9%`. `disabled` surface keeps the `text-disabled` label (no opacity fade — preserves the 3.0 floor).
- `surface-overlay` (scrim) = `text-primary @ ~55%` over `surface` (modal/drawer backdrop).

## Verification headline (full report → `02-aa-evidence.md`)
- **All 9 combinations pass every hard gate**: `text-primary` AAA ≥7.0; `text-secondary` ≥4.5 (and ≥5.5 soft everywhere); `text-muted` ≥4.5; `text-disabled` ≥3.0; status-text & accent-text & on-accent & tinted-text & syntax & selection ≥4.5; status-dot ≥3.0; `border-strong` & `focus-ring` ≥4.5.
- **Tightest passing pairs** (≥ need, low margin — do not lighten/darken further): `text-disabled` on sunken (Light 3.24 / Eye-care 3.22, need 3.0); `accent-text` on surface (Eye-care × Teal 4.57, Light × Ember 4.64, need 4.5); `tinted:warning` (Eye-care 4.71); `text-muted`/`syntax-comment` on sunken (Light 4.73).
- **`surface-step` (report-only, decision 2)**: raised/surface = Dark 1.17 · Light 1.08 · Eye-care 1.10; sunken/surface = Dark 1.06 · Light 1.11 · Eye-care 1.09. Elevation is intentionally subtle (near-monochrome surfaces) and is reinforced by `border` + (future) shadow; not gated, reported for transparency. Can be widened if review wants stronger elevation.

## Change / review log
- 2026-06-20 — **v2 (supersedes v1)**: replaced the single-layer 19-key palettes with two-layer raw 11-stop scales (3 neutral + 5 status + 3 accent) + per-mode semantic maps + orthogonal accent axis (per-mode stops, Eye-care×Ember=800 override). All 9 combinations verified against the repo contrast math under the upgraded thresholds (AAA primary text, border-strong/focus 4.5, accent pairs, surface-step report-only). v1 values preserved in git history. Full per-pair evidence = `02-aa-evidence.md` (next checkpoint).
