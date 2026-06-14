import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { estimateTranscriptItemSize, preservePrependAnchorOffset, shouldTriggerTranscriptBackfill, VirtualTranscript } from "./VirtualTranscript";
import { initialBottomOffset, isVirtualAtBottom, shouldFollowAppend, shouldManuallyAdjustMeasuredHeight } from "./virtual-transcript-scroll";
import { nextTranscriptStickState } from "./Transcript";
import type { TranscriptItem } from "../types";

const T = "2026-06-09T00:00:00.000Z";

function makeItems(count: number): TranscriptItem[] {
  return Array.from({ length: count }, (_, i): TranscriptItem => {
    if (i % 13 === 0) return { id: `divider-${i}`, kind: "divider", label: "new session", ts: T };
    if (i % 11 === 0) return { id: `plan-${i}`, kind: "plan", entries: [{ content: "one", status: "completed" }, { content: "two", status: "pending" }], ts: T, updatedTs: T };
    if (i % 7 === 0) return { id: `tool-${i}`, kind: "tool_call", toolCallId: `tc-${i}`, title: "read file", status: "completed", ts: T, updatedTs: T };
    if (i % 5 === 0) return { id: `mail-${i}`, kind: "mail", from: "lead", to: "builder", body: "mail body\n".repeat(6), ts: T };
    if (i % 3 === 0) return { id: `thought-${i}`, kind: "thought", text: "thinking", complete: true, ts: T };
    return { id: `msg-${i}`, kind: "message", role: i % 2 ? "agent" : "user", text: `message ${i} ` + "x".repeat(i % 4 === 0 ? 1200 : 80), complete: true, ts: T };
  });
}

test("estimateTranscriptItemSize is kind aware", () => {
  expect(estimateTranscriptItemSize({ id: "d", kind: "divider", label: "new", ts: T })).toBe(32);
  expect(estimateTranscriptItemSize({ id: "t", kind: "thought", text: "x", complete: false, ts: T })).toBe(32);
  expect(estimateTranscriptItemSize({ id: "tool", kind: "tool_call", toolCallId: "tc", title: "cmd", status: "completed", ts: T, updatedTs: T })).toBe(46);
  expect(estimateTranscriptItemSize({ id: "m", kind: "mail", from: "a", to: "b", body: "x", ts: T })).toBe(60);
  expect(estimateTranscriptItemSize({ id: "p", kind: "plan", entries: [{ content: "x", status: "pending" }, { content: "y", status: "pending" }], ts: T, updatedTs: T })).toBe(92);
  expect(estimateTranscriptItemSize({ id: "msg", kind: "message", role: "agent", text: "x".repeat(1600), complete: true, ts: T })).toBeGreaterThan(200);
});

test("VirtualTranscript renders only the initial visible range for long transcripts", () => {
  const html = renderToStaticMarkup(
    createElement(VirtualTranscript, {
      items: makeItems(1000),
      renderItem: (item: TranscriptItem) => createElement("div", { className: `row-${item.kind}` }, item.id),
      initialRect: { width: 720, height: 720 },
      initialOffset: 0,
      overscan: 10,
    }),
  );

  const renderedRows = (html.match(/data-virtual-row="true"/g) ?? []).length;
  expect(renderedRows).toBeGreaterThan(0);
  expect(renderedRows).toBeLessThan(30);
  expect(html).toContain('data-index="0"');
  expect(html).not.toContain('data-index="999"');
});

test("VirtualTranscript starts at the tail by default", () => {
  const html = renderToStaticMarkup(
    createElement(VirtualTranscript, {
      items: makeItems(1000),
      renderItem: (item: TranscriptItem) => createElement("div", { className: `row-${item.kind}` }, item.id),
      initialRect: { width: 720, height: 720 },
      overscan: 10,
    }),
  );

  expect(html).toContain('data-index="999"');
});

test("virtual transcript scroll helpers preserve chat semantics", () => {
  expect(isVirtualAtBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 400 }, 500)).toBe(true);
  expect(isVirtualAtBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 }, 20)).toBe(true);
  expect(isVirtualAtBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 }, 100)).toBe(false);
  expect(shouldFollowAppend(true, 10, 11)).toBe(true);
  expect(shouldFollowAppend(false, 10, 11)).toBe(false);
  expect(shouldFollowAppend(true, 10, 10)).toBe(false);
  expect(shouldManuallyAdjustMeasuredHeight(120, 100, 500, "forward")).toBe(true);
  expect(shouldManuallyAdjustMeasuredHeight(120, 700, 500, "forward")).toBe(false);
  expect(shouldManuallyAdjustMeasuredHeight(120, 100, 500, "backward")).toBe(false);
  expect(shouldManuallyAdjustMeasuredHeight(0, 100, 500, "forward")).toBe(false);
  expect(initialBottomOffset(makeItems(3), 10)).toBeGreaterThan(0);
});

test("virtual transcript backfill helpers gate near-top loading and preserve anchor offsets", () => {
  expect(shouldTriggerTranscriptBackfill({ firstVisibleIndex: 10, hasMore: true, inflight: false })).toBe(true);
  expect(shouldTriggerTranscriptBackfill({ firstVisibleIndex: 20, hasMore: true, inflight: false })).toBe(false);
  expect(shouldTriggerTranscriptBackfill({ firstVisibleIndex: 10, hasMore: false, inflight: false })).toBe(false);
  expect(shouldTriggerTranscriptBackfill({ firstVisibleIndex: 10, hasMore: true, inflight: true })).toBe(false);
  expect(preservePrependAnchorOffset({ currentStart: 420, previousTop: 80, containerTop: 20 })).toBe(360);
});

test("VirtualTranscript renders a loading marker while older transcript exists", () => {
  const html = renderToStaticMarkup(
    createElement(VirtualTranscript, {
      items: makeItems(1000),
      renderItem: (item: TranscriptItem) => createElement("div", { className: `row-${item.kind}` }, item.id),
      initialRect: { width: 720, height: 720 },
      initialOffset: 0,
      hasMore: true,
      onLoadOlder: async () => {},
    }),
  );

  expect(html).toContain("virtual-transcript-loading");
});

test("virtual transcript stick state ignores layout-only and downward scroll drift", () => {
  expect(nextTranscriptStickState(true, false, false, true)).toBe(true);
  expect(nextTranscriptStickState(true, false, true, false)).toBe(true);
  expect(nextTranscriptStickState(true, false, true, true)).toBe(false);
  expect(nextTranscriptStickState(false, true, false, false)).toBe(true);
});
