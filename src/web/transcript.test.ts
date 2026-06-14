import { test, expect } from "bun:test";
import { reduceTranscript } from "./transcript";
import type { TranscriptItem } from "./types";

const T = "2026-06-07T00:00:00.000Z";
function fold(updates: any[]): TranscriptItem[] {
  let items: TranscriptItem[] = [];
  for (const u of updates) items = reduceTranscript(items, u, T).items;
  return items;
}

test("__session_reset__ folds into a divider item and seals open messages", () => {
  const items = fold([
    { sessionUpdate: "agent_message_chunk", content: { text: "hi" } },
    { sessionUpdate: "__session_reset__" },
  ]);
  const divider = items.find((it) => it.kind === "divider");
  expect(divider).toBeTruthy();
  expect((divider as any).label).toBe("new session");
  const msg = items.find((it) => it.kind === "message");
  expect((msg as any).complete).toBe(true);
});

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

test("Image content blocks become Markdown images", () => {
  const items = fold([
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "Image", path: "diagram.png", alt: "topology" },
    },
  ]);
  expect(items[0]).toMatchObject({ kind: "message", role: "agent", text: "![topology](diagram.png)" });
});

test("ResourceLink content blocks become Markdown links with title", () => {
  const items = fold([
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "ResourceLink", uri: "spec.md", name: "Specification", title: "v1 spec" },
    },
  ]);
  expect(items[0]).toMatchObject({ kind: "message", role: "agent", text: '[Specification](spec.md "v1 spec")' });
});

test("mixed text, Image, and ResourceLink blocks preserve order", () => {
  const items = fold([
    {
      sessionUpdate: "agent_message_chunk",
      content: [
        { type: "text", text: "See " },
        { type: "ResourceLink", uri: "report.md", name: "report" },
        { type: "text", text: " and " },
        { type: "Image", uri: "chart.png", alt: "chart" },
      ],
    },
  ]);
  expect(items[0]).toMatchObject({ kind: "message", role: "agent", text: "See [report](report.md) and ![chart](chart.png)" });
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

test("claude tool_call_update reads output from _meta claudeCode toolResponse", () => {
  const items = fold([
    { sessionUpdate: "tool_call", toolCallId: "tc1", title: "Read", kind: "read", status: "pending" },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      _meta: { claudeCode: { toolName: "Read", toolResponse: { content: "first line\nsecond line" } } },
    },
  ]);

  expect(items[0]).toMatchObject({ kind: "tool_call", toolCallId: "tc1", status: "completed" });
  expect((items[0] as any).output).toBe("first line\nsecond line");
});

test("claude tool_call_update stringifies non-content toolResponse objects", () => {
  const items = fold([
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "glob1",
      _meta: {
        claudeCode: {
          toolName: "Glob",
          toolResponse: { filenames: [], numFiles: 0, durationMs: 3, truncated: false },
        },
      },
    },
  ]);

  expect(items[0]).toMatchObject({ kind: "tool_call", toolCallId: "glob1", status: "completed" });
  expect((items[0] as any).output).toContain('"numFiles":0');
});

test("codex tool_call_update prefers formatted_output over raw output object", () => {
  const items = fold([
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "exec1",
      status: "completed",
      rawOutput: {
        call_id: "call_qpf",
        command: ["/usr/bin/zsh", "-lc", "cat e2e-probe.txt"],
        stdout: "less useful\n",
        aggregated_output: "also less useful\n",
        formatted_output: "ok\n",
        exit_code: 0,
      },
    },
  ]);

  expect(items[0]).toMatchObject({ kind: "tool_call", toolCallId: "exec1", status: "completed" });
  expect((items[0] as any).output).toBe("ok\n");
});

test("codex tool_call_update falls back to stdout and stderr", () => {
  const items = fold([
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "exec1",
      status: "completed",
      rawOutput: {
        call_id: "call_qpf",
        command: ["/usr/bin/zsh", "-lc", "cat e2e-probe.txt"],
        stdout: "ok\n",
        stderr: "warning\n",
        exit_code: 0,
      },
    },
  ]);

  expect((items[0] as any).output).toBe("ok\nwarning\n");
});

test("codex tool_call_update renders rawOutput strings", () => {
  const items = fold([
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "exec1",
      status: "completed",
      rawOutput: "plain command output\n",
    },
  ]);

  expect(items[0]).toMatchObject({ kind: "tool_call", toolCallId: "exec1", status: "completed" });
  expect((items[0] as any).output).toBe("plain command output\n");
});

test("opencode tool_call_update reads output field from rawOutput objects", () => {
  const items = fold([
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "read1",
      status: "completed",
      rawOutput: {
        output: "<path>e2e-probe.txt</path><content>\n1: ok\n</content>",
        metadata: { durationMs: 1 },
      },
    },
  ]);

  expect((items[0] as any).output).toBe("<path>e2e-probe.txt</path><content>\n1: ok\n</content>");
});

