// Step 5 C5 — StatusChip primitive (the signature status element).
// v2 semantic tokens only; no raw-* scales. Maps the canonical 6 statuses
// (Step 1 00-index) onto v2 status tones, with dot/worded/soft/filled variants.
import type { ReactNode } from "react";

export type Status = "ready" | "working" | "blocked" | "attention" | "idle" | "done";
export type StatusChipVariant = "dot" | "worded" | "soft" | "filled";

// Each status → a tone's literal class set (literal so Tailwind generates them).
// `filled` uses on-<tone> foreground; idle has no on-fill token so it falls back to soft.
interface Tone {
  text: string;
  dot: string;
  soft: string;
  filled: string;
  label: string;
}
const TONE: Record<Status, Tone> = {
  ready: { text: "text-success", dot: "bg-success", soft: "bg-success-subtle text-success", filled: "bg-success text-on-success", label: "ready" },
  done: { text: "text-success", dot: "bg-success", soft: "bg-success-subtle text-success", filled: "bg-success text-on-success", label: "done" },
  working: { text: "text-accent", dot: "bg-accent", soft: "bg-accent-subtle text-accent", filled: "bg-accent text-on-accent", label: "working" },
  attention: { text: "text-warning", dot: "bg-warning", soft: "bg-warning-subtle text-warning", filled: "bg-warning text-on-warning", label: "attention" },
  blocked: { text: "text-danger", dot: "bg-danger", soft: "bg-danger-subtle text-danger", filled: "bg-danger text-on-danger", label: "blocked" },
  idle: { text: "text-idle", dot: "bg-idle", soft: "bg-surface-raised text-idle", filled: "bg-surface-raised text-idle", label: "idle" },
};

export interface StatusChipProps {
  status: Status;
  variant?: StatusChipVariant;
  /** Override the default status word. */
  label?: ReactNode;
  /** Optional trailing count. */
  count?: number;
  className?: string;
}

export function StatusChip({ status, variant = "worded", label, count, className = "" }: StatusChipProps) {
  const t = TONE[status];
  const text = label ?? t.label;
  if (variant === "dot") {
    return <span role="img" aria-label={t.label} className={`inline-block w-2 h-2 rounded-full ${t.dot} ${className}`} />;
  }
  const surface = variant === "filled" ? t.filled : variant === "soft" ? t.soft : t.text;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${surface} ${className}`}>
      {variant === "worded" ? <span className={`w-1.5 h-1.5 rounded-full ${t.dot}`} aria-hidden="true" /> : null}
      <span>{text}</span>
      {count != null ? <span className="opacity-80 tabular-nums">{count}</span> : null}
    </span>
  );
}
