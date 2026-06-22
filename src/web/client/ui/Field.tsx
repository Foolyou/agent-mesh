// Step 5 C5 — form control primitives (Input / Textarea / Select).
// v2 semantic tokens only; no raw-* scales. `error` sets aria-invalid + danger edge.
import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

const FIELD_BASE =
  "block bg-surface-sunken rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted " +
  "border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring " +
  "disabled:text-text-disabled disabled:cursor-not-allowed";
const edge = (error?: boolean) => (error ? "border-danger" : "border-border-strong");

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}
export function Input({ error, className = "", ...rest }: InputProps) {
  return <input aria-invalid={error || undefined} className={`${FIELD_BASE} ${edge(error)} ${className}`} {...rest} />;
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}
export function Textarea({ error, className = "", ...rest }: TextareaProps) {
  // w-full on the Textarea primitive (not FIELD_BASE): multi-line inputs always fill their
  // container — a bare `block` textarea otherwise falls back to its `cols` width and shrinks
  // into the top-left of a wide composer (the reported mobile bug). Input/Select keep their
  // narrow inline widths (board search, settings hex, new-mesh compact fields).
  return <textarea aria-invalid={error || undefined} className={`${FIELD_BASE} w-full ${edge(error)} ${className}`} {...rest} />;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean;
}
export function Select({ error, className = "", children, ...rest }: SelectProps) {
  return (
    <select aria-invalid={error || undefined} className={`${FIELD_BASE} ${edge(error)} ${className}`} {...rest}>
      {children}
    </select>
  );
}
