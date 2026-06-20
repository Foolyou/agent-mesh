// Step 5 C7 — AttachmentCard: presentational attachment chip/card. The image
// preview is a SLOT (`media`) — the page passes its own <AuthedImage> there, so
// this primitive never imports AuthedImage and never alters its runtime behavior
// (the "connector shape" the lead asked for). When `href` is set the card is an
// SPA link via RouteLink(unstyled). v2 semantic tokens only; no raw-* scales.
import type { ReactNode } from "react";
import { RouteLink } from "./RouteLink";

export interface AttachmentCardProps {
  /** File/attachment name (label). */
  name: ReactNode;
  /** Optional caption under the card. */
  caption?: ReactNode;
  /** SPA viewer link; when set the card body becomes a link. */
  href?: string;
  /**
   * Image/preview slot — the page renders its authorized media here, e.g.
   * `<AttachmentCard media={<AuthedImage src={api} alt={name} />} />`.
   * When absent the card shows a 📎 + name affordance.
   */
  media?: ReactNode;
  className?: string;
}

export function AttachmentCard({ name, caption, href, media, className = "" }: AttachmentCardProps) {
  const body = media != null ? (
    <span className="block overflow-hidden rounded-lg border border-border">{media}</span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-text-primary">
      <span aria-hidden="true">📎</span>
      <span className="truncate">{name}</span>
    </span>
  );
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {href != null ? (
        <RouteLink href={href} unstyled title={typeof name === "string" ? name : undefined} className="block">
          {body}
        </RouteLink>
      ) : (
        body
      )}
      {caption != null ? <p className="text-xs text-text-secondary">{caption}</p> : null}
    </div>
  );
}