test("codex tool_call input shows command without bookkeeping fields", () => {
  const items = fold([
    {
      sessionUpdate: "tool_call",
      toolCallId: "exec1",
      title: "exec",
      status: "pending",
      rawInput: {
        call_id: "call_qpf",
        process_id: "28446",
        turn_id: "019ea4",
        started_at_ms: 1780884513101,
        command: ["/usr/bin/zsh", "-lc", "cat e2e-probe.txt"],
        cwd: "/x",
        parsed_cmd: [{ type: "read", cmd: "cat e2e-probe.txt" }],
        source: "unified_exec_startup",
      },
    },
  ]);

  expect((items[0] as any).input).toContain("/usr/bin/zsh -lc cat e2e-probe.txt");
  expect((items[0] as any).input).toContain("/x");
  expect((items[0] as any).input).not.toContain("call_qpf");
  expect((items[0] as any).input).not.toContain("parsed_cmd");
});

test("claude tool_call_update infers failed when toolResponse reports an error", () => {
  const items = fold([
    { sessionUpdate: "tool_call", toolCallId: "tc1", title: "Read", status: "pending" },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      _meta: { claudeCode: { toolResponse: { is_error: true, content: "permission denied" } } },
    },
  ]);

  expect(items[0]).toMatchObject({ kind: "tool_call", toolCallId: "tc1", status: "failed" });
  expect((items[0] as any).output).toBe("permission denied");
});

test("empty rawInput objects are ignored for tool calls", () => {
  const items = fold([
    { sessionUpdate: "tool_call", toolCallId: "tc1", title: "Read", status: "pending", rawInput: {} },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      rawInput: {},
      _meta: { claudeCode: { toolResponse: "ok" } },
    },
  ]);

  expect((items[0] as any).input).toBeUndefined();
  expect((items[0] as any).output).toBe("ok");
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

test("compact synthetic updates create compact transcript entries", () => {
  const r = reduceTranscript([], { sessionUpdate: "__compact__", status: "started", reason: "auto-threshold" }, T);
  expect(r.items[0]).toMatchObject({ kind: "compact", status: "started", reason: "auto-threshold" });
  expect(r.ops[0]).toMatchObject({ op: "upsert", item: expect.objectContaining({ kind: "compact" }) });
});

test("__attachment__ folds into an attachment card carrying agent/path/contentType/caption/name", () => {
  const r = reduceTranscript([], {
    sessionUpdate: "__attachment__",
    id: "att:dev|chart.png|t1",
    agent: "dev",
    path: "chart.png",
    caption: "the chart",
    name: "Chart",
    contentType: "image/png",
  }, T);
  expect(r.ops).toHaveLength(1);
  expect(r.ops[0].op).toBe("upsert");
  expect(r.items[0]).toMatchObject({
    id: "att:dev|chart.png|t1",
    kind: "attachment",
    agent: "dev",
    path: "chart.png",
    caption: "the chart",
    name: "Chart",
    contentType: "image/png",
  });
});

test("__attachment__ folding is idempotent by stable id (snapshot replay does not duplicate)", () => {
  const update = {
    sessionUpdate: "__attachment__",
    id: "att:dev|report.md|t1",
    agent: "dev",
    path: "report.md",
    contentType: "text/markdown; charset=utf-8",
  };
  let items = reduceTranscript([], update, T).items;
  items = reduceTranscript(items, update, T).items; // replay (e.g. backend reattach)
  expect(items.filter((it) => it.kind === "attachment")).toHaveLength(1);
});

test("distinct publishes (distinct ids) produce distinct attachment cards", () => {
  let items = reduceTranscript([], { sessionUpdate: "__attachment__", id: "att:dev|r.md|t1", agent: "dev", path: "r.md", contentType: "text/markdown" }, T).items;
  items = reduceTranscript(items, { sessionUpdate: "__attachment__", id: "att:dev|r.md|t2", agent: "dev", path: "r.md", contentType: "text/markdown" }, T).items;
  expect(items.filter((it) => it.kind === "attachment")).toHaveLength(2);
});

test("__attachment__ seals an open agent message before the card", () => {
  const items = fold([
    { sessionUpdate: "agent_message_chunk", content: { text: "see the file" } },
    { sessionUpdate: "__attachment__", id: "att:dev|r.md|t1", agent: "dev", path: "r.md", contentType: "text/markdown" },
  ]);
  expect(items.map((i) => i.kind)).toEqual(["message", "attachment"]);
  expect((items[0] as any).complete).toBe(true);
});
