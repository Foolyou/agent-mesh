// Registry mapping a harness id to the command that launches it as an ACP agent.
import type { HarnessId } from "./acp/types";

export interface HarnessSpec {
  command: string;
  args: string[];
}

export const HARNESSES: Record<HarnessId, HarnessSpec> = {
  codex: { command: "codex-acp", args: [] },
  opencode: { command: "opencode", args: ["acp"] },
  claude: { command: "claude-agent-acp", args: [] },
};

export function resolveHarness(id: HarnessId): HarnessSpec {
  const spec = HARNESSES[id];
  if (!spec) throw new Error(`unknown harness: ${id}`);
  return spec;
}
