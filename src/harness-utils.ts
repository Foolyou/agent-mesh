import type { HarnessId, ThinkingEffort } from "./acp/types";

export interface RuntimeEffortConfig {
  configId: string;
  value: string;
}

export function runtimeEffortConfig(harness: HarnessId, effort?: ThinkingEffort): RuntimeEffortConfig | undefined {
  if (!effort) return undefined;
  if (harness === "claude") return { configId: "thought_level", value: effort };
  if (harness === "kimi") return { configId: "thinking", value: effort === "minimal" || effort === "low" ? "off" : "on" };
  return undefined;
}
