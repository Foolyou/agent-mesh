# Design: briefing-reliability

Status: DESIGN (no implementation yet — gated on reviewer + prdmgr approval)
Branch: `task/briefing-reliability` (based on `main` @ 247a774)
Scope source: merges audits `briefing-persistence-audit` (#373) and `compact-signal-reliability` (#379).

All `file:line` references below are against the task base (`main` @ 247a774). Line numbers will
drift as edits land; each change point also names a stable anchor (function/identifier) so the
implementer can relocate it.

---

## 1. Background & goal

Two reliability gaps surfaced by the prior audits:

- **Empty-content hallucination.** `buildMeshBriefing()` *silently omits* the charter and
  role-instruction sections when the config lacks them (`src/mesh-briefing.ts:127-138`). An agent
  asked "what is your charter / team setup" then has no grounded signal that the field is simply
  *undefined*, and may confabulate one.
- **No post-compaction rebrief.** The briefing is injected exactly once on the first prompt
  (`compose()`, `src/control-plane.ts:791-799`); after a `/compact` the harness may drop it from
  its summarized history, and nothing re-injects it. The only completion signal
  (`compact_completed`, emitted in `runCompact()` `src/control-plane.ts:432`) currently fires on
  *any* prompt resolution, including `cancelled`/`superseded`, so it cannot be trusted as a rebrief
  trigger as-is.

Goal: land two independent improvements —
**A. grounding** (kill empty-content hallucination) and
**B. post-compact auto-rebrief** (reliable trigger + lazy re-injection) —
without changing the fresh-session first-briefing behavior and without a hard validation break.

---

## 2. Part A — anti-hallucination grounding

### A1. Explicit "not defined" sections in `buildMeshBriefing()`

**File:** `src/mesh-briefing.ts`
**Anchor:** the `const charter = mesh.charter; if (charter) { … }` block (`:127-132`) and the
`const instructions = me.instructions?.trim(); if (instructions) { … }` block (`:133-138`).

**Change:** replace the two silent `if (present)` blocks with always-emitted sections that state
presence *or* absence explicitly. The absence wording is **scoped strictly to the mesh
configuration** — it must NOT imply the agent has no instructions at all, since system / developer /
harness / project (CLAUDE.md / AGENTS.md) / user instructions still reach the agent through their own
channels and outrank anything here. Sketch (illustrative, not final code):

- Charter section (`:127`):
  - if `charter` present → unchanged ("Team charter — … Follow it in all your work:" + indented body).
  - if absent → emit: `Team charter — this mesh configuration has no team charter defined. There is
    no shared team charter for this mesh; do not invent one. Treat only the roster/edges/role facts
    above as the authoritative mesh setup.`
- Role-instructions section (`:133`):
  - if `instructions` present → unchanged.
  - if absent → emit: `Your role-specific instructions — this mesh configuration defines no
    per-agent role instructions for you. Continue following the system, developer, harness, project,
    and user instructions you receive through their normal channels; this mesh simply adds no extra
    private role instructions. Do not infer extra duties from the absence.`

The factual baseline already injected **stays untouched**: roster (`:74-75` — each line is
`id — harness, role; can mail: …`, `:13`), router line (`:77`). NOTE: the roster line does **not**
include each agent's `project` path (confirmed: no `project` token in `src/mesh-briefing.ts`), so we
do not claim project is conveyed by the briefing; whether to surface `project` is an open question
(§10), not part of this implementation. We only add explicit negative statements; we do **not**
remove or reorder existing fact lines.

**Why not silent omission:** an explicit "this mesh configuration has no team charter defined" line
is itself the grounding signal — the model sees the field was checked and is empty, rather than
seeing nothing and filling the gap. The wording deliberately frames the gap as a *mesh-config* fact,
not a global absence of guidance.

### A2. Identity/charter discipline line in the briefing norms

**File:** `src/mesh-briefing.ts`
**Anchor:** `buildNormsCard()` (`:22`) — the communication-norms card embedded at the end of every
briefing (`buildMeshBriefing` appends it at `:140-141`). Also reinforced near the `mesh_briefing`
tool description (`:104-106`).

**Change:** add one discipline bullet to the norms card, e.g.:

> When asked about your own identity, team/mesh setup, roster, or charter: call `mesh_briefing`
> (and `mesh_status` for live peer state) to retrieve the authoritative current configuration
> before answering. If the configuration does not specify something (e.g. no charter, no role
> instructions), answer "not specified" — do not infer or fill it in.

Placing it in `buildNormsCard()` means it rides both the first briefing **and** every
`mesh_briefing` recall (so it survives the rebrief path in Part B too).

### A3. Non-blocking warnings for missing charter / instructions

**Constraint:** `validateMeshConfig()` (`src/mesh-validate.ts:28`) is throw-only and its `void`
return is the pass/fail contract for three callers (`mesh-store.ts:24`, `diagnostics-sources.ts:60`,
`web/api.ts:314`). Missing charter/instructions is **valid** config — it must keep passing. So we do
**not** add warnings inside `validateMeshConfig`'s throw path.

**Change:** add a separate pure helper in `src/mesh-validate.ts`:

```
export function collectMeshConfigWarnings(config: MeshConfig): string[]
```

returning non-fatal notes, e.g. `mesh has no charter defined` and
`agent "<id>" has no role instructions`. It performs no throwing and does not affect validation.

**Surface it through diagnostics (doctor), the existing non-blocking channel:**
- `src/diagnostics.ts:230-233` — extend `ConfigInputs["meshes"]` entry with optional
  `warnings?: string[]`.
- `src/diagnostics-sources.ts:56-66` — after a successful `validateMeshConfig`, call
  `collectMeshConfigWarnings(parsed)` and attach to the `{ name, ok: true, warnings }` entry.
- `src/diagnostics.ts:`configChecks` (`:235-244`) — when a valid mesh carries warnings, emit a
  `check("config.meshes", "warning", …)` (severity `warning`, non-fatal) listing them; the existing
  `ok`/`error` branches are unchanged.

**Why diagnostics, not validate:** keeps the validation contract (`throw == invalid`) intact and
routes advisory notes to the doctor where `warning`/`info` severities already exist and are
non-blocking. No caller behavior changes for valid configs.

---

## 3. Part B — post-compact auto-rebrief

### B1. Trust the stop reason before declaring compaction complete

**File:** `src/control-plane.ts`
**Anchors:** `sendBarePrompt()` (`:869`, returns `Promise<void>` and discards the prompt result);
`runCompact()` (`:424-443`, the single emit site for `compact_completed` `:432` / `compact_failed`
`:434`). The ACP `prompt()` resolves with the `PromptResponse` carrying `stopReason`
(`src/acp/client.ts:321-326`); cancel/supersede resolve with `cancelled`/`superseded`
(`src/acp/client.ts:369-376`).

**Change:**
1. `sendBarePrompt` returns the stop reason instead of `void`:
   `async sendBarePrompt(...): Promise<string | undefined>` → capture
   `const res = await this.trackTurn(... conn.prompt(text, [], turn))` and `return res?.stopReason`.
   (The `.finally(finishTurnHealth)` stays.)
2. In `runCompact` (`:429-433`) gate the telemetry/flag on success:
   - `const stop = await this.sendBarePrompt(agentId, "/compact", { reason });`
   - if `stop === "end_turn"` (the harness-agnostic success token both codex/claude emit) →
     `emit compact_completed` **and** `this.markNeedsRebrief(agentId)` (B2).
   - else (`cancelled`, `superseded`, `undefined`, or any other) → emit a non-success signal
     (reuse `compact_failed` with `error: "compaction did not complete (stopReason=<x>)"`, or add a
     `compact_skipped` event — implementer's choice; **no `needsRebrief`** either way).
   - the `catch (err)` path stays `compact_failed`, no rebrief.

**Risk recorded, not done this round:** `kill()` (`src/acp/client.ts:466-471`) does not
`failActiveTurn`/reject the in-flight job, so a kill mid-`/compact` relies on transport-close to
settle the await. `failActiveTurn` already exists (`src/acp/client.ts:371`); wiring `kill()`/`onExit`
to call it is logged as a **follow-up risk** (§9), out of scope here.

### B2. Per-agent `needsRebrief` flag

**File:** `src/control-plane.ts`
**Anchor:** near the other per-agent sets, `private briefed` (`:242`), `private loadedSessions`
(`:244`).

**Change:** add `private needsRebrief = new Set<AgentId>();` plus a tiny setter
`private markNeedsRebrief(id)` that `.add`s and logs. Clear it in `clearAgentSelfAwareness()`
(`:369-377`, where compaction/usage state is already reset on stop) so a stopped/cleared agent does
not carry a stale rebrief.

### B3. Source-tagged usage-drop heuristic (usage_update only)

**File:** `src/control-plane.ts` + `src/acp/client.ts`
**Anchor:** `updateAgentUsage()` (`:349-364`); the feed from `src/acp/client.ts:144`
`onContextUsage` wired at `src/control-plane.ts:1167`.

**Critical correction (reviewer Medium #1):** `updateAgentUsage()` is **NOT** fed only from
`parseUsageUpdate`. `recordStreamState()` (`src/acp/client.ts:274-292`) calls the **same**
`onContextUsage` callback for **both** sources — `parseUsageUpdate` (`:280`) and `parseTokenCount`
(`:291`). For codex, `token_count.total_tokens` is **per-request, not cumulative context occupancy**
(`src/acp/usage-compat.ts:29-35`), so it naturally rises and falls every turn. Running the drop
heuristic on the merged stream would fire `needsRebrief` on ordinary `token_count` fluctuation —
a false-positive every turn. **Source MUST be distinguished.**

**Change (two parts):**
1. **Tag the source at the boundary.** Extend the `onContextUsage` payload with a discriminator,
   e.g. `onContextUsage?({ used, size, percent, cost?, source: "usage_update" | "token_count" })`
   (`src/acp/client.ts:144`), and set it at the two call sites in `recordStreamState`
   (`:280` → `"usage_update"`, `:291` → `"token_count"`). `updateAgentUsage()` threads `source`
   through; the existing normalize/emit/`maybeAutoCompact` behavior is unchanged for both sources.
   (Alternative considered: a dedicated `onUsageUpdate`-only callback; rejected because the
   single-callback + tag keeps the existing window-normalization in one place.)
2. **Gate the heuristic on `source === "usage_update"`.** Between reading the prior usage and the
   `.set` at `:361`, run the drop check **only** for the `usage_update` source. Sketch:

```
const prev = this.agentContextUsage.get(id);
// … existing normalize …
if (source === "usage_update" && prev && this.looksLikeCompaction(prev.used, normalized.used, normalized.size)) {
  this.markNeedsRebrief(id);   // source: usage_update drop heuristic only
}
this.agentContextUsage.set(id, normalized);
```

`looksLikeCompaction(prevUsed, newUsed, window)` returns true only when **all** hold:
- `prevUsed >= MIN_AUTO_COMPACT_CONTEXT_WINDOW * DROP_PREV_FLOOR_FRAC` — prior occupancy was large
  enough that a drop is worth acting on (filters tiny early-session jitter). This is a *permissive*
  floor, not proof the context was near the compaction threshold — see §7.
- `newUsed <= prevUsed * DROP_RATIO` — occupancy fell to a small fraction between frames;
- a short **drop cooldown** has elapsed since the last heuristic fire for this agent (a new
  `agentLastRebriefHeuristicAt` map), so a noisy multi-frame drop sets the flag once.

Add an inline comment block marking this **heuristic / harness-dependent**: it assumes the harness
emits a post-compact `usage_update` with a sharply lower `used`. If a harness only emits
`token_count` this path never fires — acceptable because B1 still covers controller-triggered
compaction, and the A2 discipline lets the agent self-recall via `mesh_briefing`.

**Threshold values (see §7 rationale):** `DROP_RATIO = 0.5`, `DROP_PREV_FLOOR_FRAC = 0.5`
(i.e. prior `used ≥ 40_000` given `MIN_AUTO_COMPACT_CONTEXT_WINDOW = 80_000`), drop cooldown
`= COMPACT_COOLDOWN_MS` (180_000) reused. All as named constants near `COMPACT_COOLDOWN_MS`
(`src/control-plane.ts:24`).

### B4. Consume `needsRebrief` at the top of `compose()`

**File:** `src/control-plane.ts`
**Anchor:** `compose()` (`:791-799`), the universal pre-send chokepoint. Confirmed it funnels every
real outbound prompt: `sendPromptWithResumeFallback` (`:1494`, `:1507`) and `drainPendingMail`
(`:1403`). `sendBarePrompt("/compact")` (`:877`) calls `conn.prompt` **directly, bypassing
compose**, so rebrief cannot pollute the `/compact` turn.

**Change:** add a consume-block as the **first** statement in `compose()`, *before* the
`loadedSessions.has` (`:792`) and `briefed.has` (`:793`) early returns:

```
private compose(id, text) {
  if (this.needsRebrief.has(id)) {
    this.needsRebrief.delete(id);
    const briefing = buildMeshBriefing(this.mesh, id);
    if (briefing) {
      this.briefed.add(id);   // keep state consistent
      return `${REBRIEF_PREFIX}\n\n${briefing}\n\n---\n\n${text}`;
    }
  }
  if (this.loadedSessions.has(id)) return text;   // unchanged
  if (this.briefed.has(id)) return text;          // unchanged
  this.briefed.add(id);
  // …unchanged first-briefing path…
}
```

`REBRIEF_PREFIX` = a one-line note like `(Context was compacted; re-injecting the authoritative mesh
briefing — this supersedes any earlier briefing you remember.)`, mirroring the wording already used
by the `mesh_briefing` tool handler (`meshBriefingText`, "authoritative over any earlier briefing
you remember"). The rebrief rides the **next real prompt** (mail wake / operator / drain) — no extra
turn is spawned.

**Drain-path ordering fix (reviewer Medium #2).** `compose()` consuming `needsRebrief` is necessary
but not sufficient: the *order* of compose vs. the pre-send compaction guard matters. The two
real-prompt paths currently differ:
- `sendPromptWithResumeFallback` (`:1476-1494`) — **correct order**: `compactBeforePrompt(id)` is
  awaited at `:1477` *before* `compose(id, text)` at `:1494`. So if the pre-send `/compact` succeeds
  and sets `needsRebrief`, the *same* prompt's `compose` consumes it → rebrief rides that prompt. ✓
- `drainPendingMail` (`:1401-1415`) — **inverted order**: it calls `compose(...)` at `:1403` *first*,
  then the pre-send guard `compactBeforePrompt(id)` runs at `:1416` inside the `send` closure. So a
  pre-send `/compact` that sets `needsRebrief` arrives *after* this drain prompt was already composed
  → the rebrief slips to the next prompt instead of this drain. ✗

**Change:** in `drainPendingMail`, move the `compose()` call to *after* `compactBeforePrompt(id)`
settles — i.e. compose the drain text **inside** the `send` closure (after the guard await and the
`conns.get(id) !== conn` supersede re-check), so it mirrors `sendPromptWithResumeFallback`'s order.
Equivalently, route the drain through the unified `sendPromptWithResumeFallback` path. Either way the
invariant is: **compose runs after the pre-send compaction guard has settled**, on every real-prompt
path, so a freshly-set `needsRebrief` always rides the very prompt that triggered the compaction.

### B5. Tests

New/extended test files (test edits are allowed only in the implementation phase, not now):
- `src/control-plane*.test.ts` (or a focused `control-plane-rebrief.test.ts`):
  1. `/compact` resolving `cancelled` → no `compact_completed`, `needsRebrief` NOT set, next prompt
     not rebriefed.
  2. `/compact` resolving `superseded` → same as (1).
  3. `/compact` resolving `end_turn` → `compact_completed` emitted, `needsRebrief` set, next real
     prompt is prefixed with a fresh briefing.
  4. Usage drop (`used` 90k→5k on a ≥80k window) via `usage_update` → `needsRebrief` set, next prompt
     rebriefed; a small/no drop does NOT set it; repeated drop frames within cooldown set it once.
  5. **`token_count`-sourced drop does NOT set `needsRebrief`** (reviewer Medium #1): feed a large
     `token_count` decrease (codex per-request style, e.g. 60k→3k) through the `"token_count"` source
     and assert the flag stays clear and no rebrief occurs.
  6. **Drain ordering** (reviewer Medium #2): an over-threshold `drainPendingMail` runs `/compact`
     first, and the *same* drain prompt is then delivered carrying the rebrief prefix (not deferred to
     the next prompt). Pair it with the analogous already-correct `sendPromptWithResumeFallback` case.
  7. An already-`loaded`/`briefed` session still rebriefs when `needsRebrief` is set (B4 runs before
     the early returns).
  8. `sendBarePrompt("/compact")` itself is never prefixed with a briefing (bypasses `compose`).
- `src/mesh-briefing.test.ts`: charter-absent → briefing contains the explicit "this mesh
  configuration has no team charter defined" line; instructions-absent → explicit "defines no
  per-agent role instructions" line; both-present → unchanged; norms card contains the A2
  identity-discipline bullet. **Absence wording assertion (reviewer Medium #3):** the
  instructions-absent line must reference "system, developer, harness, project, and user
  instructions … through their normal channels" and must NOT assert the agent has no instructions /
  must NOT negate higher-priority or project (CLAUDE.md / AGENTS.md) guidance.
- `src/mesh-validate.test.ts` (or `diagnostics*.test.ts`): `collectMeshConfigWarnings` returns notes
  for missing charter/instructions; `validateMeshConfig` still passes (no throw) for those configs;
  diagnostics emits a non-fatal `warning` check for a valid-but-charterless mesh.

---

## 4. Commit split plan

Three independent, separately-revertable commits (per reviewer Low guidance). A has zero dependency
on B; within B, **B-heuristic depends on B-core** (it reuses `markNeedsRebrief`/`needsRebrief`) but
B-core stands alone, so B-heuristic can be reverted independently while B-core stays:

- **Commit 1 — A: `feat(briefing): ground empty charter/instructions + identity discipline`**
  - `src/mesh-briefing.ts` (A1 explicit mesh-config-scoped absence sections, A2 norms bullet)
  - `src/mesh-validate.ts` (A3 `collectMeshConfigWarnings`)
  - `src/diagnostics.ts` + `src/diagnostics-sources.ts` (A3 doctor surfacing)
  - tests: `mesh-briefing.test.ts`, `mesh-validate`/`diagnostics` tests
- **Commit 2 — B-core: `feat(briefing): rebrief after controller-triggered compaction`**
  - `src/control-plane.ts` (B1 stopReason gate in `runCompact` + `sendBarePrompt` return type;
    B2 `needsRebrief` flag; B4 `compose()` consume + drain-path ordering fix)
  - `src/acp/client.ts` — only if B1 needs a typed `stopReason` surfaced (prompt already returns it;
    likely no change)
  - tests: control-plane tests for cancelled/superseded/`end_turn`, drain ordering, loaded/briefed
    rebrief, bare-`/compact` non-pollution
- **Commit 3 — B-heuristic: `feat(briefing): source-tagged usage-drop rebrief heuristic`**
  - `src/acp/client.ts` (B3 part 1: `source` tag on `onContextUsage` at `:280`/`:291`)
  - `src/control-plane.ts` (B3 part 2: `looksLikeCompaction` gated on `source === "usage_update"`,
    new threshold constants + `agentLastRebriefHeuristicAt`)
  - tests: usage_update drop sets rebrief; `token_count` drop does NOT; cooldown collapses frames

**Why this split:** B-heuristic is the harness-dependent / heuristic part and the most likely to need
tuning or rollback; isolating it lets B-core's deterministic `end_turn`-gated rebrief land and be
measured first, and lets B-heuristic be reverted alone without losing controller-triggered rebrief.
Per per-commit-await-approval discipline, each commit STOPs for lead approval before the next.

---

## 5. Impact on existing fresh-session first-briefing logic

- **Fresh spawn (loaded=false):** unchanged. `compose()` still injects once via the existing
  `briefed` gate (`:793-794`); `needsRebrief` is empty on a fresh agent so the new top block is a
  no-op.
- **Resumed session (loaded=true):** unchanged for the no-compaction case (`compose` still returns
  `text` at `:792`). New behavior: if a compaction is later detected, `needsRebrief` lets a resumed
  session receive a briefing it previously never got post-resume — a strict improvement, not a
  regression.
- **A1/A2** change only the *content* of the briefing string (add explicit-absence lines + one norms
  bullet); they do not change *when* it is injected. Fresh-session tests that assert on present
  charter/instructions stay green; tests asserting "absent ⇒ omitted" must flip to "absent ⇒ explicit
  line" (called out in B5).
- `sendBarePrompt`'s return-type change (B1) is internal; its only callers are the compact paths.

---

## 6. Token-cost assessment

- **Rebrief size:** one `buildMeshBriefing()` output ≈ the first-briefing block. For a typical
  small mesh that's on the order of ~1–2 KB of text (roster + tools + norms card + charter/role if
  present). **Worst case can exceed ~8 KB**: charter and per-agent instructions are each capped at
  4000 chars (`mesh-validate.ts:62/81`), so both maxed ≈ 8 KB *plus* the roster + tools + norms-card
  boilerplate on top. It is prepended to **one** real prompt, not added every turn, and only fires
  after a compaction (i.e. right when occupancy just dropped).
- **Frequency:** at most once per actual compaction. Compaction itself is rate-limited by
  `COMPACT_COOLDOWN_MS = 180_000` (3 min) and only fires near threshold (default `85%`,
  `auto-compact.ts:1`), so rebrief inherits that ceiling: ≤ 1 rebrief / 3 min / agent, and in
  practice far less. The usage-drop heuristic (B3) reuses the same cooldown so it cannot double-fire.
- **Net context impact:** negligible and self-limiting — a rebrief adds a few KB exactly when the
  context was *just reduced* by compaction (used dropped sharply), so it lands when there is the most
  headroom. It does not accumulate (flag is one-shot, cleared on consume in `compose`).
- **No extra turns:** rebrief rides the next real outbound prompt; it never spawns its own turn, so
  there is no added round-trip cost.

---

## 7. usage-drop threshold rationale

- `MIN_AUTO_COMPACT_CONTEXT_WINDOW = 80_000` (`auto-compact.ts:2`) is the existing floor below which
  auto-compact is disabled. Requiring `prevUsed ≥ 40_000` (`DROP_PREV_FLOOR_FRAC = 0.5`) only filters
  out small-context noise — it is a **permissive** floor, **not** evidence the context was anywhere
  near the compaction threshold. A drop from, say, 45k → 5k would qualify even though 45k may be well
  under the 85% waterline. We accept this looseness because the cost of acting is one harmless rebrief
  (see below); it is explicitly not a proof-of-compaction.
- `DROP_RATIO = 0.5`: requiring the new `used` to be ≤ 50% of the previous frame's. Within a single
  turn `used` generally accumulates upward, so a halving between frames is unusual for `usage_update`
  — but this is a heuristic signal, not a guarantee; a harness could in principle emit a transient
  lower frame for other reasons. Source-tagging (B3) already excludes the per-request `token_count`
  stream, which is the main known source of legitimate large swings.
- **Cooldown = `COMPACT_COOLDOWN_MS` (180_000):** post-compact a harness may emit several
  `usage_update` frames; reusing the compaction cooldown collapses them to a single rebrief.
- These are **heuristic** constants, named and commented as such, and tunable. The asymmetric cost
  structure is what justifies a simple ratio rule rather than anything more elaborate: a missed
  detection just means no auto-rebrief (the agent can still call `mesh_briefing` via the A2
  discipline), and a false positive costs exactly one harmless rebrief on the next prompt. We
  deliberately do not claim the thresholds *detect compaction*; they detect a *large usage_update
  drop*, which we treat as a cheap, best-effort rebrief trigger.

---

## 8. Risks & rollback points

| Risk | Mitigation | Rollback |
|---|---|---|
| B3 heuristic false-positive (spurious rebrief) | source-tagging excludes `token_count`; conservative ratios + cooldown; rebrief is harmless | revert Commit 3 (B-heuristic) alone — B-core rebrief stays |
| B3 false-negative (harness emits no usage drop, e.g. token_count-only) | B1 still rebriefs on controller-triggered `end_turn`; A2 lets agent self-recall | n/a (degrades to current behavior) |
| `end_turn` token differs per harness | verify codex & claude both emit `end_turn` on `/compact` success during impl; if not, map per-harness success set | gate behind a known-success allowlist |
| `sendBarePrompt` return-type change ripples | only compact callers use it; typed `string \| undefined` | revert Commit 2 (B-core) |
| A1 wording leaks into snapshot tests | update the absent-case assertions (B5) | revert Commit 1 |
| kill mid-`/compact` hang (pre-existing) | **not addressed this round**; logged as follow-up | — |

**Rollback granularity:** three commits (A, B-core, B-heuristic). A is fully independent. B-core
(deterministic `end_turn`-gated rebrief) stands alone. B-heuristic (source-tagged usage-drop) reverts
independently of B-core, so a misbehaving heuristic can be dropped without losing controller-triggered
rebrief.

---

## 9. In-scope vs. follow-up risk log

**In scope this round (design → then implement after approval):** A1, A2, A3, B1 (stopReason gating
+ `needsRebrief` on `end_turn`), B2, B3 (usage-drop heuristic), B4 (compose consume), B5 (tests).

**Explicitly out of scope — logged as follow-up risks:**
1. **`kill()`/`onExit` does not `failActiveTurn`** (`src/acp/client.ts:466-471`; `failActiveTurn`
   exists at `:371`). A kill mid-`/compact` can leave the await pending until transport close,
   stalling `turnCounts`. Recommended as its own task. (Matches the audit #379 finding and an existing
   un-deployed fix noted on a separate branch.)
2. **Harness-internal compaction signal.** We only *infer* non-controller compaction via the usage
   drop; there is no first-class ACP event for "the harness compacted itself." If a future harness
   exposes one, prefer it over the heuristic.
3. **`compact_skipped` telemetry.** If B1 adds a distinct skipped event rather than reusing
   `compact_failed`, the web UI (`src/web/gateway.ts:454-455` handles `compact_started/completed`)
   may want a matching case — cosmetic, deferrable.

---

## 10. Open questions for reviewer / prdmgr

- B1 success token: confirm both codex and claude report `stopReason === "end_turn"` on a successful
  `/compact` (the implementer will verify against a live `/compact` during the dev phase; if a harness
  uses a different success token, B1 uses a per-harness success allowlist instead of a bare equality).
- A3 surface: design defaults to **doctor-only** (`config.meshes` warning), matching the lead's
  stated preference. Open question: also emit a one-time `log`/event at mesh load for
  missing-charter/instructions? Default = no (doctor-only); flagged for prdmgr to confirm.
- **Project exposure (Low):** the briefing roster does not include each agent's `project` path
  (confirmed, §2 A1). Should the roster line surface `project` so agents can ground "where do I
  work"? Left as an open question — **not** included in this implementation; would be a separate
  small change to the roster `map` (`src/mesh-briefing.ts:13`) if desired.
- B split: now **3 commits** (A; B-core; B-heuristic) per reviewer Low guidance (§4); B-heuristic is
  independently revertable. Confirm this is the desired granularity.
