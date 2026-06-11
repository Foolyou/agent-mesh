import type { HarnessId, ThinkingEffort } from "./acp/types";

export const ALL_THINKING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingEffort[];

export interface HarnessEffortCapability {
  options: readonly ThinkingEffort[];
  runtimeSwitchable: boolean;
}

export const HARNESS_EFFORT_CAPABILITIES: Record<HarnessId, HarnessEffortCapability> = {
  codex: { options: ["low", "medium", "high", "xhigh"], runtimeSwitchable: false },
  claude: { options: ["minimal", "low", "medium", "high", "max"], runtimeSwitchable: true },
  kimi: { options: ["low", "high"], runtimeSwitchable: true },
  opencode: { options: [], runtimeSwitchable: false },
};

export interface RuntimeEffortConfig {
  configId: string;
  value: string;
}

export function effortOptionsForHarness(harness: HarnessId): readonly ThinkingEffort[] {
  return HARNESS_EFFORT_CAPABILITIES[harness]?.options ?? [];
}

export function supportsRuntimeEffort(harness: HarnessId): boolean {
  return HARNESS_EFFORT_CAPABILITIES[harness]?.runtimeSwitchable === true;
}

export function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return typeof value === "string" && (ALL_THINKING_EFFORTS as readonly string[]).includes(value);
}

export function isEffortSupportedByHarness(harness: HarnessId, effort: ThinkingEffort): boolean {
  return effortOptionsForHarness(harness).includes(effort);
}

export function runtimeEffortConfig(harness: HarnessId, effort?: ThinkingEffort, advertisedConfigId?: string): RuntimeEffortConfig | undefined {
  if (!effort) return undefined;
  if (!isEffortSupportedByHarness(harness, effort)) return undefined;
  if (harness === "claude") return { configId: advertisedConfigId ?? "thought_level", value: effort };
  if (harness === "kimi") return { configId: "thinking", value: effort === "low" ? "off" : "on" };
  return undefined;
}
