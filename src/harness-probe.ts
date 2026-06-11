import type { HarnessId } from "./acp/types";
import { HARNESSES } from "./harness";

export interface HarnessProbeResult {
  id: HarnessId;
  installed: boolean;
}

export type WhichFn = (command: string) => string | null | undefined;

export function probeHarnesses(which: WhichFn = (command) => Bun.which(command)): HarnessProbeResult[] {
  return Object.entries(HARNESSES).map(([id, spec]) => ({
    id: id as HarnessId,
    installed: !!which(spec.command),
  }));
}
