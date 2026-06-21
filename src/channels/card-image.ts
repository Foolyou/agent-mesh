// src/channels/card-image.ts
//
// Artifact image resolution + upload + cache for the Feishu rich-outbound path (design:
// docs/design/feishu-rich-outbound.md, C3). At an artifact-image card boundary the sender asks this
// module to turn an `artifact:` / `artifact://owner/` reference into either:
//   - { kind: "image", imgKey }  — uploaded to Feishu (`im.v1.image.create`), ready for an `img` element;
//   - { kind: "link", markdown } — a lark_md link to the device-auth console artifact URL (degrade);
//   - { kind: "text", markdown } — plain text (degrade when no console URL can be built).
//
// B1 (chosen): the Feishu outbound runs IN the backend process (src/channels/index.ts builds the
// CardSender there), so it has the storage `root` and reads artifact bytes DIRECTLY via
// resolveArtifactFile (cross-agent read needs nothing beyond same-mesh). No authorized-endpoint hop (B2).
//
// Secret hygiene: this module NEVER logs the artifact ref, the file bytes, or the image_key beyond a
// short hash, and the placeholder/degrade markdown carries only the human alt text (never the raw ref).

import { Readable } from "node:stream";
import { stat } from "node:fs/promises";
import * as lark from "@larksuiteoapi/node-sdk";
import { Jimp } from "jimp";
import type { ImageBoundary } from "./stream-segmenter";
import { resolveArtifactFile } from "../web/artifacts";
import { AgentFileError } from "../web/agent-files";

/** Outcome of resolving one artifact image. */
export type ResolvedImage =
  | { kind: "image"; imgKey: string }
  | { kind: "link"; markdown: string }
  | { kind: "text"; markdown: string };

/** Parsed reference: which (mesh, owner agent, file) the artifact ref points at. */
export interface ArtifactRef {
  mesh: string;
  owner: string;
  file: string;
}

/** Raw image the channel read from disk (B1). `size`+`mtime` form the cache key with (mesh,owner,file). */
export interface RawImage {
  bytes: Uint8Array;
  contentType: string;
  size: number;
  mtimeMs: number;
}

export interface ImageLimits {
  /** Hard byte cap for a Feishu upload (Feishu ≤10MB; artifacts are already ≤5MB). */
  maxBytes: number;
  /** Reject when height/width exceeds this (Feishu: height:width ≤ 16:9). 0 disables the check. */
  maxAspect: number;
  /** Reject when width exceeds this (Feishu: ≤1500px). 0 disables. Best-effort (skipped if dims unknown). */
  maxWidth: number;
  /** Reject when height exceeds this (Feishu: ≤3000px). 0 disables. Best-effort (skipped if dims unknown). */
  maxHeight: number;
}

export const DEFAULT_IMAGE_LIMITS: ImageLimits = { maxBytes: 10 * 1024 * 1024, maxAspect: 16 / 9, maxWidth: 1500, maxHeight: 3000 };

/** A scale (+ aspect pad) request handed to an injectable scaler for a salvageable oversize or
 *  aspect-too-tall image. `bytes` are the original artifact bytes; the scaler fits the image inside
 *  (maxWidth, maxHeight), letterbox-pads it horizontally when `h/w > maxAspect`, and keeps the result
 *  ≤ maxBytes. `maxAspect` ≤ 0 disables the pad step (fit-scale only). */
export interface ScaleRequest {
  bytes: Uint8Array;
  contentType: string;
  maxWidth: number;
  maxHeight: number;
  maxBytes: number;
  maxAspect: number;
}

/** A scaled image: re-encoded bytes in the SAME container, with its new dimensions. */
export interface ScaleResult {
  bytes: Uint8Array;
  contentType: string;
  width: number;
  height: number;
}

/** Injectable downscaler (jimpScaler by default; injected for tests and to degrade cleanly when the
 *  scaler is unavailable). Returns the scaled image, or null when it cannot produce an in-limit image
 *  (undecodable bytes, an unsupported container, or still over maxBytes) → the resolver degrades.
 *  MUST NOT throw and MUST NOT log the bytes (zero-leak). */
export type ImageScaler = (req: ScaleRequest) => Promise<ScaleResult | null>;

