import { createPtyBackend, type PtyBackend, type PtyBackendOpts } from "./os-shim";

export type { PtyBackend };

export async function spawnScriptPty(input: PtyBackendOpts): Promise<PtyBackend> {
  return createPtyBackend(input);
}
