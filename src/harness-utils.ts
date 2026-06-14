import type { HarnessId, SessionEffort, ThinkingEffort } from "./acp/types";

export const ALL_THINKING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingEffort[];

export interface HarnessEffortCapability {
  options: readonly ThinkingEffort[];
  runtimeSwitchable: boolean;
}

export const HARNESS_EFFORT_CAPABILITIES: Record<HarnessId, HarnessEffortCapability> = {
  codex: { options: ["low", "medium", "high", "xhigh"], runtimeSwitchable: false },
  // Aligns with Zed's Anthropic effort set (low|medium|high|xhigh|max, capability-driven,
  // no `minimal`). Runtime-switchable via the ACP effort config option.
  claude: { options: ["low", "medium", "high", "xhigh", "max"], runtimeSwitchable: true },
  // Kimi has NO reasoning-effort ladder — its "thinking" is a binary mode toggled via the
  // SESSION MODEL variant (see the thinking-toggle helpers below), not a reasoning effort.
  kimi: { options: [], runtimeSwitchable: false },
  opencode: { options: [], runtimeSwitchable: false },
};

// ── Kimi thinking toggle ──────────────────────────────────────────────────────
// Kimi exposes "thinking" as an on/off mode, not an effort level. It is switched by
// selecting the base session model vs its `,thinking` variant via ACP `session/set_model`
// (NOT `setConfigOption("thinking")`), so it rides the existing model-persistence path.
export const KIMI_THINKING_SUFFIX = ",thinking";

/** Harnesses whose "thinking" is a binary toggle (distinct from a reasoning-effort set). */
export function supportsThinkingToggle(harness: HarnessId): boolean {
  return harness === "kimi";
}

/** True when a kimi model id selects the thinking variant (`<base>,thinking`). */
export function kimiThinkingEnabled(model: string | undefined): boolean {
  return typeof model === "string" && model.trim().toLowerCase().endsWith(KIMI_THINKING_SUFFIX);
}

/** The base kimi model id with any `,thinking` variant suffix stripped. */
export function kimiBaseModel(model: string): string {
  const m = model.trim();
  return kimiThinkingEnabled(m) ? m.slice(0, m.length - KIMI_THINKING_SUFFIX.length).trimEnd() : m;
}

/** Resolve the kimi model id for a desired thinking state, preserving the base model. */
export function kimiModelForThinking(model: string, on: boolean): string {
  const base = kimiBaseModel(model);
  return on ? `${base}${KIMI_THINKING_SUFFIX}` : base;
}

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
    // The installed Claude ACP wrapper advertises the effort option as
    // `{ id: "effort", category: "thought_level" }`. Match that real shape AND the legacy
    // aliases (`category: "effort"`, `id: "thought_level"`, `id: "output_config.effort"`)
    // so discovery works across wrapper versions; before this, none matched and discovery
    // fell back to the stale static list, capping the picker at the static set.
    const option = findConfigOption(
      session,
      (o) =>
        o?.id === "effort" ||
        o?.id === "thought_level" ||
        o?.id === "output_config.effort" ||
        o?.category === "effort" ||
        o?.category === "thought_level",
    );
    const available = advertisedOptions(option);
    if (!option || available.length === 0) return undefined;
    // Forward the option's REAL id (e.g. "effort") so setConfigOption targets the right key.
    return { configId: String(option.id ?? "thought_level"), current: String(option.currentValue ?? option.current_value ?? option.current ?? available[0]?.id ?? ""), available };
  }
  // Kimi no longer advertises a runtime EFFORT config option — its thinking on/off is a
  // model variant (handled via setModel + the kimi thinking-toggle helpers above), so it is
  // intentionally not surfaced here.
  return undefined;
}

export function runtimeEffortConfig(harness: HarnessId, effort?: string, runtime?: string | RuntimeEffortOptions): RuntimeEffortConfig | undefined {
  if (!effort) return undefined;
  const advertised = typeof runtime === "object" ? runtime : undefined;
  if (advertised && !advertised.available.some((o) => o.id === effort)) return undefined;
  if (!advertised && !isEffortSupportedByHarness(harness, effort as ThinkingEffort)) return undefined;
  const advertisedConfigId = typeof runtime === "string" ? runtime : runtime?.configId;
  if (harness === "claude") return { configId: advertisedConfigId ?? "thought_level", value: effort };
  // kimi has no effort config option — its thinking toggle is a model variant, not effort.
  return undefined;
}
