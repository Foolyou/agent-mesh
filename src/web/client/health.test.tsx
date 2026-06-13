import { test, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentHealthBadges, ContextUsageChip, ContextWaterline, activeHealth } from "./health";
import type { AgentHealthSignalEntry, AgentUsage } from "../types";

test("activeHealth hides compact_done but keeps active warning signals", () => {
  expect(activeHealth({ signal: "compact_done", ts: "T" })).toBeUndefined();
  expect(activeHealth({ signal: "rate_limited", detail: { utilization: 0.92 }, ts: "T" })?.signal).toBe("rate_limited");
});

test("AgentHealthBadges renders compacting, retry countdown, and rate-limit utilization", () => {
  const health: Record<string, AgentHealthSignalEntry> = {
    router: { signal: "compacting", detail: { status: "compacting" }, ts: "T1" },
    worker: { signal: "retrying", detail: { attempt: 2, retryDelayMs: 25000 }, ts: "T2" },
    fixer: { signal: "rate_limited", detail: { utilization: 0.92 }, ts: "T3" },
    done: { signal: "compact_done", detail: { durationMs: 2000 }, ts: "T4" },
  };

  const html = renderToStaticMarkup(createElement("div", null, Object.entries(health).map(([agent, entry]) => createElement(AgentHealthBadges, { key: agent, agent, entry }))));

  expect(html).toContain("compacting");
  expect(html).toContain("retry 25s");
  expect(html).toContain("rate 92%");
  expect(html).not.toContain("compact_done");
});

test("ContextWaterline renders per-agent usage pressure bars", () => {
  const usage: Record<string, AgentUsage> = {
    router: { used: 90, size: 100, ts: "T1" },
    worker: { used: 40, size: 100, ts: "T2" },
  };

  const html = renderToStaticMarkup(createElement(ContextWaterline, { agents: ["router", "worker", "idle"], usage }));

  expect(html).toContain("context-waterline");
  expect(html).toContain("router");
  expect(html).toContain("90%");
  expect(html).toContain("worker");
  expect(html).toContain("40%");
  expect(html).toContain("idle");
});

test("ContextUsageChip renders threshold classes and compact pending label", () => {
  const low = renderToStaticMarkup(createElement(ContextUsageChip, { usage: { used: 45, size: 100, ts: new Date().toISOString() } }));
  expect(low).toContain("ctx-chip-ok");
  expect(low).toContain("ctx: 45%");

  const warn = renderToStaticMarkup(createElement(ContextUsageChip, { usage: { used: 72, size: 100, ts: new Date().toISOString() } }));
  expect(warn).toContain("ctx-chip-yellow");
  expect(warn).toContain("ctx: 72%");

  const high = renderToStaticMarkup(createElement(ContextUsageChip, { usage: { used: 86, size: 100, ts: new Date().toISOString() } }));
  expect(high).toContain("ctx-chip-red");
  expect(high).toContain("compact pending");
  expect(high).toContain("86/100");
});
