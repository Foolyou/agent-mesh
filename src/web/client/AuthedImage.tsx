// Authorized media loader (design device-auth.md §4 / commit 5). A plain <img src="/api/..."> can't
// send Authorization, so on an exposed bind the device-token gate would 401 it. AuthedImage fetches
// a SAME-ORIGIN /api/* image WITH the bearer token, turns the bytes into an object URL, and revokes
// it on change/unmount. Any other URL (data:, blob:, external http(s), non-/api path) is rendered
// untouched — we never Bearer-fetch third-party / user-provided remote media.
import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { authHeaders } from "./device-auth";

/** True only for a URL whose bytes are served by THIS origin under /api/* (and thus gated). Relative
 *  "/api/…" is same-origin by definition; an absolute URL must match the page origin. When there is
 *  no `location` (non-browser/test), absolute URLs are treated as non-gated (we can't prove
 *  same-origin, so we don't Bearer-fetch them). data:/blob: are never gated. */
export function isSameOriginApiUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (/^(data:|blob:)/i.test(url)) return false;
  if (url.startsWith("/api/")) return true;
  if (typeof location === "undefined") return false;
  try {
    const u = new URL(url, location.href);
    return u.origin === location.origin && u.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/** Fetch a gated /api image with the bearer token and return an object URL, or null on any failure.
 *  Pure I/O (the hook adds React lifecycle + revoke); `createObjectUrl` is injectable for tests. */
export async function fetchAuthorizedObjectUrl(
  src: string,
  fetchFn: typeof fetch = fetch,
  createObjectUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
): Promise<string | null> {
  // Fail closed at the lowest helper: NEVER attach the bearer token to anything that isn't a
  // same-origin /api/* URL, even if a future caller forgets the predicate. No external/data/blob/
  // viewer URL is ever fetched here.
  if (!isSameOriginApiUrl(src)) return null;
  try {
    const res = await fetchFn(src, { headers: authHeaders() });
    if (!res.ok) return null;
    return createObjectUrl(await res.blob());
  } catch {
    return null;
  }
}

/** Resolve an <img> src: a gated /api URL → an object URL fetched with Bearer (revoked on
 *  change/unmount); anything else → the URL unchanged. Returns "" while a gated image loads or if it
 *  failed, so the <img> shows its alt rather than a broken request. */
export function useAuthorizedMedia(src: string | undefined): string {
  const gated = isSameOriginApiUrl(src);
  const [objectUrl, setObjectUrl] = useState("");
  useEffect(() => {
    if (!gated || !src) {
      setObjectUrl("");
      return;
    }
    let alive = true;
    let made: string | undefined;
    setObjectUrl("");
    void fetchAuthorizedObjectUrl(src).then((url) => {
      if (!url) return;
      if (!alive) {
        URL.revokeObjectURL(url);
        return;
      }
      made = url;
      setObjectUrl(url);
    });
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [src, gated]);
  return gated ? objectUrl : src ?? "";
}

export function AuthedImage({ src, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { src?: string }) {
  const resolved = useAuthorizedMedia(typeof src === "string" ? src : undefined);
  // While a gated image loads (resolved === "") we omit src so the browser shows alt, not a 401 fetch.
  return <img {...rest} src={resolved || undefined} />;
}
