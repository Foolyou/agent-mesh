// Registry mapping a harness id to the command that launches it as an ACP agent.
import type { AgentConfig, HarnessId } from "./acp/types";

export interface HarnessSpec {
  command: string;
  args: string[];
  /** The underlying body tool whose version differs from the ACP adapter (e.g. codex-acp adapter
   *  vs the `codex` CLI). Only set where adapter ≠ body; opencode/kimi launch the tool directly so
   *  there is no separate body. Used for display-only body-version probing (`<toolCommand> --version`). */
  toolCommand?: string;
}

export const HARNESSES: Record<HarnessId, HarnessSpec> = {
  codex: { command: "codex-acp", args: [], toolCommand: "codex" },
  opencode: { command: "opencode", args: ["acp"] },
  claude: { command: "claude-agent-acp", args: [], toolCommand: "claude" },
  kimi: { command: "kimi", args: ["acp"] },
};

export function resolveHarness(id: HarnessId): HarnessSpec {
  const spec = HARNESSES[id];
  if (!spec) throw new Error(`unknown harness: ${id}`);
  return spec;
}

/** Resolve the spawn command/args/env for an agent, applying its thinking effort per harness:
 *  - codex: `-c model_reasoning_effort=<effort>` (defaults to "low" for responsiveness)
 *  - claude: NO spawn-time effort — aligned with Zed, effort is passed as an enum through
 *    the runtime ACP effort config option (control-plane applies the configured effort
 *    right after session init). The old `MAX_THINKING_TOKENS` token-budget mapping is
 *    dropped: it could not express xhigh/max and diverged from Zed's enum passthrough.
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
    // set via `mode` and switchable live over ACP — no spawn flag needed. Effort is applied
    // at runtime via the ACP effort config option, not a spawn-time env.
    return { command: spec.command, args: spec.args, env: {} };
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
