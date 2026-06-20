// Step 5 C5 — Button + ConfirmButton primitives.
// v2 semantic tokens only; no raw-* scales. (Step 2 01-primitives / Step 3 03-themed.)
import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Spinner } from "./Feedback";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "link";
export type ButtonSize = "sm" | "md";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-active",
  secondary: "bg-surface-raised text-text-primary border border-border-strong hover:bg-hover",
  danger: "bg-danger text-on-danger",
  ghost: "bg-transparent text-text-secondary hover:bg-hover",
  link: "bg-transparent text-link underline-offset-2 hover:underline",
};
const SIZE: Record<ButtonSize, string> = {
  sm: "text-xs px-2.5 py-1 gap-1",
  md: "text-sm px-3.5 py-1.5 gap-1.5",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
  iconOnly?: boolean;
}

export function Button({ variant = "secondary", size = "md", busy = false, iconOnly = false, disabled, className = "", children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={[
        "inline-flex items-center justify-center rounded-lg font-medium select-none transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring",
        "disabled:text-text-disabled disabled:cursor-not-allowed disabled:opacity-100",
        VARIANT[variant],
        SIZE[size],
        iconOnly ? "aspect-square !px-0" : "",
        className,
      ].join(" ")}
    >
      {busy ? <Spinner size={size === "sm" ? 12 : 14} /> : null}
      {children}
    </button>
  );
}

export interface ConfirmButtonProps extends Omit<ButtonProps, "onClick"> {
  /** Invoked only on the SECOND (confirming) click. */
  onConfirm: () => void;
  /** Label shown while armed (awaiting confirm). */
  confirmLabel?: ReactNode;
}

/** Two-step confirm for destructive/irreversible actions (no native dialog): the
 *  first click arms it, the second confirms; blur disarms. */
export function ConfirmButton({ onConfirm, confirmLabel = "Confirm?", variant = "danger", children, ...rest }: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      {...rest}
      variant={variant}
      aria-pressed={armed || undefined}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? confirmLabel : children}
    </Button>
  );
}
