export type UsageUpdate = { used: number; size: number; usagePercent: number; cost?: number };
export type TokenCount = { lastTokens: number; contextWindow: number };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeCommandName(name: string): string {
  // Step 0 probe: codex and claude both execute a bare "/compact" ACP prompt as
  // a slash command, while codex advertises the command key as "compact".
  return name.startsWith("/") ? name.slice(1) : name;
}

export function parseUsageUpdate(raw: unknown): UsageUpdate | null {
  // Step 0 probe: codex emits { used, size }; claude emits { used, size, cost }.
  // Both are forward-compatible usage_update frames relative to the bundled ACP
  // TS schema, so callers may receive them from the raw stream bypass path.
  if (!isObject(raw) || raw.sessionUpdate !== "usage_update") return null;
  const used = finiteNumber(raw.used);
  const size = finiteNumber(raw.size);
  if (used === null || size === null || size <= 0) return null;
  const cost = finiteNumber(raw.cost ?? (raw as Record<string, unknown>).totalCost ?? (raw as Record<string, unknown>).total_cost);
  const update: UsageUpdate = { used, size, usagePercent: used / size };
  if (cost !== null) update.cost = cost;
  return update;
}

// ── Model → context-window table (Zed-style static map) ───────────────────────
// Mirrors Zed's per-model context windows. A harness can under-report the window
// early in a session — e.g. claude-agent-acp ships DEFAULT_CONTEXT_WINDOW=200000
// and only upgrades it mid-turn (message_start heuristic / result.contextWindow),
// so a Claude Opus 4.8 session first reports size=200000 while the real window is
// 1M. When the model id is known, the table value is the authoritative denominator
// so the UI waterline and auto-compact never act on the wrong (too-small) window.
const ONE_MILLION = 1_000_000;
const TWO_HUNDRED_K = 200_000;

/** Canonical Anthropic context windows keyed by a model-id token. More specific
 *  (longer) tokens are matched first so "opus-4-1" wins over a bare-family token. */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "opus-4-1": TWO_HUNDRED_K,
  "opus-4-5": ONE_MILLION,
  "opus-4-6": ONE_MILLION,
  "opus-4-7": ONE_MILLION,
  "opus-4-8": ONE_MILLION,
  "sonnet-4": ONE_MILLION,
  "sonnet-4-5": ONE_MILLION,
  "sonnet-4-6": ONE_MILLION,
};

/** Decide whether the suffix that follows a matched stem keeps the stem authoritative.
 *  Accepts the bare stem ("claude-sonnet-4"), a dated release ("…-4-20250514"), and a
 *  non-numeric qualifier ("…-4-latest", "…-4-thinking"); REJECTS a different numeric minor
 *  ("…-4-7", "…-4-10", "…-4-50") so an unknown Sonnet/Opus 4.x falls through to the reported
 *  size instead of being treated as an authoritative window it was never listed for. */
function tailKeepsStemAuthoritative(tail: string): boolean {
  if (tail === "") return true; // exact id / base alias
  if (tail[0] !== "-") return false; // glued to a longer alphanumeric run, not our model
  const rest = tail.slice(1);
  if (/^\d{8}(?:-.*)?$/.test(rest)) return true; // dated release id (YYYYMMDD[, then more])
  if (/^[a-z]/.test(rest)) return true; // non-numeric qualifier (latest/thinking/…)
  return false; // a numeric minor version not explicitly listed in the table
}

/** True when `stem` appears in `id` at boundaries that make it the model the stem names —
 *  not glued into a longer family token and not a different numeric minor of it. */