export interface ImageResolverDeps {
  /** Author agent for a bare `artifact:<file>` ref (the router that emitted the prose). */
  mesh: string;
  defaultAgent: string;
  /** Read the artifact bytes (B1: resolveArtifactFile + stat). Returns null when missing/unreadable. */
  readImage: (ref: ArtifactRef) => Promise<RawImage | null>;
  /** Upload bytes to Feishu, returning the image_key (or an error string). Injected for tests. */
  upload: (img: RawImage) => Promise<{ imgKey?: string; error?: string }>;
  /** Downscale an oversize-but-salvageable image to fit the limits (jimpScaler by default). Optional:
   *  when absent, oversize images degrade exactly as before (no local autoscale). */
  scaler?: ImageScaler;
  /** Build a device-auth console URL for the artifact, or undefined when none can be built (→ text). */
  viewerUrl?: (ref: ArtifactRef) => string | undefined;
  limits?: ImageLimits;
  log?: (msg: string) => void;
}

export interface ImageResolver {
  resolve: (boundary: ImageBoundary) => Promise<ResolvedImage>;
}

/** Parse an artifact image ref into (mesh, owner, file). `artifact:<file>` → the default (router) agent;
 *  `artifact://<owner>/<file>` → that owner in the CURRENT mesh (the mesh is never taken from the ref).
 *  Returns null for anything unsafe (`..`, empty, host-like owner). */
