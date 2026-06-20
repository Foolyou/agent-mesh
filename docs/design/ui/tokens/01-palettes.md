# Step 3 — palette values (3 modes × 3 accents)

Concrete token values for the 9 presets. Each preset = a **base mode palette** (18 of the 19 tokens) + one **accent** value (the only intra-mode variant). All 9 pass the repo pair contract — evidence in `02-aa-evidence.md`.

Format = the same `Palette` shape consumed by `applyPalette()` / persisted by the theme system. These map 1:1 onto a future `BUILTIN_THEMES` entry per preset (`name` = `<mode>-<accent>` lowercased), or — preferred — onto a `{mode, accent}` composition that overrides only `accent`. Step 5 decides representation; values are fixed here.

## Base mode palettes (18 shared tokens; `accent` filled per accent below)

### Dark·Slate (default landing)
```
bg:          #0d1117      ok:    #3fb950      good:   #56d364
bg-raise:    #161b22      warn:  #d29922      focus:  #58a6ff
bg-inset:    #0a0e14      bad:   #f85149      sel-bg: #e6edf3
line:        #262c36      off:   #7d8590      sel-fg: #0d1117
line-bright: #7d8590      info:  #58a6ff
fg:          #e6edf3      link:  #58a6ff
fg-dim:      #c4ccd6
fg-faint:    #a4adba      accent: «per accent»
```

### Light·Cool
```
bg:          #eef3f8      ok:    #15705f      good:   #15705f
bg-raise:    #f9fbfd      warn:  #7e5600      focus:  #1f57a4
bg-inset:    #e0e8f1      bad:   #a52521      sel-bg: #15263a
line:        #c4d2e2      off:   #5d7184      sel-fg: #eef3f8
line-bright: #6c8199      info:  #1f57a4
fg:          #0e1a26      link:  #1f57a4
fg-dim:      #36495c
fg-faint:    #556a7e      accent: «per accent»
```

### Eye-care·Warm (sepia, reduced blue light)
```
bg:          #f3ead6      ok:    #196b34      good:   #196b34
bg-raise:    #fbf5e6      warn:  #7a4c00      focus:  #1f5a8a
bg-inset:    #ece0c8      bad:   #a32a1c      sel-bg: #2b2317
line:        #ddcfb0      off:   #7c6e50      sel-fg: #f3ead6
line-bright: #8a7a55      info:  #1f5a8a
fg:          #2b2317      link:  #1f5a8a
fg-dim:      #4a3f2c
fg-faint:    #6a5c41      accent: «per accent»
```

## Accent values (the only intra-mode variant)
| accent | Dark·Slate | Light·Cool | Eye-care·Warm |
|---|---|---|---|
| **Teal** | `#2dd4bf` | `#0f766e` | `#0f6f5c` |
| **Ember** | `#fb923c` | `#b8460a` | `#b04708` |
| **Azure** | `#7cc4ff` | `#0369a1` | `#1f5f8f` |

Each accent value is tuned to be **AA 4.5 as a text label on both `bg` and `bg-raise`** in its mode (so accent can be used for "thinking" labels, selected-nav text, links-as-brand, not just fills). Ratios in `02-aa-evidence.md`.

## Notes on value choices
- **Dark·Slate** is GitHub-dark-adjacent (a proven AA-tuned neutral slate) so status hues read well and the default landing feels familiar/professional, not "AI purple". `line-bright`/`off` share `#7d8590` (border + idle are the same perceptual grey — intentional).
- **Light·Cool** reuses the validated `frost` relationships (cool blue-white) with darkened status inks for AA on a light field.
- **Eye-care·Warm** lowers blue-light and overall luminance contrast for long sessions, yet every text/status pair still clears AA (warn darkened to `#7a4c00` so even the warn-on-warn-tint panel passes).
- **Selection** is the high-contrast inverted pair in every mode (≥12:1) — used for hover-fill rows and text selection.

## Change / review log
- 2026-06-20 — created (Step 3): 3 base palettes + 9 accents; values frozen against the pair contract (`02-aa-evidence.md`). Eye-care `warn` darkened `#8a5600`→`#7a4c00` to pass the warn-tinted-panel pair.
