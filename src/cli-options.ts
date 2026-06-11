import { HARNESSES } from "./harness";
import type { HarnessId } from "./acp/types";

export const DEFAULT_ASSISTANT_HARNESS: HarnessId = "codex";

function argVal(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function parseAssistantHarness(args: string[], env: Record<string, string | undefined> = process.env): HarnessId {
  const raw =
    argVal(args, "--assistant-harness") ??
    argVal(args, "--master-harness") ??
    env.MESH_ASSISTANT_HARNESS ??
    env.MESH_MASTER_HARNESS ??
    DEFAULT_ASSISTANT_HARNESS;
  if (raw in HARNESSES) return raw as HarnessId;
  throw new Error(`invalid assistant harness "${raw}" (use ${Object.keys(HARNESSES).join("|")})`);
}

export function noAssistantSelected(args: string[]): boolean {
  return args.includes("--no-assistant") || args.includes("--no-mesh-assistant") || args.includes("--no-master");
}

export function assistantCliDeprecationWarnings(args: string[], env: Record<string, string | undefined> = process.env): string[] {
  const warnings: string[] = [];
  if (args.includes("--no-mesh-assistant")) warnings.push("--no-mesh-assistant is deprecated; use --no-assistant");
  if (args.includes("--no-master")) warnings.push("--no-master is deprecated; use --no-assistant");
  if (argVal(args, "--master-harness") !== undefined) warnings.push("--master-harness is deprecated; use --assistant-harness");
  if (env.MESH_MASTER_HARNESS !== undefined) warnings.push("MESH_MASTER_HARNESS is deprecated; use MESH_ASSISTANT_HARNESS");
  return warnings;
}

export function assistantHarnessPassthrough(harness: HarnessId): string[] {
  return ["--assistant-harness", harness];
}
