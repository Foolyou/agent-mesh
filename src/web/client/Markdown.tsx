import type { ComponentProps, MouseEvent } from "react";
import { Streamdown, type UrlTransform, type Components } from "streamdown";
import rehypeSanitize from "rehype-sanitize";
import { defaultSchema } from "hast-util-sanitize";
import { useAuthor, type AuthorRef } from "./AuthorContext";

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isRelativeRef(value: string): boolean {
  const v = value.trim();
  if (!v || v.startsWith("/") || v.startsWith("#") || v.startsWith("?")) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(v)) return false;
  return true;
}

function isImageSrc(value: string): boolean {
  if (isHttpUrl(value)) return true;
  return /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(value.trim());
}

const urlTransform: UrlTransform = (url, key) => {
  if (key === "href") return isHttpUrl(url) || isRelativeRef(url) ? url : null;
  if (key === "src") return isImageSrc(url) || isRelativeRef(url) ? url : null;
  return null;
};

// Sanitize with the GitHub default schema, but additionally permit `data:` on <img src> so the
// base64 image scheme the spec allows survives sanitize. urlTransform + the <Image> component below
// still constrain data: URIs to safe raster types (png/jpeg/gif/webp; no svg/html). `tel:` href and
// code `metastring` are preserved to match streamdown's own schema.
const sanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), "data"],
    href: [...(defaultSchema.protocols?.href ?? []), "tel"],
  },
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "metastring"],
  },
};

// Deliberately NO rehype-raw: per the design's "no raw HTML passthrough" decision, agent-authored
// raw HTML must not be parsed into live elements. Omitting raw lets streamdown's default html->text
// fallback (and the skipHtml prop) strip it; sanitize remains as defense-in-depth.
// Deliberately NO rehype-harden either: it blocks bare relative refs like `report.md` before our
// React Anchor/Image components can rewrite them through AuthorContext.
const rehypePlugins = [[rehypeSanitize, sanitizeSchema]];

// Streamdown is invoked with `passNode: true`, so every custom component receives a hast
// AST `node` prop. Destructure it off before spreading the rest onto a DOM element — a
// straight `{...props}` serialises that object into `node="[object Object]"`.
type WithNode<P> = P & { node?: unknown };

function Anchor({ node: _node, href: rawHref, children, onClick, ...rest }: WithNode<ComponentProps<"a">>) {
  const author = useAuthor();
  const href = typeof rawHref === "string" ? rewriteAgentHref(rawHref, author) : undefined;
  // No usable href (urlTransform stripped it, or no AuthorContext for a relative ref):
  // render the link text as plain content instead of a dead `<a>` that invites clicks
  // going nowhere.
  if (!href) return <>{children}</>;
  const external = isHttpUrl(href);
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || external || !href.startsWith("/mesh/") || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    history.pushState(null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  return (
    <a {...rest} href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined} onClick={handleClick}>
      {children}
    </a>
  );
}

function Image({ node: _node, src: rawSrc, ...rest }: WithNode<ComponentProps<"img">>) {
  const author = useAuthor();
  const src = typeof rawSrc === "string" ? rewriteAgentImageSrc(rawSrc, author) : undefined;
  if (!src) return null;
  return <img {...rest} src={src} referrerPolicy="no-referrer" loading="lazy" />;
}

function Strong({ node: _node, children, ...rest }: WithNode<ComponentProps<"strong">>) {
  return <strong {...rest}>{children}</strong>;
}

export function Markdown({ text }: { text: string }) {
  return (
    <Streamdown
      className="md"
      mode="streaming"
      skipHtml
      controls={false}
      rehypePlugins={rehypePlugins as any}
      urlTransform={urlTransform}
      components={{ a: Anchor, img: Image, strong: Strong } as Components}
    >
      {text}
    </Streamdown>
  );
}

export function rewriteAgentHref(href: string, author: AuthorRef | undefined): string | undefined {
  if (isHttpUrl(href)) return href;
  if (!isRelativeRef(href) || !author) return undefined;
  return `/mesh/${encodeURIComponent(author.meshId)}/agent/${encodeURIComponent(author.agent)}/file/${encodeRelPath(href)}`;
}

export function rewriteAgentImageSrc(src: string, author: AuthorRef | undefined): string | undefined {
  if (isImageSrc(src)) return src;
  if (!isRelativeRef(src) || !author) return undefined;
  return `/api/agents/${encodeURIComponent(author.agent)}/files/${encodeRelPath(src)}`;
}

function encodeRelPath(value: string): string {
  const suffixAt = firstSuffixIndex(value);
  const path = suffixAt >= 0 ? value.slice(0, suffixAt) : value;
  const suffix = suffixAt >= 0 ? value.slice(suffixAt) : "";
  return path.split("/").map(encodeSegmentPreservingExistingEscapes).join("/") + suffix;
}

function firstSuffixIndex(value: string): number {
  const q = value.indexOf("?");
  const h = value.indexOf("#");
  if (q < 0) return h;
  if (h < 0) return q;
  return Math.min(q, h);
}

function encodeSegmentPreservingExistingEscapes(segment: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return encodeURIComponent(segment);
  }
}
