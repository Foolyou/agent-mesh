// Step 5 C7 — AssigneeTag: a small avatar (initials, or a slotted image) + name,
// for board assignee / author displays. Token-clean (no arbitrary label colors —
// label-color chips belong to the board migration step). v2 semantic tokens only.
import type { ReactNode } from "react";

export interface AssigneeTagProps {
  /** Display name / id. */
  name: string;
  /** Optional avatar image slot; falls back to initials. */
  avatar?: ReactNode;
  size?: "sm" | "md";
  /** Render only the avatar (name still drives the accessible label). */
  iconOnly?: boolean;
  className?: string;
}

/** 1–2 letter initials from a display name ("Ada Lovelace" → "AL", "router" → "R"). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const AVATAR_SIZE = { sm: "w-5 h-5 text-[0.625rem]", md: "w-6 h-6 text-xs" } as const;

export function AssigneeTag({ name, avatar, size = "md", iconOnly = false, className = "" }: AssigneeTagProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`} title={name}>
      <span
        aria-hidden={avatar == null ? "true" : undefined}
        className={`inline-flex items-center justify-center shrink-0 rounded-full bg-surface-sunken text-text-secondary font-medium overflow-hidden ${AVATAR_SIZE[size]}`}
      >
        {avatar ?? initials(name)}
      </span>
      {iconOnly ? <span className="sr-only">{name}</span> : <span className="text-xs text-text-primary truncate">{name}</span>}
    </span>
  );
}
