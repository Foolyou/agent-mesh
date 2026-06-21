# Step 7.5 — mobile + global states + regression hardening (plan)

Final `/bnw` phase: make every shipped surface usable at 390px, make the global-state contracts
(404 / offline-reconnect / error-boundary) real and consistent, and lock parity with a regression
pass. Still **only `/bnw`**; old root UI untouched. Plan-only — no product code in this commit.

Grounding (main `177d374`): the `/bnw` shell (`bnw/BnwApp.tsx`) is `h-[100dvh]` with a fixed
`w-[232px]` left mesh nav, a topbar (mesh links inline), a mesh sub-nav (运行态/看板/画布), and a
🔔 with a real unread badge. It does **not** collapse at 390px and has **no bottom tabs** (flagged
across 7.4 as 7.5 scope). Per-surface offline banners + an in-app `NotFound` for unknown `/bnw`
routes already exist; there is no React error boundary. `bnw-a11y.e2e` crawls all surfaces across
the 9 mode×accent combos at **1440 only** (desktop) — mobile viewport is not yet covered.

References: mockup 01 (app-shell, incl. the C1 global mobile rules + topbar mesh control adaptivity
+ collapsed-nav behavior), mockup 13 (`data-mockup` global-states: reconnect / 401→gate / SPA-404
/ unified-error+retry / offline), `coverage/01-app-shell.md`, `coverage/13-global-states.md`,
`coverage/14-existing-capability-audit.md` (the 28-ability audit), and the C1–C5 user-review
constraints (C1 = the global mobile anti-pattern rule).

---

## Recommended slice breakdown

### 7.5-A — mobile shell + navigation
Make the shell responsive at the breakpoint (mobile = `<lg`, 390px target):
- Hide the `w-[232px]` left mesh nav on mobile; surface a **bottom tab bar** (运行态 / 看板 / 更多)
  per mockup 01. "更多" routes to the management surfaces (assistant/harness/channels/doctor/
  settings/notifications) as a list.
- Topbar mesh control adapts: inline links on desktop, a `<select>` mesh switcher on mobile
  (the C-revision rule). The mesh sub-nav folds into the bottom tabs on mobile.
- No desktop sidebars/sub-nav rendered at 390px; the active surface uses the full width.
- **Files**: `bnw/BnwApp.tsx` (responsive shell + bottom tabs + mesh select); likely a small
  `bnw/mobile-nav.tsx` for the bottom-tab + "更多" list; no router change (routes already exist).
- **Mockup/coverage**: 01-app-shell (+ its C1/adaptivity change-log).
- **Gates**: tsc · focused SSR (bottom-tab + mesh-select markup) · bnw.e2e mobile step (390px:
  bottom tabs switch Runtime↔Board, 更多 opens the management list, left nav absent) · `/bnw × 9`
  a11y **+ mobile pass** (see §mobile a11y) · server.smoke.
- **Screenshots**: shell mobile — runtime / board / 更多 (390×844).

### 7.5-B — per-surface mobile pass (C1 anti-pattern sweep)
Apply the C1 global mobile rule across every shipped `/bnw` surface (rows don't cram
title+chip+trailing-action; buttons `whitespace-nowrap`; section headers + trailing actions wrap to
their own line; desktop-only panels deferred with a note). Several surfaces already encode `lg:`
rules (doctor recovery, channels bindings/registry, harnesses rows, settings) — this is an
audit-and-close pass over the rest.
- **Files**: `bnw/{runtime,runtime-controls,board,new-mesh,assistant,doctor,harnesses,channels,
  file-viewer,settings,notifications}.tsx` (targeted responsive tweaks only).
- **Mockup/coverage**: each surface's mockup mobile variant + `coverage/0x` mobile column +
  `00-index.md` C1 rule.
- **Gates**: tsc · focused SSR (unchanged desktop markup; mobile classes additive) · bnw.e2e
  (existing mobile screenshots already cover most; add assertions where a surface had a known gap)
  · `/bnw × 9` mobile a11y · server.smoke.
- **Screenshots**: refresh every `bnw-*-mobile.png` (already produced in 7.4; re-shoot post-pass).

### 7.5-C — global states (surface 13): error boundary + offline/reconnect + 404
- Add a `/bnw` React **ErrorBoundary** wrapping the surface stage (BnwApp body) → unified error
  card + "retry" (reset boundary) + "返回首页"; a thrown render error never blanks the console.
