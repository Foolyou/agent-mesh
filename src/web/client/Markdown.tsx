import type { ComponentProps } from "react";
import { Streamdown, defaultRehypePlugins, type UrlTransform } from "streamdown";

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isImageSrc(value: string): boolean {
  if (isHttpUrl(value)) return true;
  return /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(value.trim());
}

const urlTransform: UrlTransform = (url, key) => {
  if (key === "href") return isHttpUrl(url) ? url : null;
  if (key === "src") return isImageSrc(url) ? url : null;
  return null;
};

const harden = defaultRehypePlugins.harden as unknown as [unknown, Record<string, unknown>];
const rehypePlugins = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
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
] as typeof defaultRehypePlugins[];

function Anchor(props: ComponentProps<"a">) {
  const href = typeof props.href === "string" && isHttpUrl(props.href) ? props.href : undefined;
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
      {props.children}
    </a>
  );
}

function Image(props: ComponentProps<"img">) {
  const src = typeof props.src === "string" && isImageSrc(props.src) ? props.src : undefined;
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
      components={{ a: Anchor, img: Image, strong: Strong }}
    >
      {text}
    </Streamdown>
  );
}
