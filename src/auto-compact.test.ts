import { expect, test } from "bun:test";
import { DEFAULT_AUTO_COMPACT_SETTINGS, MIN_AUTO_COMPACT_CONTEXT_WINDOW, evaluateCompactThreshold, parseCompactThreshold } from "./auto-compact";

test("default auto compact settings enable compaction at 85%", () => {
  expect(DEFAULT_AUTO_COMPACT_SETTINGS).toEqual({ enabled: true, threshold: "85%" });
  expect(MIN_AUTO_COMPACT_CONTEXT_WINDOW).toBe(80_000);
});

test("parseCompactThreshold parses percent thresholds", () => {
  expect(parseCompactThreshold("90%")).toEqual({ kind: "percent", value: 0.9 });
  expect(parseCompactThreshold(" 100% ")).toEqual({ kind: "percent", value: 1 });
});

test("parseCompactThreshold parses absolute tokens-used thresholds", () => {
  expect(parseCompactThreshold("200000 tokens")).toEqual({ kind: "tokens-used", value: 200000 });
  expect(parseCompactThreshold("200000")).toEqual({ kind: "tokens-used", value: 200000 });
  expect(parseCompactThreshold(" 200000   tokens ")).toEqual({ kind: "tokens-used", value: 200000 });
});

test("parseCompactThreshold parses negative values as tokens remaining", () => {
  expect(parseCompactThreshold("-20000")).toEqual({ kind: "tokens-remaining", value: 20000 });
  expect(parseCompactThreshold(" -20000 tokens ")).toEqual({ kind: "tokens-remaining", value: 20000 });
});

test("parseCompactThreshold rejects invalid thresholds", () => {
  for (const raw of ["", "   ", "0%", "-10%", "101%", "0 tokens", "-0", "abc", "10 bananas", "10.5 tokens"]) {
    expect(() => parseCompactThreshold(raw)).toThrow();
  }
});

test("evaluateCompactThreshold evaluates percent thresholds", () => {
  const threshold = parseCompactThreshold("90%");
  expect(evaluateCompactThreshold(threshold, 899, 1000)).toBe(false);
  expect(evaluateCompactThreshold(threshold, 900, 1000)).toBe(true);
});

test("evaluateCompactThreshold evaluates tokens-used thresholds", () => {
  const threshold = parseCompactThreshold("200000 tokens");
  expect(evaluateCompactThreshold(threshold, 199999, 258400)).toBe(false);
  expect(evaluateCompactThreshold(threshold, 200000, 258400)).toBe(true);
});

test("evaluateCompactThreshold evaluates tokens-remaining thresholds", () => {
  const threshold = parseCompactThreshold("-20000");
  expect(evaluateCompactThreshold(threshold, 237000, 258400)).toBe(false);
  expect(evaluateCompactThreshold(threshold, 238400, 258400)).toBe(true);
});
