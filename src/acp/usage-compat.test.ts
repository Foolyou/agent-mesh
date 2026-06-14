import { expect, test } from "bun:test";
import {
  lookupModelContextWindow,
  normalizeCommandName,
  parseAvailableCommands,
  parseTokenCount,
  parseUsageUpdate,
  resolveContextWindow,
} from "./usage-compat";

test("parseUsageUpdate reads codex usage_update", () => {
  expect(parseUsageUpdate({ sessionUpdate: "usage_update", used: 5337, size: 258400 })).toEqual({
    used: 5337,
    size: 258400,
    usagePercent: 5337 / 258400,
  });
});

test("parseUsageUpdate reads claude usage_update and ignores cost", () => {
  expect(parseUsageUpdate({ sessionUpdate: "usage_update", used: 120000, size: 200000, cost: { amount: 0.01, currency: "USD" } })).toEqual({
    used: 120000,
    size: 200000,
    usagePercent: 0.6,
  });
});

test("parseUsageUpdate carries a numeric cost when present", () => {
  expect(parseUsageUpdate({ sessionUpdate: "usage_update", used: 100, size: 1000, cost: 0.42 })).toEqual({
    used: 100,
    size: 1000,
    usagePercent: 0.1,
    cost: 0.42,
  });
});

test("lookupModelContextWindow maps Claude Opus/Sonnet to the Zed windows", () => {
  expect(lookupModelContextWindow("claude-opus-4-8")).toBe(1_000_000);
  expect(lookupModelContextWindow("claude-opus-4-5")).toBe(1_000_000);
  expect(lookupModelContextWindow("claude-opus-4-6")).toBe(1_000_000);
  expect(lookupModelContextWindow("claude-opus-4-7")).toBe(1_000_000);
  expect(lookupModelContextWindow("claude-sonnet-4")).toBe(1_000_000);
  expect(lookupModelContextWindow("claude-sonnet-4-5")).toBe(1_000_000);
  expect(lookupModelContextWindow("claude-sonnet-4-6")).toBe(1_000_000);
  // Opus 4.1 keeps the classic 200K window and must NOT match the 4.5-4.8 rule.
  expect(lookupModelContextWindow("claude-opus-4-1")).toBe(200_000);
});

test("lookupModelContextWindow is tolerant of separators/case and rejects unknowns", () => {
  expect(lookupModelContextWindow("Claude Opus 4.8")).toBe(1_000_000);
  expect(lookupModelContextWindow("anthropic/claude-opus-4-8")).toBe(1_000_000);
  // Boundary guard: a hypothetical "opus-4-10" must not be read as opus-4-1.
  expect(lookupModelContextWindow("claude-opus-4-10")).toBeNull();
  expect(lookupModelContextWindow("gpt-5-codex")).toBeNull();
  expect(lookupModelContextWindow(undefined)).toBeNull();
  expect(lookupModelContextWindow("")).toBeNull();
});

test("lookupModelContextWindow narrows the bare sonnet-4 rule to listed minors + base/dated ids", () => {
  // Listed minors stay 1M.
  expect(lookupModelContextWindow("claude-sonnet-4-5")).toBe(1_000_000);
  expect(lookupModelContextWindow("claude-sonnet-4-6")).toBe(1_000_000);
  // Base alias and dated release ids resolve to the base sonnet-4 window.
  expect(lookupModelContextWindow("claude-sonnet-4")).toBe(1_000_000);
  expect(lookupModelContextWindow("claude-sonnet-4-20250514")).toBe(1_000_000);
  expect(lookupModelContextWindow("claude-sonnet-4-latest")).toBe(1_000_000);
  // Unlisted numeric minors must NOT be claimed by the static table — they fall through.
  expect(lookupModelContextWindow("claude-sonnet-4-7")).toBeNull();
  expect(lookupModelContextWindow("claude-sonnet-4-10")).toBeNull();
  // The same boundary applies to opus (dated id ok, unlisted minor rejected).
  expect(lookupModelContextWindow("claude-opus-4-8-20250805")).toBe(1_000_000);
  expect(lookupModelContextWindow("claude-opus-4-9")).toBeNull();
});

test("resolveContextWindow uses the table value as the authoritative denominator", () => {
  // Early under-reported size from the harness is overridden by the table window.
  expect(resolveContextWindow(undefined, "claude-opus-4-8", 200000)).toEqual({
    modelId: "claude-opus-4-8",
    window: 1_000_000,
  });
});

test("resolveContextWindow keeps an unknown model's window monotonic", () => {
  const first = resolveContextWindow(undefined, "mystery-model", 200000);
  expect(first.window).toBe(200000);
  const grown = resolveContextWindow(first, "mystery-model", 1_000_000);
  expect(grown.window).toBe(1_000_000);
  // A later, smaller frame must not shrink the established window.
  const shrunk = resolveContextWindow(grown, "mystery-model", 200000);
  expect(shrunk.window).toBe(1_000_000);
});

test("resolveContextWindow resets the sticky window when the model changes", () => {
  const opus = resolveContextWindow(undefined, "claude-opus-4-8", 200000);
  expect(opus.window).toBe(1_000_000);
  // Switching to an unknown model drops the prior sticky 1M and adopts the report.
  const switched = resolveContextWindow(opus, "mystery-model", 200000);
  expect(switched).toEqual({ modelId: "mystery-model", window: 200000 });
});

test("parseTokenCount reads codex event_msg token_count", () => {
  expect(parseTokenCount({
    sessionUpdate: "event_msg",
    payload: {
      type: "token_count",
      last_token_usage: { total_tokens: 8500 },
      model_context_window: 10000,
    },
  })).toEqual({ lastTokens: 8500, contextWindow: 10000 });
});

test("parseAvailableCommands normalizes codex commands", () => {
  expect(parseAvailableCommands({
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "review" },
      { name: "compact" },
      { name: "logout" },
    ],
  })).toEqual(["review", "compact", "logout"]);
});

test("parseAvailableCommands parses full claude command list", () => {
  const commands = Array.from({ length: 40 }, (_, i) => ({ name: `skill-${i}` }));
  commands.push({ name: "/compact" });
  expect(parseAvailableCommands({
    sessionUpdate: "available_commands_update",
    availableCommands: commands,
  })?.includes("compact")).toBe(true);
});

test("normalizeCommandName strips a leading slash only", () => {
  expect(normalizeCommandName("compact")).toBe("compact");
  expect(normalizeCommandName("/compact")).toBe("compact");
  expect(normalizeCommandName("foo")).toBe("foo");
  expect(normalizeCommandName("")).toBe("");
});
