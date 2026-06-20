// Step 5 C5 — Badge (count / notification) primitive.
// v2 semantic tokens only; no raw-* scales.
export type BadgeTone = "neutral" | "accent" | "info" | "urgent";

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-surface-sunken text-text-secondary",
  accent: "bg-accent text-on-accent",
  info: "bg-info text-on-info",
  urgent: "bg-danger text-on-danger",
};

export interface BadgeProps {
  /** Numeric count; omit for a bare dot when `dot`. */
  count?: number;
  /** Cap the displayed number, e.g. 9 → "9+". */
  max?: number;
  tone?: BadgeTone;
  /** Render a bare dot (no number) — e.g. an unread indicator. */
  dot?: boolean;
  /** Accessible label (the visible number is decorative for SR when ambiguous). */
  label?: string;
  className?: string;
}

export function Badge({ count, max = 99, tone = "neutral", dot = false, label, className = "" }: BadgeProps) {
  if (dot) {
    return <span role="status" aria-label={label ?? "indicator"} className={`inline-block w-2 h-2 rounded-full ${TONE[tone]} ${className}`} />;
  }
  const n = count ?? 0;
  const text = n > max ? `${max}+` : String(n);
  return (
    <span
      aria-label={label}
      className={`inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full text-xs font-semibold tabular-nums ${TONE[tone]} ${className}`}
    >
      {text}
    </span>
  );
}
