export const DEFAULT_AUTO_COMPACT_SETTINGS = { enabled: true, threshold: "85%" } as const;
export const MIN_AUTO_COMPACT_CONTEXT_WINDOW = 80_000;

export type CompactThreshold =
  | { kind: "percent"; value: number }
  | { kind: "tokens-used"; value: number }
  | { kind: "tokens-remaining"; value: number };

function parsePositiveInteger(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`invalid compact threshold "${raw}"`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`compact threshold must be greater than zero`);
  return value;
}

export function parseCompactThreshold(raw: string): CompactThreshold {
  const text = raw.trim();
  if (!text) throw new Error("compact threshold is required");

  const percent = text.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
  if (percent) {
    const value = Number(percent[1]);
    if (!Number.isFinite(value) || value <= 0 || value > 100) {
      throw new Error("compact percent threshold must be greater than 0% and at most 100%");
    }
    return { kind: "percent", value: value / 100 };
  }

  const tokens = text.match(/^(-?\d+)(?:\s+tokens?)?$/i);
  if (!tokens) throw new Error(`invalid compact threshold "${raw}"`);
  const value = Number(tokens[1]);
  if (Object.is(value, -0) || value === 0) throw new Error("compact token threshold must be non-zero");
  if (value < 0) return { kind: "tokens-remaining", value: parsePositiveInteger(String(Math.abs(value))) };
  return { kind: "tokens-used", value: parsePositiveInteger(tokens[1]) };
}

export function evaluateCompactThreshold(threshold: CompactThreshold, used: number, contextWindow: number): boolean {
  if (!Number.isFinite(used) || !Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  switch (threshold.kind) {
    case "percent":
      return used / contextWindow >= threshold.value;
    case "tokens-used":
      return used >= threshold.value;
    case "tokens-remaining":
      return contextWindow - used <= threshold.value;
  }
}
