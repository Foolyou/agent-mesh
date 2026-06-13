import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { sniffImage } from "./uploads";

export const MAX_AGENT_FILE_BYTES = 5 * 1024 * 1024;

const MARKDOWN = new Set([".md", ".markdown"]);
const RASTER_IMAGES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const TEXT = new Set([".txt", ".log", ".json", ".csv", ".yaml", ".yml", ".toml"]);
const CODE = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp", ".html", ".css", ".sh", ".sql"]);

// SVG is intentionally excluded: serving image/svg+xml on the app origin allows
// embedded <script> to execute in our origin context (XSS) and the existing
// uploads pipeline already rejects SVG (src/web/uploads.ts:66). Match precedent.
export const extensionWhitelist = new Set([...MARKDOWN, ...RASTER_IMAGES, ...TEXT, ...CODE]);

export class AgentFileError extends Error {
  constructor(public code: "enotfound" | "traversal" | "symlink" | "toobig", message: string = code) {
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
  if (TEXT.has(e) || CODE.has(e)) return "text/plain; charset=utf-8";
  return undefined;
}

export async function resolveAgentFile(cwd: string, relPath: string, opts: { fuzzyBasename?: boolean } = {}): Promise<ResolvedAgentFile> {
  const base = resolve(cwd);
  const decoded = decodeRelPath(relPath);
  const fuzzyBasename = opts.fuzzyBasename ?? true;

  try {
    return await readExact(base, decoded);
  } catch (err) {
    // Agents emitted by LLMs frequently drop the subdir prefix and write `[name.md](name.md)`
    // even when the file lives at <cwd>/subdir/name.md. When the request is a bare basename
    // and the exact path is missing, do a bounded BFS inside the cwd to find a single file
    // with that basename. Any other error (traversal/symlink/toobig/wrong-magic-bytes) is
    // surfaced as-is — we never use the fallback to bypass a security or whitelist gate.
    if (!(err instanceof AgentFileError) || err.code !== "enotfound") throw err;
    if (!fuzzyBasename) throw err;
    if (!isBareBasename(decoded)) throw err;
    const ext = extname(decoded).toLowerCase();
    if (!pickContentType(ext)) throw err;
    const hit = await findByBasename(base, decoded);
    if (!hit) throw err;
    return await readExact(base, relative(base, hit));
  }
}

async function readExact(base: string, decoded: string): Promise<ResolvedAgentFile> {
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

// Names skipped during bare-basename fallback. These are noisy or sensitive trees that
// would explode the scan budget without ever holding agent-produced content we'd want
// to surface; .git additionally hides packed objects we don't want to leak by basename.
const FUZZY_SKIP_DIRS = new Set([".git", "node_modules", "dist", ".worktrees", ".cache", "target", ".next", ".turbo"]);
const FUZZY_MAX_DEPTH = 4;
const FUZZY_MAX_ENTRIES = 2000;

function isBareBasename(decoded: string): boolean {
  // No path separators after decode. `decoded` is already the URL-decoded request, so this
  // catches both `name.md` and intentional `./name.md` (which `resolve` normalises away
  // but the slash makes it look like a hint at a specific location — don't fuzz those).
  return !decoded.includes("/") && !decoded.includes("\\");
}

async function findByBasename(base: string, name: string): Promise<string | null> {
  const target = basename(name);
  let scanned = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: base, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.shift()!; // BFS so shallow matches win over deep ones
    if (scanned >= FUZZY_MAX_ENTRIES) return null;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      scanned++;
      if (scanned > FUZZY_MAX_ENTRIES) return null;
      if (e.isFile() && e.name === target) return resolve(dir, e.name);
    }
    if (depth >= FUZZY_MAX_DEPTH) continue;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".") || FUZZY_SKIP_DIRS.has(e.name)) continue;
      stack.push({ dir: resolve(dir, e.name), depth: depth + 1 });
    }
  }
  return null;
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
