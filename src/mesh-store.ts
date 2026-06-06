// src/mesh-store.ts
// Persists mesh definitions as .mesh/meshes/<name>.json. Only definitions are
// persisted; running state never survives a parent-process restart.
import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateMeshConfig } from "./mesh-validate";
import type { MeshConfig } from "./acp/types";

export class MeshStore {
  constructor(private dir = resolve(process.cwd(), ".mesh", "meshes")) {}

  async define(config: MeshConfig): Promise<void> {
    validateMeshConfig(config);
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${config.name}.json`), JSON.stringify(config, null, 2), "utf8");
  }

  async delete(name: string): Promise<void> {
    try {
      await unlink(join(this.dir, `${name}.json`));
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
