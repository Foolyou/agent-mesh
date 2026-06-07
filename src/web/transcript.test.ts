import { test, expect } from "bun:test";
import { reduceTranscript } from "./transcript";
import type { TranscriptItem } from "./types";

const T = "2026-06-07T00:00:00.000Z";
function fold(updates: any[]): TranscriptItem[] {
  let items: TranscriptItem[] = [];
  for (const u of updates) items = reduceTranscript(items, u, T).items;
  return items;
}

test("coalesces consecutive agent_message_chunk into one message", () => {
  const items = fold([
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } },
  ]);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "message", role: "agent", text: "Hello", complete: false });
});

test("thought chunks coalesce into a thought item", () => {
  const items = fold([
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "I should " } },
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "plan" } },
  ]);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "thought", text: "I should plan" });
});

test("tool_call then tool_call_update merge into one card updated in place", () => {
  const items = fold([
    { sessionUpdate: "tool_call", toolCallId: "tc1", title: "Read file", kind: "read", status: "pending" },
    { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "in_progress" },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
    },
  ]);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "tool_call", toolCallId: "tc1", title: "Read file", status: "completed" });
  expect((items[0] as any).output).toContain("ok");
});

test("distinct tool calls stay distinct items (no merge)", () => {
  const items = fold([
    { sessionUpdate: "tool_call", toolCallId: "a", title: "A", status: "completed" },
    { sessionUpdate: "tool_call", toolCallId: "b", title: "B", status: "completed" },
    { sessionUpdate: "tool_call", toolCallId: "c", title: "C", status: "completed" },
  ]);
  expect(items).toHaveLength(3);
  expect(new Set(items.map((i) => i.id)).size).toBe(3);
  expect(items.map((i) => (i as any).toolCallId)).toEqual(["a", "b", "c"]);
});

test("__mail__ folds into a sender-labeled mail item", () => {
  const out = reduceTranscript([], { sessionUpdate: "__mail__", from: "router", to: "codex-1", body: "ping" }, T);
  expect(out.ops).toHaveLength(1);
  expect(out.ops[0].op).toBe("upsert");
  expect(out.items[0]).toMatchObject({ kind: "mail", from: "router", to: "codex-1", body: "ping" });
});

test("a tool_call closes an open message; later text opens a new message", () => {
  const items = fold([
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "thinking" } },
    { sessionUpdate: "tool_call", toolCallId: "tc1", title: "Run", status: "pending" },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
  ]);
  expect(items.map((i) => i.kind)).toEqual(["message", "tool_call", "message"]);
  expect(items[0]).toMatchObject({ complete: true });
});

test("tool_call_update before tool_call upserts the card", () => {
  const items = fold([{ sessionUpdate: "tool_call_update", toolCallId: "tcX", status: "completed", title: "Late" }]);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "tool_call", toolCallId: "tcX", status: "completed" });
});

test("user echo update appends a completed user message", () => {
  const items = fold([{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi router" } }]);
  expect(items[0]).toMatchObject({ kind: "message", role: "user", text: "hi router", complete: true });
});

test("ops report upsert for new item and patch for appended text", () => {
  const first = reduceTranscript([], { sessionUpdate: "agent_message_chunk", content: { text: "a" } }, T);
  expect(first.ops[0].op).toBe("upsert");
  const second = reduceTranscript(first.items, { sessionUpdate: "agent_message_chunk", content: { text: "b" } }, T);
  expect(second.ops[0]).toMatchObject({ op: "patch" });
});

test("__turn_end__ closes open message and emits a patch", () => {
  const opened = reduceTranscript([], { sessionUpdate: "agent_message_chunk", content: { text: "x" } }, T);
  const ended = reduceTranscript(opened.items, { sessionUpdate: "__turn_end__" }, T);
  expect(ended.items[0]).toMatchObject({ complete: true });
  expect(ended.ops.some((o) => o.op === "patch")).toBe(true);
});

test("tool_call captures rawInput and locations", () => {
  const items = fold([
    {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Edit file",
      kind: "edit",
      status: "pending",
      rawInput: { path: "a.ts", content: "x" },
      locations: [{ path: "a.ts", line: 3 }],
    },
  ]);
  const it = items[0] as any;
  expect(it.input).toContain("a.ts");
  expect(it.locations).toEqual(["a.ts:3"]);
});

test("plan update creates one plan item and replaces it in place", () => {
  let items = fold([
    { sessionUpdate: "plan", entries: [{ content: "impl", status: "pending" }] },
  ]);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "plan" });
  expect((items[0] as any).entries).toHaveLength(1);
  // a second plan update replaces (not appends)
  items = fold([
    { sessionUpdate: "plan", entries: [{ content: "impl", status: "pending" }] },
    { sessionUpdate: "plan", entries: [{ content: "impl", status: "completed" }, { content: "review", status: "pending" }] },
  ]);
  expect(items.filter((i) => i.kind === "plan")).toHaveLength(1);
  expect((items[0] as any).entries).toHaveLength(2);
  expect((items[0] as any).entries[0].status).toBe("completed");
});

test("unknown update kinds are ignored (no items, no ops)", () => {
  const r = reduceTranscript([], { sessionUpdate: "available_commands_update", availableCommands: [] }, T);
  expect(r.items).toHaveLength(0);
  expect(r.ops).toHaveLength(0);
});
