// Step 5 C7 — Composer: the STRUCTURAL shell for the message composer (the editable
// region is a slot — no business composer logic / migration here). Provides the
// framed surface, a focus-within ring, a toolbar (left) + actions (right) footer,
// and an optional hint line. v2 semantic tokens only; no raw-* scales.
import type { ReactNode } from "react";

export interface ComposerProps {
  /** The editable region (a <textarea>, rich editor, etc.) supplied by the page. */
  children?: ReactNode;
  /** Left footer cluster (attach, mode, etc.). */
  toolbar?: ReactNode;
  /** Right footer cluster (typically the send button). */
  actions?: ReactNode;
  /** Helper / status line under the footer. */
  hint?: ReactNode;
  /** Dim the shell while disabled (does not disable the slotted control). */
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function Composer({ children, toolbar, actions, hint, disabled = false, ariaLabel = "Message composer", className = "" }: ComposerProps) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={[
        "flex flex-col gap-2 rounded-xl border border-border-strong bg-surface-raised px-3 py-2",
        "focus-within:outline focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-focus-ring",
        disabled ? "opacity-60" : "",
        className,
      ].join(" ")}
    >
      <div className="min-w-0">{children}</div>
      {toolbar != null || actions != null ? (
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">{toolbar}</div>
          {actions != null ? <div className="flex items-center gap-2 shrink-0">{actions}</div> : null}
        </div>
      ) : null}
      {hint != null ? <p className="text-xs text-text-muted">{hint}</p> : null}
    </div>
  );
}
