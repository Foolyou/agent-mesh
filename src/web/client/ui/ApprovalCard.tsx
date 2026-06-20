// Step 5 C7 — ApprovalCard: the conversation permission/approval prompt. Mirrors
// the real PermissionReq shape (question + {id,name,kind} options → resolve by id)
// without importing the store. Presentational only; the page wires onResolve.
// v2 semantic tokens only; no raw-* scales.
import type { ReactNode } from "react";
import { Button, type ButtonVariant } from "./Button";

export interface ApprovalOption {
  id: string;
  label: ReactNode;
  /** Hints the button treatment (approve→primary, reject→danger, else secondary). */
  kind?: "approve" | "reject" | "neutral";
}

export interface ApprovalCardProps {
  /** Who/what is asking (e.g. "router · write file"). */
  title?: ReactNode;
  question: ReactNode;
  options: ApprovalOption[];
  onResolve: (optionId: string) => void;
  /** Disable all options while a resolution is in flight. */
  busy?: boolean;
  /** When set, the prompt is resolved: show this instead of the option buttons. */
  resolvedLabel?: ReactNode;
  className?: string;
}

const OPTION_VARIANT: Record<NonNullable<ApprovalOption["kind"]>, ButtonVariant> = {
  approve: "primary",
  reject: "danger",
  neutral: "secondary",
};

export function ApprovalCard({ title, question, options, onResolve, busy = false, resolvedLabel, className = "" }: ApprovalCardProps) {
  return (
    <section role="group" className={`flex flex-col gap-2 rounded-xl border border-border-strong bg-surface-raised px-4 py-3 text-text-primary ${className}`}>
      {title != null ? <p className="text-xs font-medium text-text-secondary">{title}</p> : null}
      <p className="text-sm">{question}</p>
      {resolvedLabel != null ? (
        <p className="text-xs text-text-secondary">{resolvedLabel}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {options.map((opt) => (
            <Button
              key={opt.id}
              size="sm"
              variant={OPTION_VARIANT[opt.kind ?? "neutral"]}
              busy={busy}
              onClick={() => onResolve(opt.id)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
