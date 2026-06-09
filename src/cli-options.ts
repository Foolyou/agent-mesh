import { HARNESSES } from "./harness";
import type { HarnessId } from "./acp/types";

export const DEFAULT_MASTER_HARNESS: HarnessId = "codex";

function argVal(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function parseMasterHarness(args: string[], env: Record<string, string | undefined> = process.env): HarnessId {
  const raw = argVal(args, "--master-harness") ?? env.MESH_MASTER_HARNESS ?? DEFAULT_MASTER_HARNESS;
  if (raw in HARNESSES) return raw as HarnessId;
  throw new Error(`invalid master harness "${raw}" (use ${Object.keys(HARNESSES).join("|")})`);
}

export function masterHarnessPassthrough(harness: HarnessId): string[] {
  return ["--master-harness", harness];
}
