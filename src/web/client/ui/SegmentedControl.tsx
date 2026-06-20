// Step 5 C6 — SegmentedControl: single-select view switcher (e.g. List / Board /
// Detail). Radiogroup semantics (role=radio + aria-checked) with roving focus and
// arrow-key navigation, matching the native radio-group interaction model.
// v2 semantic tokens only; no raw-* scales.
import { useRef, type ReactNode } from "react";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Optional leading glyph (decorative). */
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  /** Accessible name for the group (required for a meaningful radiogroup). */
  ariaLabel: string;
  className?: string;
}

const SEG_SIZE = {
  sm: "text-xs px-2.5 py-1 gap-1",
  md: "text-sm px-3 py-1.5 gap-1.5",
} as const;

/**
 * Resolve the value an arrow/Home/End key should move selection to, skipping
 * disabled options and wrapping around. Returns null when `key` is not a
 * navigation key (or there is no enabled option). Pure → unit-testable.
 */
export function nextSegmentValue<T extends string>(options: SegmentOption<T>[], current: T, key: string): T | null {
  const enabled = options.filter((o) => !o.disabled);
  if (enabled.length === 0) return null;
  const idx = enabled.findIndex((o) => o.value === current);
  switch (key) {
    case "Home":
      return enabled[0].value;
    case "End":
      return enabled[enabled.length - 1].value;
    case "ArrowRight":
    case "ArrowDown":
      return enabled[idx < 0 ? 0 : (idx + 1) % enabled.length].value;
    case "ArrowLeft":
    case "ArrowUp":
      return enabled[idx < 0 ? enabled.length - 1 : (idx - 1 + enabled.length) % enabled.length].value;
    default:
      return null;
  }
}

export function SegmentedControl<T extends string>({ options, value, onChange, size = "md", ariaLabel, className = "" }: SegmentedControlProps<T>) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Roving focus: the focusable (tabIndex 0) item is the selected option if it's
  // enabled, otherwise the first enabled option. All other enabled items are -1.
  const rovingValue = options.find((o) => o.value === value && !o.disabled)?.value ?? options.find((o) => !o.disabled)?.value;
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`inline-flex items-center gap-1 rounded-lg bg-surface-sunken p-1 ${className}`}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => { refs.current[opt.value] = el; }}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={opt.disabled}
            tabIndex={opt.disabled ? undefined : opt.value === rovingValue ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => {
              const nv = nextSegmentValue(options, value, e.key);
              if (nv == null) return;
              e.preventDefault();
              onChange(nv);
              refs.current[nv]?.focus();
            }}
            className={[
              "inline-flex items-center justify-center rounded-md font-medium select-none transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring",
              "disabled:text-text-disabled disabled:cursor-not-allowed",
              SEG_SIZE[size],
              selected ? "bg-surface-raised text-text-primary shadow-sm" : "text-text-secondary hover:text-text-primary hover:bg-hover",
            ].join(" ")}
          >
            {opt.icon != null ? <span aria-hidden="true">{opt.icon}</span> : null}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
