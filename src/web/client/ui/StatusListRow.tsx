// Step 5 C6 — StatusListRow: the canonical list row (mesh / task / session) with
// a leading status indicator, a title, optional meta, and a trailing slot. Renders
// as a RouteLink when href is given, a <button> when onClick is given, else a
// presentational <div>. v2 semantic tokens only; no raw-* scales.
import type { MouseEventHandler, ReactNode } from "react";
import { StatusChip, type Status } from "./StatusChip";
import { RouteLink } from "./RouteLink";

export interface StatusListRowProps {
  status: Status;
  title: ReactNode;
  /** Secondary text (right of the title or as a subline). */
  meta?: ReactNode;
  /** Trailing slot — badges, counts, action buttons. */
  trailing?: ReactNode;
  /** Navigate (SPA-aware) when set. */
  href?: string;
  /** Click handler when set (and no href). */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** Marks the row as the current selection. */
  active?: boolean;
  className?: string;
}

const ROW =
  "flex w-full items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors text-text-primary " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring";
const interactive = (active?: boolean) => (active ? "bg-selected text-text-on-selected" : "hover:bg-hover");

function Inner({ status, title, meta }: Pick<StatusListRowProps, "status" | "title" | "meta">) {
  return (
    <>
      <StatusChip status={status} variant="dot" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      {meta != null ? <span className="shrink-0 text-xs text-text-secondary">{meta}</span> : null}
    </>
  );
}

export function StatusListRow({ status, title, meta, trailing, href, onClick, active = false, className = "" }: StatusListRowProps) {
  const body = (
    <>
      <Inner status={status} title={title} meta={meta} />
      {trailing != null ? <span className="shrink-0">{trailing}</span> : null}
    </>
  );
  const cls = `${ROW} ${interactive(active)} ${className}`;
  if (href != null) {
    return (
      <RouteLink href={href} active={active} unstyled className={cls}>
        {body}
      </RouteLink>
    );
  }
  if (onClick != null) {
    return (
      <button type="button" aria-current={active ? "true" : undefined} onClick={onClick} className={cls}>
        {body}
      </button>
    );
  }
  return <div aria-current={active ? "true" : undefined} className={cls}>{body}</div>;
}
