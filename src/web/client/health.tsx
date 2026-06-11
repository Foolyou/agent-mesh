import type { AgentHealthSignalEntry, AgentUsage } from "../types";

const ACTIVE_SIGNALS = new Set(["rate_limited", "retrying", "compacting"]);

function numberDetail(detail: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = detail?.[key];
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function pct(n: number): string {
  const normalized = n <= 1 ? n * 100 : n;
  return `${Math.round(Math.max(0, Math.min(100, normalized)))}%`;
}

export function activeHealth(entry?: AgentHealthSignalEntry): AgentHealthSignalEntry | undefined {
  return entry && ACTIVE_SIGNALS.has(entry.signal) ? entry : undefined;
}

export function healthLabel(entry: AgentHealthSignalEntry): string {
  const detail = entry.detail;
  if (entry.signal === "compacting") return "compacting";
  if (entry.signal === "retrying") {
    const delayMs = numberDetail(detail, ["retryDelayMs", "delayMs", "retryInMs"]);
    return delayMs !== undefined ? `retry ${Math.max(1, Math.round(delayMs / 1000))}s` : "retrying";
  }
  if (entry.signal === "rate_limited") {
    const utilization = numberDetail(detail, ["utilization", "usage", "percent", "pct"]);
    return utilization !== undefined ? `rate ${pct(utilization)}` : "rate limited";
  }
  return entry.signal;
}

export function contextPercent(usage?: AgentUsage): number | undefined {
  if (!usage) return undefined;
  const used = Number(usage.used);
  const size = Number(usage.size);
  if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return undefined;
  return Math.max(0, Math.min(100, Math.round((used / size) * 100)));
}

export function AgentHealthBadges({ agent, entry }: { agent: string; entry?: AgentHealthSignalEntry }) {
  const active = activeHealth(entry);
  if (!active) return null;
  const label = healthLabel(active);
  return (
    <span className={`health-badge ${active.signal}`} title={`${agent}: ${label}`}>
      {label}
    </span>
  );
}

export function ContextWaterline({ agents, usage }: { agents: string[]; usage: Record<string, AgentUsage> }) {
  if (!agents.length) return null;
  return (
    <div className="context-waterline" aria-label="agent context usage">
      {agents.map((id) => {
        const percent = contextPercent(usage[id]);
        const label = percent === undefined ? "n/a" : `${percent}%`;
        return (
          <div className="context-agent" key={id} title={`${id}: ${label}`}>
            <span className="context-agent-label">{id}</span>
            <span className="context-track">
              <span className="context-fill" data-level={percent === undefined ? "unknown" : percent >= 90 ? "high" : percent >= 70 ? "warn" : "ok"} style={{ width: `${percent ?? 0}%` }} />
            </span>
            <span className="context-agent-pct">{label}</span>
          </div>
        );
      })}
    </div>
  );
}