export function parseArtifactRef(ref: string, ctx: { mesh: string; defaultAgent: string }): ArtifactRef | null {
  let owner = ctx.defaultAgent;
  let file: string;
  if (ref.startsWith("artifact://")) {
    const rest = ref.slice("artifact://".length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null; // need owner/file
    owner = rest.slice(0, slash);
    file = rest.slice(slash + 1);
  } else if (ref.startsWith("artifact:")) {
    file = ref.slice("artifact:".length);
  } else {
    return null;
  }
  if (!isSafeName(owner) || !isSafeFile(file)) return null;
  return { mesh: ctx.mesh, owner, file };
}

function isSafeName(s: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(s) && !s.includes("..");
}
function isSafeFile(s: string): boolean {
  return s.length > 0 && !s.includes("..") && !s.startsWith("/") && /^[A-Za-z0-9._/-]+$/.test(s);
}

/** Build the image resolver with an in-memory upload cache keyed by (mesh, owner, file, size, mtime). */
export function createImageResolver(deps: ImageResolverDeps): ImageResolver {
  const limits = deps.limits ?? DEFAULT_IMAGE_LIMITS;
  const log = deps.log ?? (() => {});
  const cache = new Map<string, string>(); // cacheKey → imgKey (only successful uploads are cached)

  const degrade = (ref: ArtifactRef | null, alt: string): ResolvedImage => {
    const label = alt || "image";
    const url = ref && deps.viewerUrl ? deps.viewerUrl(ref) : undefined;
    return url ? { kind: "link", markdown: `[${mdEscape(label)}](${url})` } : { kind: "text", markdown: `🖼 ${label}` };
  };

  return {
    async resolve(boundary: ImageBoundary): Promise<ResolvedImage> {
      // Zero-leak: every log below is a GENERIC status — never the artifact ref/owner/file/path, the
      // bytes, the image_key, or a raw SDK/Error string (which could carry a path or secret).
      const ref = parseArtifactRef(boundary.ref, { mesh: deps.mesh, defaultAgent: deps.defaultAgent });
      if (!ref) {
        log("feishu image: unresolvable reference; degrading");
        return degrade(null, boundary.alt);
      }
      let raw: RawImage | null;
      try {
        raw = await deps.readImage(ref);
      } catch {
        log("feishu image: read failed; degrading");
        return degrade(ref, boundary.alt);
      }
      if (!raw) return degrade(ref, boundary.alt);

      // Source identity for the upload cache is the ORIGINAL file (mesh,owner,file,size,mtime); a cache HIT
      // short-circuits both scaling and upload for a re-sent image.
      const key = cacheKey(ref, raw);
      const cached = cache.get(key);
      if (cached) return { kind: "image", imgKey: cached };

      // Dimension/aspect policy (local, best-effort). Unknown dims (e.g. WebP) skip these checks entirely
      // and let Feishu's own upload validation backstop — preserving prior behavior with NO local autoscale.
      const dims = imageDims(raw.bytes, raw.contentType);
      if (dims) {
        if (limits.maxAspect > 0 && dims.h / dims.w > limits.maxAspect) {
          log("feishu image: aspect out of range; degrading"); // not salvageable here (no crop/reshape)
          return degrade(ref, boundary.alt);
        }
        const dimOver = (limits.maxWidth > 0 && dims.w > limits.maxWidth) || (limits.maxHeight > 0 && dims.h > limits.maxHeight);
        if (dimOver) {
          // Salvageable (aspect OK, only too big): proportionally downscale to fit, then re-check
          // dims + bytes before trusting the (injectable) scaler's output.
          const scaled = await runScaler(deps.scaler, raw, limits, log);
          if (!scaled) return degrade(ref, boundary.alt);
          raw = scaled;
        }
      }

      // Byte cap is enforced AFTER any scaling: a scaled image may now fit, while an unscaled image
      // (in-dims but heavy, or unknown-dims) is capped exactly as before.
      if (raw.size > limits.maxBytes) {
        log("feishu image: over size limit; degrading");
        return degrade(ref, boundary.alt);
      }

      let res: { imgKey?: string; error?: string };
      try {
        res = await deps.upload(raw);
      } catch {
        log("feishu image: upload error; degrading");
        return degrade(ref, boundary.alt);
      }
      if (!res.imgKey) {
        log("feishu image: upload failed; degrading"); // res.error intentionally NOT logged
        return degrade(ref, boundary.alt);
      }
      cache.set(key, res.imgKey);
      return { kind: "image", imgKey: res.imgKey };
    },
  };
}

/** Run the injectable scaler on an oversize-but-salvageable image and validate its output. Returns the
 *  scaled RawImage (guaranteed within the dim + byte limits), or null to degrade — when there is no
 *  scaler, the scaler returns null / throws, or its output is still out of range (never trust an
 *  injectable scaler blindly). Zero-leak: every log is a generic status, never bytes/ref/path. */
async function runScaler(scaler: ImageScaler | undefined, raw: RawImage, limits: ImageLimits, log: (m: string) => void): Promise<RawImage | null> {
  if (!scaler) {
    log("feishu image: oversize and no scaler; degrading");
    return null;
  }
  let scaled: ScaleResult | null;
  try {
    scaled = await scaler({ bytes: raw.bytes, contentType: raw.contentType, maxWidth: limits.maxWidth, maxHeight: limits.maxHeight, maxBytes: limits.maxBytes, maxAspect: limits.maxAspect });
  } catch {
    log("feishu image: scale error; degrading");
    return null;
  }
  if (!scaled) {
    log("feishu image: scale failed; degrading");
    return null;
  }
  const sd = imageDims(scaled.bytes, scaled.contentType) ?? { w: scaled.width, h: scaled.height };
  const stillOver =
    (limits.maxWidth > 0 && sd.w > limits.maxWidth) ||
    (limits.maxHeight > 0 && sd.h > limits.maxHeight) ||
    scaled.bytes.length > limits.maxBytes;
  if (stillOver) {
    log("feishu image: scaled image still out of range; degrading");
    return null;
  }
  return { bytes: scaled.bytes, contentType: scaled.contentType, size: scaled.bytes.length, mtimeMs: raw.mtimeMs };
}

/** The card `img` element JSON for a resolved image_key. */
export function imageElement(elementId: string, imgKey: string, alt: string): Record<string, unknown> {
  return { tag: "img", element_id: elementId, img_key: imgKey, alt: { tag: "plain_text", content: alt || "image" } };
}

/** A markdown element JSON (used to swap a placeholder into a degrade link/text). */
export function markdownElement(elementId: string, content: string): Record<string, unknown> {
  return { tag: "markdown", element_id: elementId, content };
}

function cacheKey(ref: ArtifactRef, raw: RawImage): string {
  return `${ref.mesh}|${ref.owner}|${ref.file}|${raw.size}|${raw.mtimeMs}`;
}

function mdEscape(s: string): string {
  return s.replace(/[\[\]()]/g, "\\$&");
}

// ── real B1 adapters (in-process; the channel shares the backend's storage root) ───────────────

/** Read an artifact image off disk (B1) for the resolver. Reuses the same path-safe, magic-byte-checked,
 *  ≤5MB reader the web API uses (resolveArtifactFile); adds the mtime for the cache key. Returns null when
 *  the file is missing / unreadable / not a valid raster image. Never logs the bytes or the path. */
export function readArtifactImage(root: string): (ref: ArtifactRef) => Promise<RawImage | null> {
  return async (ref) => {
    try {
      const file = await resolveArtifactFile(root, ref.mesh, ref.owner, ref.file);
      const st = await stat(file.path);
      return { bytes: file.bytes, contentType: file.contentType, size: file.bytes.length, mtimeMs: st.mtimeMs };
    } catch (e) {
      if (e instanceof AgentFileError) return null; // not found / traversal / too big / wrong magic
      throw e;
    }
  };
}

/** Upload bytes to Feishu via `im.v1.image.create` → image_key. Errors are returned (not thrown) so the
 *  resolver degrades cleanly; the error string is generic (no bytes, no key). */
export function sdkUploadImage(client: lark.Client): (img: RawImage) => Promise<{ imgKey?: string; error?: string }> {
  return async (img) => {
    try {
      const res = await client.im.v1.image.create({
        data: { image_type: "message", image: Readable.from(Buffer.from(img.bytes)) as unknown as any },
      });
      const imgKey = res?.image_key;
      return imgKey ? { imgKey } : { error: "upload-failed" }; // generic/classified — never raw SDK text
    } catch {
      return { error: "upload-error" }; // never a raw SDK/Error message (could carry a path/secret)
    }
  };
}

/** Neutral padding background for a no-alpha output (JPEG/GIF): Feishu's light-surface gray `#ebedf0`,
 *  fully opaque. PNG uses transparent (`0x00000000`) padding so the card background shows through. */
const PAD_NEUTRAL_RGBA = 0xebedf0ff;
const PAD_TRANSPARENT_RGBA = 0x00000000;

/** jimp-backed downscaler + aspect letterbox-pad (pure JS; bundles into `bun build --compile`, no native
 *  build, no external binary). Decodes the image, fits it inside (maxWidth, maxHeight) preserving aspect;
 *  then, if it is still too tall (`h/w > maxAspect`), letterbox-pads it horizontally onto a wider neutral
 *  canvas (PNG → transparent, JPEG/GIF → `#ebedf0`) so the aspect becomes ≤ maxAspect, re-fitting if the
 *  padded canvas exceeds maxWidth/maxHeight. Re-encodes in the SAME container (PNG keeps alpha; JPEG stays
 *  JPEG with ONE lower-quality retry if still over maxBytes — PNG never re-quantized / converted). Returns
 *  null on undecodable bytes, an unsupported container, or if it still can't get under maxBytes (→ the
 *  resolver degrades). Never throws; never logs the bytes. */
export function jimpScaler(): ImageScaler {
  return async (req) => {
    try {
      const mime = encodeContainer(req.contentType);
      if (!mime) return null; // only PNG/JPEG/GIF have a container we re-encode to
      let img = await Jimp.read(Buffer.from(req.bytes));
      const w = img.bitmap.width, h = img.bitmap.height;
      const f = Math.min(
        req.maxWidth > 0 ? req.maxWidth / w : 1,
        req.maxHeight > 0 ? req.maxHeight / h : 1,
        1,
      );
      const tw = Math.max(1, Math.floor(w * f)), th = Math.max(1, Math.floor(h * f));
      if (tw < w || th < h) img.resize({ w: tw, h: th });

      // Aspect letterbox-pad: still too tall after fit-scaling → widen onto a neutral canvas so
      // height/width ≤ maxAspect, then re-fit if the wider canvas now exceeds maxWidth/maxHeight.
      const cw = img.bitmap.width, ch = img.bitmap.height;
      if (req.maxAspect > 0 && ch / cw > req.maxAspect) {
        const paddedW = Math.ceil(ch / req.maxAspect); // ch/paddedW ≤ maxAspect; always > cw (we widen)
        // jimp types `new Jimp(...)` and `Jimp.read()` as nominally-distinct instances; both are real Jimp
        // objects at runtime, so cast the canvas to the read-result type to keep one `img` variable.
        const canvas = new Jimp({ width: paddedW, height: ch, color: mime === "image/png" ? PAD_TRANSPARENT_RGBA : PAD_NEUTRAL_RGBA }) as unknown as typeof img;
        canvas.composite(img, Math.floor((paddedW - cw) / 2), 0); // center horizontally
        const pf = Math.min(
          req.maxWidth > 0 ? req.maxWidth / paddedW : 1,
          req.maxHeight > 0 ? req.maxHeight / ch : 1,
          1,
        );
        if (pf < 1) canvas.resize({ w: Math.max(1, Math.floor(paddedW * pf)), h: Math.max(1, Math.floor(ch * pf)) }); // aspect preserved → still ≤ maxAspect
        img = canvas;
      }

      let bytes = await encodeImage(img, mime, 90);
      if (mime === "image/jpeg" && bytes.length > req.maxBytes) {
        bytes = await encodeImage(img, mime, 60); // one quality retry (JPEG only)
      }
      if (bytes.length > req.maxBytes) return null; // still too big → degrade (no PNG→JPEG conversion)
      return { bytes, contentType: mime, width: img.bitmap.width, height: img.bitmap.height };
    } catch {
      return null; // undecodable / encode failure → degrade cleanly, no leak
    }
  };
}

type EncodeMime = "image/png" | "image/jpeg" | "image/gif";
function encodeContainer(ct: string): EncodeMime | null {
  if (ct.includes("png")) return "image/png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "image/jpeg";
  if (ct.includes("gif")) return "image/gif";
  return null;
}
async function encodeImage(img: Awaited<ReturnType<typeof Jimp.read>>, mime: EncodeMime, quality: number): Promise<Uint8Array> {
  const buf = mime === "image/jpeg" ? await img.getBuffer(mime, { quality }) : await img.getBuffer(mime);
  return new Uint8Array(buf);
}

/** Build a device-auth console VIEWER URL from a base origin, or undefined when none is configured (→
 *  the resolver degrades to plain text instead of a link). This is the web console SPA route
 *  (`/mesh/<mesh>/agent/<agent>/artifact/<path>`, see FileViewer.parseFileRoute) — NOT the raw `/api`
 *  fetch endpoint, which would need a bearer token a Feishu link can't carry. The console opens the
 *  route and fetches the artifact with the user's device token. */
export function consoleViewerUrl(base: string | undefined): ((ref: ArtifactRef) => string | undefined) | undefined {
  if (!base) return undefined;
  const origin = base.replace(/\/+$/, "");
  return (ref) => `${origin}/mesh/${encodeURIComponent(ref.mesh)}/agent/${encodeURIComponent(ref.owner)}/artifact/${ref.file.split("/").map(encodeURIComponent).join("/")}`;
}

// ── minimal raster dimension readers (PNG / JPEG / GIF) ─────────────────────────
// Best-effort: returns null for formats we can't cheaply parse (e.g. WebP) → the aspect check is skipped
// and Feishu's own upload validation is the backstop (an upload reject degrades to link/text).
export function imageDims(bytes: Uint8Array, contentType: string): { w: number; h: number } | null {
  if (contentType.includes("png") || (bytes[0] === 0x89 && bytes[1] === 0x50)) return pngDims(bytes);
  if (contentType.includes("gif") || (bytes[0] === 0x47 && bytes[1] === 0x49)) return gifDims(bytes);
  if (contentType.includes("jpeg") || contentType.includes("jpg") || (bytes[0] === 0xff && bytes[1] === 0xd8)) return jpegDims(bytes);
  return null;
}

function pngDims(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 24) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

function gifDims(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 10) return null;
  return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) };
}

function jpegDims(b: Uint8Array): { w: number; h: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry the frame size
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      const h = (b[i + 5] << 8) | b[i + 6];
      const w = (b[i + 7] << 8) | b[i + 8];
      return { w, h };
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}
