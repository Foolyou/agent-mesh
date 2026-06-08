// Registry mapping a harness id to the command that launches it as an ACP agent.
import type { AgentConfig, HarnessId, ThinkingEffort } from "./acp/types";

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

// Permission/session modes each harness advertises (the full known set, used as the create-time
// validation allowlist; the agent re-advertises the authoritative list at runtime). An empty list
// = no selectable modes. Applied best-effort via setSessionMode at start.
export const HARNESS_MODES: Record<HarnessId, string[]> = {
  claude: ["default", "acceptEdits", "plan", "bypassPermissions"],
  codex: ["read-only", "default", "full-access"],
  opencode: [],
};

// Modes that DISABLE permission prompts — i.e. the agent auto-runs every tool call (edits,
// shell) with no human approval. These are NOT offered in the builder (so a no-prompt session
// can't be pre-armed with one click, incl. via an LLM-generated config) and are rejected at
// create time unless the operator explicitly opts in with ALLOW_UNSAFE_MESH_MODES=1. The
// operator can still switch to them deliberately at runtime via the panel mode picker.
export const UNSAFE_MODES = new Set<string>(["bypassPermissions", "full-access"]);

/** Modes safe to advertise in the create/edit builder (prompts preserved). */
export function builderModesFor(id: HarnessId): string[] {
  return HARNESS_MODES[id].filter((m) => !UNSAFE_MODES.has(m));
}

// claude reads MAX_THINKING_TOKENS at session start; map the effort levels to token budgets.
const CLAUDE_THINK_TOKENS: Record<ThinkingEffort, number> = {
  minimal: 1024,
  low: 4096,
  medium: 12000,
  high: 24000,
};

/** Resolve the spawn command/args/env for an agent, applying its thinking effort per harness:
 *  - codex: `-c model_reasoning_effort=<effort>` (defaults to "low" for responsiveness)
 *  - claude: `MAX_THINKING_TOKENS` env (only when an effort is set; else the harness default)
 *  - opencode: no effort mechanism — ignored.
 *  Effort is a launch-time setting; changing it requires (re)starting the agent. */
export function spawnConfigFor(a: AgentConfig): { command: string; args: string[]; env: Record<string, string> } {
  const spec = resolveHarness(a.harness);
  if (a.harness === "codex") {
    const effort = a.effort ?? "low";
    return { command: spec.command, args: [...spec.args, "-c", `model_reasoning_effort=${effort}`], env: {} };
  }
  if (a.harness === "claude" && a.effort) {
    return { command: spec.command, args: spec.args, env: { MAX_THINKING_TOKENS: String(CLAUDE_THINK_TOKENS[a.effort]) } };
  }
  return { command: spec.command, args: spec.args, env: {} };
}
