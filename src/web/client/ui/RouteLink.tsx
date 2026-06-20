// Step 5 C5 — RouteLink primitive: a REAL <a href> that SPA-navigates on an
// unmodified same-origin left-click, and falls back to native behavior otherwise
// (open-in-new-tab / middle-click / modifier-click / target=_blank / download /
// cross-origin all work natively).
// The app's router (later step) listens for popstate; here we just push + signal.
// v2 semantic tokens only; no raw-* scales.
import type { AnchorHTMLAttributes, MouseEvent } from "react";

export interface RouteLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  /** Marks the current route (sets aria-current="page" + emphasis). */
  active?: boolean;
  /** Drop the default link visuals (text-link/underline) — for link-as-row/card
   *  wrappers that supply their own styling; SPA behavior + focus ring are kept. */
  unstyled?: boolean;
}

/** The minimal click shape we inspect — keeps {@link spaTarget} testable without a DOM. */
export interface RouteClick {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

/**
 * Decide whether a click should be SPA-intercepted. Returns the same-origin
 * destination path (`pathname+search+hash`) to push, or `null` when the browser
 * should handle it natively (modified/non-left click, target≠_self, download,
 * or a cross-origin href — pushState with a cross-origin URL would throw).
 * Pure + origin-injected so it can be unit-tested without a real DOM.
 */
export function spaTarget(
  href: string,
  e: RouteClick,
  origin: string,
  target?: string,
  download?: AnchorHTMLAttributes<HTMLAnchorElement>["download"],
): string | null {
  if (e.defaultPrevented) return null;
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  if (target && target !== "_self") return null;
  if (download != null && download !== false) return null;
  const url = new URL(href, origin);
  if (url.origin !== origin) return null;
  return url.pathname + url.search + url.hash;
}

export function RouteLink({ href, active = false, unstyled = false, className = "", onClick, target, download, children, ...rest }: RouteLinkProps) {
  return (
    <a
      href={href}
      target={target}
      download={download}
      aria-current={active ? "page" : undefined}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        const next = spaTarget(href, e, window.location.origin, target, download);
        if (next == null) return; // native navigation
        e.preventDefault();
        const here = window.location.pathname + window.location.search + window.location.hash;
        if (next !== here) {
          window.history.pushState({}, "", next);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }
      }}
      className={[
        unstyled ? "" : "text-link underline-offset-2 hover:underline",
        "rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring",
        !unstyled && active ? "font-medium" : "",
        className,
      ].join(" ")}
      {...rest}
    >
      {children}
    </a>
  );
}
