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
  kimi: { command: "kimi", args: ["acp"] },
};

export function resolveHarness(id: HarnessId): HarnessSpec {
  const spec = HARNESSES[id];
  if (!spec) throw new Error(`unknown harness: ${id}`);
  return spec;
}

// claude reads MAX_THINKING_TOKENS at session start; map the effort levels to token budgets.
const CLAUDE_THINK_TOKENS: Record<Extract<ThinkingEffort, "minimal" | "low" | "medium" | "high">, number> = {
  minimal: 1024,
  low: 4096,
  medium: 12000,
  high: 24000,
};

/** Resolve the spawn command/args/env for an agent, applying its thinking effort per harness:
 *  - codex: `-c model_reasoning_effort=<effort>` (defaults to "low" for responsiveness)
 *  - claude: `MAX_THINKING_TOKENS` env (only when an effort is set; else the harness default)
 *  - opencode/kimi: no spawn-time effort mechanism — ignored.
 *  Some harnesses also support runtime switching via ACP config options. */
export function spawnConfigFor(a: AgentConfig): { command: string; args: string[]; env: Record<string, string> } {
  const spec = resolveHarness(a.harness);
  if (a.harness === "codex") {
    const effort = a.effort ?? "low";
    return { command: spec.command, args: [...spec.args, "-c", `model_reasoning_effort=${effort}`], env: {} };
  }
  if (a.harness === "claude") {
    // Permission level is a session mode (default / acceptEdits / bypassPermissions / …),
    // set via `mode` and switchable live over ACP — no spawn flag needed.
    const env: Record<string, string> = a.effort && a.effort in CLAUDE_THINK_TOKENS ? { MAX_THINKING_TOKENS: String(CLAUDE_THINK_TOKENS[a.effort as keyof typeof CLAUDE_THINK_TOKENS]) } : {};
    return { command: spec.command, args: spec.args, env };
  }
  if (a.harness === "opencode" && a.opencodePermission === "allow") {
    // opencode exposes no ACP permission mode — its permission policy is the
    // OPENCODE_PERMISSION env, applied only at spawn. It must be a permission map; a bare
    // JSON string ('"allow"') is rejected by opencode's schema (>= 1.16) and breaks
    // session/new. Use an explicit allow-all map to grant autonomous tool use.
    return { command: spec.command, args: spec.args, env: { OPENCODE_PERMISSION: '{"*":"allow"}' } };
  }
  return { command: spec.command, args: spec.args, env: {} };
}
