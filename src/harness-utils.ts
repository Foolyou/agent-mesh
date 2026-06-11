import type { HarnessId, SessionEffort, ThinkingEffort } from "./acp/types";

export const ALL_THINKING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ThinkingEffort[];

export interface HarnessEffortCapability {
  options: readonly ThinkingEffort[];
  runtimeSwitchable: boolean;
}

export const HARNESS_EFFORT_CAPABILITIES: Record<HarnessId, HarnessEffortCapability> = {
  codex: { options: ["low", "medium", "high", "xhigh"], runtimeSwitchable: false },
  claude: { options: ["minimal", "low", "medium", "high"], runtimeSwitchable: true },
  kimi: { options: ["low", "high"], runtimeSwitchable: true },
  opencode: { options: [], runtimeSwitchable: false },
};

export interface RuntimeEffortConfig {
  configId: string;
  value: string;
}

export interface RuntimeEffortOptions {
  configId: string;
  current: string;
  available: SessionEffort[];
  values?: Partial<Record<string, string>>;
}

export function effortOptionsForHarness(harness: HarnessId): readonly ThinkingEffort[] {
  return HARNESS_EFFORT_CAPABILITIES[harness]?.options ?? [];
}

export function supportedEffortsForConfig(harness: HarnessId): readonly ThinkingEffort[] {
  return effortOptionsForHarness(harness);
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

function configOptionsOf(session: unknown): any[] {
  return Array.isArray((session as any)?.configOptions) ? (session as any).configOptions : [];
}

function advertisedOptions(option: any): SessionEffort[] {
  return Array.isArray(option?.options)
    ? option.options
        .map((o: any) => {
          const id = String(o?.value ?? o?.id ?? "");
          if (!id) return undefined;
          const item: SessionEffort = { id, name: String(o?.name ?? o?.value ?? o?.id ?? id) };
          if (o?.description !== undefined) item.description = String(o.description);
          return item;
        })
        .filter(Boolean) as SessionEffort[]
    : [];
}

function findConfigOption(session: unknown, predicate: (option: any) => boolean): any | undefined {
  return configOptionsOf(session).find(predicate);
}

export function runtimeEffortOptionsFromSession(harness: HarnessId, session: unknown): RuntimeEffortOptions | undefined {
  if (harness === "claude") {
    const option = findConfigOption(session, (o) => o?.category === "effort" || o?.id === "thought_level" || o?.id === "output_config.effort");
    const available = advertisedOptions(option);
    if (!option || available.length === 0) return undefined;
    return { configId: String(option.id ?? "thought_level"), current: String(option.currentValue ?? option.current_value ?? option.current ?? available[0]?.id ?? ""), available };
  }
  if (harness === "kimi") {
    const option = findConfigOption(session, (o) => o?.id === "thinking" || o?.category === "thinking" || (o?.category === "effort" && o?.id === "thinking"));
    const raw = advertisedOptions(option);
    if (!option || raw.length === 0) return undefined;
    const off = raw.find((o) => /^(off|disabled|false|0)$/i.test(o.id)) ?? raw.find((o) => /off|disable/i.test(o.name)) ?? raw[0];
    const on = raw.find((o) => /^(on|enabled|true|1)$/i.test(o.id)) ?? raw.find((o) => /on|enable/i.test(o.name)) ?? raw.find((o) => o.id !== off?.id) ?? raw[1];
    if (!off || !on) return undefined;
    const currentRaw = String(option.currentValue ?? option.current_value ?? option.current ?? on.id);
    return {
      configId: String(option.id ?? "thinking"),
      current: currentRaw === off.id ? "low" : "high",
      available: [{ id: "low", name: "low" }, { id: "high", name: "high" }],
      values: { low: off.id, high: on.id },
    };
  }
  return undefined;
}

export function runtimeEffortConfig(harness: HarnessId, effort?: string, runtime?: string | RuntimeEffortOptions): RuntimeEffortConfig | undefined {
  if (!effort) return undefined;
  const advertised = typeof runtime === "object" ? runtime : undefined;
  if (advertised && !advertised.available.some((o) => o.id === effort)) return undefined;
  if (!advertised && !isEffortSupportedByHarness(harness, effort as ThinkingEffort)) return undefined;
  const advertisedConfigId = typeof runtime === "string" ? runtime : runtime?.configId;
  if (harness === "claude") return { configId: advertisedConfigId ?? "thought_level", value: effort };
  if (harness === "kimi") return { configId: advertisedConfigId ?? "thinking", value: (typeof runtime === "object" ? runtime.values?.[effort] : undefined) ?? (effort === "low" ? "off" : "on") };
  return undefined;
}
