// Step 5 C6 — EmptyState: the "nothing here yet" placeholder (empty list, no
// results, first-run). Centered icon + title + description + optional action.
// v2 semantic tokens only; no raw-* scales.
import type { ReactNode } from "react";

export interface EmptyStateProps {
  /** Decorative leading glyph/illustration. */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Primary call-to-action (e.g. a Button). */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className = "" }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 px-6 py-10 text-center ${className}`}>
      {icon != null ? <div aria-hidden="true" className="text-text-muted">{icon}</div> : null}
      <p className="text-sm font-semibold text-text-primary">{title}</p>
      {description != null ? <p className="max-w-prose text-xs text-text-secondary">{description}</p> : null}
      {action != null ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
