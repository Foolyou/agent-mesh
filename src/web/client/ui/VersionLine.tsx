// Step 5 C7 — VersionLine: compact version display, e.g. "codex-acp 1.2.3 · codex
// 0.141.0" (mirrors HarnessPanel.harnessVersionLine). Unknown versions render as
// an em dash. Pure formatter + a styled span. v2 semantic tokens only; no raw-*.
import type { ReactNode } from "react";

export interface VersionItem {
  name: ReactNode;
  /** Unknown / unprobed → rendered as "—". */
  version?: string;
}

export interface VersionLineProps {
  primary: VersionItem;
  /** Optional second component (e.g. the underlying body tool). */
  secondary?: VersionItem;
  className?: string;
}

/** "—" for an unknown version, matching the existing harness version line. */
export const formatVersion = (v?: string): string => v ?? "—";

export function VersionLine({ primary, secondary, className = "" }: VersionLineProps) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs text-text-muted tabular-nums ${className}`}>
      <span>
        {primary.name} {formatVersion(primary.version)}
      </span>
      {secondary != null ? (
        <>
          <span aria-hidden="true">·</span>
          <span>
            {secondary.name} {formatVersion(secondary.version)}
          </span>
        </>
      ) : null}
    </span>
  );
}
