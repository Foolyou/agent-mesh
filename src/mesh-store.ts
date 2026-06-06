// src/mesh-store.ts
// Persists mesh definitions as .mesh/meshes/<name>.json. Only definitions are
// persisted; running state never survives a parent-process restart.
import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateMeshConfig } from "./mesh-validate";
import type { MeshConfig } from "./acp/types";

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
    validateMeshConfig(config);
    const path = this.fileFor(config.name);
    await mkdir(this.dir, { recursive: true });
    await writeFile(path, JSON.stringify(config, null, 2), "utf8");
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
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: MeshConfig[] = [];
    for (const f of files.filter((f) => f.endsWith(".json")).sort()) {
      out.push(JSON.parse(await readFile(join(this.dir, f), "utf8")) as MeshConfig);
    }
    return out;
  }
}
