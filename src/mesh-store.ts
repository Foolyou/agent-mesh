// src/mesh-store.ts
// Persists mesh definitions as .mesh/meshes/<name>.json. Only definitions are
// persisted; running state never survives a parent-process restart.
import { mkdir, readFile, writeFile, readdir, unlink, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateMeshConfig } from "./mesh-validate";
import { normalizeMeshEdges, type MeshConfig } from "./acp/types";

export class MeshStore {
  constructor(private dir = resolve(process.cwd(), ".mesh", "meshes")) {}

  /** Map a mesh name to its file path, rejecting anything that could escape the
   *  store directory (path traversal). The filesystem boundary, independent of
   *  any caller-side validation. */
  private fileFor(name: string): string {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.includes("..")) {
      throw new Error(`invalid mesh name: ${JSON.stringify(name)}`);
    }
    return join(this.dir, `${name}.json`);
  }

  async define(config: MeshConfig): Promise<void> {
    const normalized = { ...config, edges: normalizeMeshEdges((config as any).edges) };
    validateMeshConfig(normalized);
    const path = this.fileFor(normalized.name);
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `.${normalized.name}.${process.pid}.${Date.now()}.tmp`);
    try {
      await writeFile(tmp, JSON.stringify(normalized, null, 2), "utf8");
      await rename(tmp, path);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  async delete(name: string): Promise<void> {
    const path = this.fileFor(name);
    try {
      await unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async load(): Promise<MeshConfig[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    // FILES only — a directory named `<name>.json` is not a mesh config (and reading it as a file would
    // throw EISDIR). The watcher relies on this to never provision a group for a directory.
    const names = entries.filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => e.name).sort();
    const out: MeshConfig[] = [];
    for (const f of names) {
      const parsed = JSON.parse(await readFile(join(this.dir, f), "utf8")) as MeshConfig;
      out.push({ ...parsed, edges: normalizeMeshEdges((parsed as any).edges) });
    }
    return out;
  }
}