- Verify/unify the **offline → reconnect** contract: a shell-level connection indicator already
  exists (topbar dot); confirm each surface degrades read-only + re-syncs on the next snapshot
  (deltas already do). Keep the per-surface offline banners consistent with mockup 13.
- **SPA-404**: the in-app `NotFound` for unknown `/bnw` paths exists — fold it under the same
  global-state treatment + confirm server `/bnw/*` fallback still 404s real asset misses.
- **Files**: `bnw/ErrorBoundary.tsx` (new) + `bnw/BnwApp.tsx` (wrap body); minor shell offline
  indicator if needed.
- **Mockup/coverage**: mockup 13 + `coverage/13-global-states.md`.
- **Gates**: tsc · focused SSR/unit (ErrorBoundary catches a throwing child → retry resets;
  NotFound render) · bnw.e2e (unknown `/bnw/xxx` → in-app 404; a child that throws → error card +
  retry recovers) · `/bnw × 9` a11y (404 + error-card states) desktop+mobile · server.smoke.
- **Screenshots**: 404 + error-card + offline (desktop + mobile).

### 7.5-D — final parity regression
Lock the locked parity gate without new product code (test/doc-only):
- A regression e2e/checklist mapping each of `coverage/14`'s **28 abilities** to a concrete `/bnw`
  assertion (most are already asserted across the existing bnw.e2e steps — this consolidates them
  into one explicit checklist so a regression can't silently drop one), plus a C1–C5 constraint
  check (mobile anti-pattern at 390px; approval docked; canvas edges; etc.).
- **Files**: `bnw.e2e.ts` (a consolidated "7.5-D parity audit" step) + a short
  `coverage/14` cross-map note; no `bnw/*` product changes.
- **Gates**: full `bun test` · bnw.e2e (parity step) · `/bnw × 9` a11y desktop+mobile · lint ·
  server.smoke.
- **Screenshots**: none new (consolidation).

---

## `/bnw × 9` a11y — mobile viewport coverage (§3)

Today `bnw-a11y.e2e` crawls the surface set across the 9 mode×accent combos at **1440** only.
7.5 adds a **390×844 mobile pass**: the same authed (+ anon device-auth) crawl repeated at the
mobile viewport across all 9 combos, asserting the mobile layouts (bottom-tab shell, stacked rows,
更多 list, mobile surface variants) all clear WCAG AA. Reported as two lines —
`/bnw × 9 desktop` and `/bnw × 9 mobile` (or `/bnw × 9 × {desktop,mobile}`). This roughly doubles
the a11y wall-clock; acceptable for the final hardening phase. Lands incrementally: 7.5-A adds the
mobile-shell crawl, 7.5-B/C extend it to the per-surface + global-state mobile layouts.

---

## Risks / open questions

1. **Breakpoint**: the codebase uses Tailwind `lg:` as the desktop/mobile seam in existing `/bnw`
   surfaces (doctor/channels). I'll standardize mobile = `<lg` (≥1024 desktop) for the shell too,
   matching the mockup's 390 vs 1280 frames. Confirm `lg` is the intended seam (vs `md`).
2. **Bottom-tab "更多"**: mockup 01 routes management surfaces under "更多". Confirm whether 更多 is
   a dedicated list view or a sheet/menu — I'll implement a simple full-screen list of the
   management routes unless you prefer a sheet.
3. **Mobile a11y runtime**: doubling the crawl (~2×) lengthens the a11y gate. Acceptable, or should
   mobile crawl a representative combo subset (e.g. the 3 modes × default accent) instead of all 9?
4. **ErrorBoundary scope**: wrap only the surface stage (so topbar/nav survive a surface crash) vs
   the whole shell. I recommend stage-only. Confirm.
5. **7.5-D depth**: a full e2e per ability vs a consolidated checklist step that asserts the
   already-covered abilities + flags any genuinely unasserted one. I recommend the consolidated
   step (avoids duplicating ~28 flows already exercised across 7.1–7.4 e2e).
6. **Mobile interaction gaps** (canvas drag, lightbox pinch-zoom, composer) are inherently
   touch/pointer; e2e covers layout + tap, not native gestures — flagged, not blocking.

Suggested order: 7.5-A → 7.5-B → 7.5-C → 7.5-D, one commit each, per-commit STOP + gate.
