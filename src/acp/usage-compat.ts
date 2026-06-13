export type UsageUpdate = { used: number; size: number; usagePercent: number };
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
  return { used, size, usagePercent: used / size };
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
