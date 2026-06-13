import { expect, test } from "bun:test";
import {
  normalizeCommandName,
  parseAvailableCommands,
  parseTokenCount,
  parseUsageUpdate,
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
