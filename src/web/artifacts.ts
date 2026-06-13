import { lstat, realpath, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { AgentFileError, resolveAgentFile, type ResolvedAgentFile } from "./agent-files";

export function artifactRoot(root: string): string {
  return join(root, "artifacts");
}

export function assertSafeArtifactName(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("..") || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`invalid artifact name: ${JSON.stringify(name)}`);
  }
}

export function artifactAgentDir(root: string, mesh: string, agent: string): string {
  assertSafeArtifactName(mesh);
  assertSafeArtifactName(agent);
  const base = resolve(artifactRoot(root));
  const full = resolve(base, mesh, agent);
  if (!isInside(base, full)) throw new Error("invalid artifact path");
  return full;
}

export async function deleteArtifactMesh(root: string | undefined, mesh: string): Promise<void> {
  if (!root) return;
  assertSafeArtifactName(mesh);
  const base = resolve(artifactRoot(root));
  const full = resolve(base, mesh);
  if (!isInside(base, full)) throw new Error("invalid artifact path");
  await rm(full, { recursive: true, force: true });
}

export async function resolveArtifactFile(root: string, mesh: string, agent: string, relPath: string): Promise<ResolvedAgentFile> {
  const base = artifactAgentDir(root, mesh, agent);
  try {
    const st = await lstat(base);
    if (st.isSymbolicLink()) throw new AgentFileError("symlink");
    if (!st.isDirectory()) throw new AgentFileError("enotfound");
  } catch (err: any) {
    if (err instanceof AgentFileError) throw err;
    if (err?.code === "ENOENT") throw new AgentFileError("enotfound");
    throw err;
  }
  const file = await resolveAgentFile(base, relPath, { fuzzyBasename: false });
  const baseReal = await realpath(base);
  const fullReal = await realpath(file.path);
  if (!isInside(baseReal, fullReal)) throw new AgentFileError("symlink");
  return file;
}

function isInside(base: string, full: string): boolean {
  return full === base || full.startsWith(base.endsWith(sep) ? base : base + sep);
}
