import type { ComponentProps, MouseEvent } from "react";
import { Streamdown, defaultRehypePlugins, type UrlTransform, type Components } from "streamdown";
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
// base64 image scheme the spec allows survives sanitize (the default schema only allows http/https,
// which silently stripped every data: image before harden could act). harden + urlTransform + the
// <Image> component below still constrain data: URIs to safe raster types (png/jpeg/gif/webp; no
// svg/html). `tel:` href and code `metastring` are preserved to match streamdown's own schema.
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

const harden = defaultRehypePlugins.harden as unknown as [unknown, Record<string, unknown>];
// Deliberately NO rehype-raw: per the design's "no raw HTML passthrough" decision, agent-authored
// raw HTML must not be parsed into live elements. Omitting raw lets streamdown's default html->text
// fallback (and the skipHtml prop) strip it; sanitize + harden remain as defense-in-depth.
const rehypePlugins = [
  [rehypeSanitize, sanitizeSchema],
  [
    harden[0],
    {
      allowedImagePrefixes: ["*"],
      allowedLinkPrefixes: ["*"],
      allowedProtocols: ["http:", "https:"],
      allowDataImages: true,
      imageBlockPolicy: "remove",
      linkBlockPolicy: "text-only",
    },
  ],
] as unknown as typeof defaultRehypePlugins[];

function Anchor(props: ComponentProps<"a">) {
  const author = useAuthor();
  const href = typeof props.href === "string" ? rewriteAgentHref(props.href, author) : undefined;
  const external = !!href && isHttpUrl(href);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    props.onClick?.(e);
    if (e.defaultPrevented || external || !href?.startsWith("/mesh/") || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    history.pushState(null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  return (
    <a {...props} href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined} onClick={onClick}>
      {props.children}
    </a>
  );
}

function Image(props: ComponentProps<"img">) {
  const author = useAuthor();
  const src = typeof props.src === "string" ? rewriteAgentImageSrc(props.src, author) : undefined;
  if (!src) return null;
  return <img {...props} src={src} referrerPolicy="no-referrer" loading="lazy" />;
}

function Strong(props: ComponentProps<"strong">) {
  return <strong {...props}>{props.children}</strong>;
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
