import { lstat, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { sniffImage } from "./uploads";

export const MAX_AGENT_FILE_BYTES = 5 * 1024 * 1024;

const MARKDOWN = new Set([".md", ".markdown"]);
const RASTER_IMAGES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const TEXT = new Set([".txt", ".log", ".json", ".csv", ".yaml", ".yml", ".toml"]);
const CODE = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp", ".html", ".css", ".sh", ".sql"]);

export const extensionWhitelist = new Set([...MARKDOWN, ...RASTER_IMAGES, ".svg", ...TEXT, ...CODE]);

export class AgentFileError extends Error {
  constructor(public code: "enotfound" | "traversal" | "symlink" | "toobig", message = code) {
    super(message);
    this.name = "AgentFileError";
  }
}

export interface ResolvedAgentFile {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

export function pickContentType(ext: string): string | undefined {
  const e = ext.toLowerCase();
  if (MARKDOWN.has(e)) return "text/markdown; charset=utf-8";
  if (e === ".png") return "image/png";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".gif") return "image/gif";
  if (e === ".webp") return "image/webp";
  if (e === ".svg") return "image/svg+xml";
  if (TEXT.has(e) || CODE.has(e)) return "text/plain; charset=utf-8";
  return undefined;
}

export async function resolveAgentFile(cwd: string, relPath: string): Promise<ResolvedAgentFile> {
  const base = resolve(cwd);
  const decoded = decodeRelPath(relPath);
  const full = resolve(base, decoded);
  if (!isInside(base, full)) throw new AgentFileError("traversal");

  const ext = extname(full).toLowerCase();
  const contentType = pickContentType(ext);
  if (!contentType) throw new AgentFileError("enotfound");

  const rel = relative(base, full);
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  let cur = base;
  try {
    for (const part of parts) {
      cur = resolve(cur, part);
      const st = await lstat(cur);
      if (st.isSymbolicLink()) throw new AgentFileError("symlink");
      if (cur === full) {
        if (!st.isFile()) throw new AgentFileError("enotfound");
        if (st.size > MAX_AGENT_FILE_BYTES) throw new AgentFileError("toobig");
      }
    }
  } catch (err) {
    if (err instanceof AgentFileError) throw err;
    throw new AgentFileError("enotfound");
  }

  const bytes = new Uint8Array(await readFile(full));
  if (RASTER_IMAGES.has(ext)) {
    const sniffed = sniffImage(bytes);
    if (!sniffed || sniffed.mimeType !== contentType) throw new AgentFileError("enotfound");
  }
  return { path: full, bytes, contentType };
}

function decodeRelPath(relPath: string): string {
  try {
    const decoded = decodeURIComponent(relPath);
    if (decoded.includes("\0")) throw new AgentFileError("traversal");
    return decoded;
  } catch (err) {
    if (err instanceof AgentFileError) throw err;
    throw new AgentFileError("traversal");
  }
}

function isInside(base: string, full: string): boolean {
  return full === base || full.startsWith(base.endsWith(sep) ? base : base + sep);
}
