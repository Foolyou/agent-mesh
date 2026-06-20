// Step 5 C6 — ErrorBanner: an inline error/alert surface with optional retry and
// dismiss. role=alert so assistive tech announces it. Uses the danger "soft"
// treatment (danger-subtle + danger text). v2 semantic tokens only; no raw-*.
import type { ReactNode } from "react";
import { Button } from "./Button";

export interface ErrorBannerProps {
  /** Bold lead line; defaults to a generic error title. */
  title?: ReactNode;
  /** Detail message. */
  children?: ReactNode;
  /** Show a retry button wired to this handler. */
  onRetry?: () => void;
  retryLabel?: ReactNode;
  /** Show a dismiss (×) button wired to this handler. */
  onDismiss?: () => void;
  className?: string;
}

export function ErrorBanner({ title = "Something went wrong", children, onRetry, retryLabel = "Retry", onDismiss, className = "" }: ErrorBannerProps) {
  return (
    <div role="alert" className={`flex items-start gap-3 rounded-lg border border-danger bg-danger-subtle px-3 py-2 text-danger ${className}`}>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        {children != null ? <div className="mt-0.5 text-xs text-danger">{children}</div> : null}
      </div>
      {onRetry != null ? (
        <Button variant="danger" size="sm" onClick={onRetry}>{retryLabel}</Button>
      ) : null}
      {onDismiss != null ? (
        <Button variant="ghost" size="sm" iconOnly aria-label="Dismiss" onClick={onDismiss}>×</Button>
      ) : null}
    </div>
  );
}
