// Step 5 C6 — PanelFrame: the standard surface container (header + actions + body
// + optional footer) that every view panel sits in. v2 semantic tokens only;
// no raw-* scales. The section is labelled by its title for assistive tech.
import { useId, type ReactNode } from "react";

export interface PanelFrameProps {
  /** Panel heading; when present the <section> is aria-labelledby it. */
  title?: ReactNode;
  /** Secondary line under the title. */
  description?: ReactNode;
  /** Right-aligned header slot (typically an ActionBar / buttons). */
  actions?: ReactNode;
  /** Optional footer region (below the body, separated by a hairline). */
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function PanelFrame({ title, description, actions, footer, children, className = "", bodyClassName = "" }: PanelFrameProps) {
  const titleId = useId();
  const hasHeader = title != null || description != null || actions != null;
  return (
    <section
      aria-labelledby={title != null ? titleId : undefined}
      className={`flex flex-col rounded-xl border border-border bg-surface-raised text-text-primary ${className}`}
    >
      {hasHeader ? (
        // 7.5-B — C1 mobile rule: title block + actions stack on mobile (actions full-width
        // below the heading) so wide action clusters never squeeze the title into a vertical
        // char-wrap; they return to a single row at `lg`.
        <header className="flex flex-col gap-2 px-4 py-3 border-b border-border lg:flex-row lg:items-start lg:gap-3">
          <div className="min-w-0 lg:flex-1">
            {title != null ? <h2 id={titleId} className="text-sm font-semibold text-text-primary truncate">{title}</h2> : null}
            {description != null ? <p className="mt-0.5 text-xs text-text-secondary">{description}</p> : null}
          </div>
          {actions != null ? <div className="lg:shrink-0">{actions}</div> : null}
        </header>
      ) : null}
      <div className={`min-h-0 flex-1 px-4 py-3 ${bodyClassName}`}>{children}</div>
      {footer != null ? <footer className="px-4 py-3 border-t border-border text-xs text-text-secondary">{footer}</footer> : null}
    </section>
  );
}
