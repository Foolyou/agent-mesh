// Step 5 C5 — feedback primitives (Skeleton / Spinner / ProgressBar).
// v2 semantic tokens only (Tailwind utilities → var(--token)); no raw-* scales.
import type { CSSProperties } from "react";

/** Indeterminate busy spinner. role=status so assistive tech announces it. */
export function Spinner({ size = 16, label = "Loading", className = "" }: { size?: number; label?: string; className?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      style={{ width: size, height: size }}
      className={`inline-block animate-spin rounded-full border-2 border-border border-t-accent align-[-0.125em] ${className}`}
    />
  );
}

/** Loading placeholder (shape of forthcoming content). Decorative → aria-hidden. */
export function Skeleton({ variant = "line", className = "", style }: { variant?: "line" | "block" | "row" | "card"; className?: string; style?: CSSProperties }) {
  const shape =
    variant === "line" ? "h-3 w-full rounded"
    : variant === "row" ? "h-9 w-full rounded-lg"
    : variant === "card" ? "h-24 w-full rounded-xl"
    : "h-16 w-full rounded-lg"; // block
  return <div aria-hidden="true" style={style} className={`animate-pulse bg-border ${shape} ${className}`} />;
}

/** Determinate progress. role=progressbar with aria-valuenow/min/max. */
export function ProgressBar({ value, max = 100, label, className = "" }: { value: number; max?: number; label?: string; className?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
      className={`h-1.5 w-full overflow-hidden rounded-full bg-border ${className}`}
    >
      <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}
