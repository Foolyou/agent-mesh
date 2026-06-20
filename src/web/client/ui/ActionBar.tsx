// Step 5 C6 — ActionBar + small layout atoms. ActionBar is a horizontal toolbar
// (role=toolbar) that aligns a leading cluster and an optional trailing cluster.
// Toolbar/Cluster/Spacer are the minimal flex atoms the C6 components compose with.
// v2 semantic tokens only; no raw-* scales.
import type { ReactNode } from "react";

export interface ActionBarProps {
  /** Leading (left) cluster. */
  children?: ReactNode;
  /** Trailing (right) cluster, justified to the end. */
  end?: ReactNode;
  /** Accessible name for the toolbar. */
  ariaLabel?: string;
  className?: string;
}

export function ActionBar({ children, end, ariaLabel, className = "" }: ActionBarProps) {
  return (
    <div role="toolbar" aria-label={ariaLabel} className={`flex items-center gap-2 ${end != null ? "justify-between" : ""} ${className}`}>
      <div className="flex items-center gap-2 min-w-0">{children}</div>
      {end != null ? <div className="flex items-center gap-2 shrink-0">{end}</div> : null}
    </div>
  );
}

/** Horizontal flex cluster with a consistent gap (group related controls). */
export function Cluster({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <div className={`flex items-center gap-2 ${className}`}>{children}</div>;
}

/** Flexible spacer that pushes following siblings to the end of a flex row. */
export function Spacer() {
  return <span aria-hidden="true" className="flex-1" />;
}
