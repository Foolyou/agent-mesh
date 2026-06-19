import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { PromptImageRef } from "../acp/types";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_COUNT = 5;
const ALLOWED_BUCKET = /^[A-Za-z0-9._-]+$/;

export interface UploadFileLike {
  name?: string;
  type?: string;
  size?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface StoredUpload extends PromptImageRef {
  url: string;
}

export function assertSafeBucket(bucket: string): void {
  if (!bucket || bucket === "." || bucket === ".." || !ALLOWED_BUCKET.test(bucket)) {
    throw new Error("invalid upload bucket");
  }
}

export function uploadRoot(root: string): string {
  return join(root, "uploads");
}

export function uploadPath(root: string, bucket: string, id: string): string {
  assertSafeBucket(bucket);
  if (!/^[0-9a-f-]+\.(png|jpg|jpeg|gif|webp)$/i.test(id)) throw new Error("invalid upload id");
  const base = resolve(uploadRoot(root), bucket);
  const full = resolve(base, id);
  if (!full.startsWith(base.endsWith(sep) ? base : base + sep)) throw new Error("invalid upload path");
  return full;
}

export function sniffImage(bytes: Uint8Array): { mimeType: string; ext: string } | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { mimeType: "image/png", ext: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mimeType: "image/jpeg", ext: "jpg" };
  if (bytes.length >= 6) {
    const sig = String.fromCharCode(...bytes.slice(0, 6));
    if (sig === "GIF87a" || sig === "GIF89a") return { mimeType: "image/gif", ext: "gif" };
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(...bytes.slice(0, 4));
    const webp = String.fromCharCode(...bytes.slice(8, 12));
    if (riff === "RIFF" && webp === "WEBP") return { mimeType: "image/webp", ext: "webp" };
  }
  return undefined;
}

export async function storeUploads(root: string, bucket: string, files: UploadFileLike[]): Promise<StoredUpload[]> {
  assertSafeBucket(bucket);
  if (files.length === 0) throw new Error("no upload files");
  if (files.length > MAX_UPLOAD_COUNT) throw new Error(`too many images (max ${MAX_UPLOAD_COUNT})`);

  const out: StoredUpload[] = [];
  const dir = join(uploadRoot(root), bucket);
  await mkdir(dir, { recursive: true });
  for (const file of files) {
    if ((file.name ?? "").toLowerCase().endsWith(".svg") || file.type === "image/svg+xml") throw new Error("SVG images are not allowed");
    if ((file.size ?? 0) > MAX_UPLOAD_BYTES) throw new Error("image is too large");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("image is too large");
    const sniffed = sniffImage(bytes);
    if (!sniffed) throw new Error("unsupported image type");
    const id = `${randomUUID()}.${sniffed.ext}`;
    await writeFile(join(dir, id), bytes);
    out.push({
      id,
      url: `/api/uploads/${encodeURIComponent(bucket)}/${encodeURIComponent(id)}`,
      mimeType: sniffed.mimeType,
      name: basename(file.name || `image.${sniffed.ext}`),
      bucket,
      path: join(dir, id),
    });
  }
  return out;
}

export async function readUpload(root: string, bucket: string, id: string): Promise<{ bytes: Uint8Array; mimeType: string; name: string }> {
  const full = uploadPath(root, bucket, id);
  const bytes = new Uint8Array(await readFile(full));
  const sniffed = sniffImage(bytes);
  if (!sniffed) throw new Error("unsupported image type");
  return { bytes, mimeType: sniffed.mimeType, name: id };
}

export async function deleteUploadBucket(root: string | undefined, bucket: string): Promise<void> {
  if (!root) return;
  assertSafeBucket(bucket);
  await rm(join(uploadRoot(root), bucket), { recursive: true, force: true });
}
