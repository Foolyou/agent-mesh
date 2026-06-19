import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * Return the IPC endpoint used by one mesh host. Unix uses a filesystem socket under the
 * run dir; Windows needs a named pipe path instead of a normal filesystem path.
 */
export function meshSocketPath(runDir: string, meshName: string): string {
  if (process.platform !== "win32") return join(runDir, `${meshName}.sock`);
  const safeName = meshName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "mesh";
  const runHash = createHash("sha1").update(runDir).digest("hex").slice(0, 12);
  return String.raw`\\.\pipe\agent-mesh-${runHash}-${safeName}.sock`;
}

export function isWindowsNamedPipePath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.startsWith("\\\\.\\pipe\\") || lower.startsWith("\\\\?\\pipe\\");
}