function idMatchesStem(id: string, stem: string): boolean {
  for (let from = 0; ; ) {
    const i = id.indexOf(stem, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : id[i - 1]!;
    const beforeOk = before === "" || !/[a-z0-9]/.test(before);
    if (beforeOk && tailKeepsStemAuthoritative(id.slice(i + stem.length))) return true;
    from = i + 1;
  }
}

/** An explicit context-window beta marker in a model id, e.g. "claude-sonnet-4-5[1m]" or the
 *  config alias "sonnet[1m]" (1M beta), "…[200k]". The bracket declares the window directly, so
 *  it overrides the stem table and works even for ids whose stem isn't listed or is a bare alias. */
const CONTEXT_WINDOW_MARKER = /\[(\d+)(m|k)\]/;

/** Look up a model's context window from the static table, or null if unknown.
 *  Tolerant of separator/case variants ("Claude Opus 4.8" === "claude-opus-4-8"). */
export function lookupModelContextWindow(modelId: string | null | undefined): number | null {
  if (typeof modelId !== "string") return null;
  const id = modelId.toLowerCase().replace(/[._\s]+/g, "-");
  if (!id) return null;
  // An explicit "[1m]"/"[200k]" window marker is authoritative — honor it before the stem table
  // (a harness/config may select the 1M beta via this suffix, e.g. "sonnet[1m]").
  const marker = id.match(CONTEXT_WINDOW_MARKER);
  if (marker) return Number(marker[1]) * (marker[2] === "m" ? ONE_MILLION : 1_000);
  // Strip any bracket suffix so a stem like "claude-opus-4-8[…]" still matches the table.
  const stemId = id.replace(/\[[^\]]*\]/g, "");
  // Longest stem first so an explicit minor ("sonnet-4-6") wins over the bare family
  // ("sonnet-4") and a real minor is never shadowed by the base alias.
  const stems = Object.keys(MODEL_CONTEXT_WINDOWS).sort((a, b) => b.length - a.length);
  for (const stem of stems) {
    if (idMatchesStem(stemId, stem)) return MODEL_CONTEXT_WINDOWS[stem]!;
  }
  return null;
}

export type ContextWindowState = { modelId: string | null; window: number };

/** Resolve the authoritative context-window denominator for a usage frame.
 *  - Known model (table hit): the table value is authoritative; the reported size
 *    is ignored for the denominator (it may be a too-small early default).
 *  - Unknown model (table miss): fall back to the reported size, but never let the
 *    window shrink within the same model — a later, larger window sticks.
 *  Switching models (a different `modelId`) drops the sticky window so a new model
 *  can start over (and a fresh session/reset clears `prev` upstream). */
export function resolveContextWindow(
  prev: ContextWindowState | undefined,
  modelId: string | null | undefined,
  reportedSize: number,
): ContextWindowState {
  const id = typeof modelId === "string" && modelId.trim() ? modelId : null;
  const sticky = prev && prev.modelId === id ? prev.window : 0;
  const reported = Number.isFinite(reportedSize) && reportedSize > 0 ? reportedSize : 0;
  const table = lookupModelContextWindow(id);
  let window = table !== null ? table : Math.max(sticky, reported);
  if (window <= 0) window = reported;
  return { modelId: id, window };
}

/**
 * NOTE: For codex, last_token_usage.total_tokens is per-request tokens,
 * not cumulative context occupancy. Currently usage_update is the primary
 * source for auto-compact triggering; if a future harness only emits
 * token_count, this would severely underestimate and may never trigger.
 */
export function parseTokenCount(raw: unknown): TokenCount | null {
  if (!isObject(raw) || raw.sessionUpdate !== "event_msg" || !isObject(raw.payload)) return null;
  if (raw.payload.type !== "token_count") return null;
  if (!isObject(raw.payload.last_token_usage)) return null;
  const lastTokens = finiteNumber(raw.payload.last_token_usage.total_tokens);
  const contextWindow = finiteNumber(raw.payload.model_context_window);
  if (lastTokens === null || contextWindow === null) return null;
  return { lastTokens, contextWindow };
}

export function parseAvailableCommands(raw: unknown): string[] | null {
  if (!isObject(raw) || raw.sessionUpdate !== "available_commands_update") return null;
  if (!Array.isArray(raw.availableCommands)) return null;
  const names: string[] = [];
  for (const command of raw.availableCommands) {
    if (!isObject(command) || typeof command.name !== "string") continue;
    names.push(normalizeCommandName(command.name));
  }
  return names;
}
