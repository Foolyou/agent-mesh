import { test, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isTranscriptAtBottom, Transcript } from "./Transcript";
import type { TranscriptItem } from "../types";

const T = "2026-06-09T00:00:00.000Z";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4DwQACfsD/aDefpkAAAAASUVErkJggg==";

function render(items: TranscriptItem[]): string {
  return renderToStaticMarkup(createElement(Transcript, { items }));
}

test("user message markdown renders data image instead of literal base64 text", () => {
  const html = render([
    {
      id: "u1",
      kind: "message",
      role: "user",
      text: `![upload](data:image/png;base64,${PNG})`,
      ts: T,
      complete: true,
    },
  ]);

  expect(html).toContain("<img");
  expect(html).toContain('src="data:image/png;base64,');
  expect(html).toContain('alt="upload"');
  expect(html).not.toContain("![upload](");
});

test("user message relative image without an author does not rewrite to an agent file URL", () => {
  const html = render([
    {
      id: "u1",
      kind: "message",
      role: "user",
      text: "![local](diagram.png)",
      ts: T,
      complete: true,
    },
  ]);

  expect(html).not.toMatch(/<img\b/);
  expect(html).not.toContain("/api/agents/");
});

test("transcript bottom detection treats nearby scroll positions as bottom", () => {
  expect(isTranscriptAtBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 400 })).toBe(true);
  expect(isTranscriptAtBottom({ scrollHeight: 1000, scrollTop: 559, clientHeight: 400 })).toBe(false);
});

test("transcript stream is programmatically focusable for jump-to-bottom", () => {
  const html = render([
    {
      id: "u1",
      kind: "message",
      role: "user",
      text: "hello",
      ts: T,
      complete: true,
    },
  ]);

  expect(html).toContain('class="stream"');
  expect(html).toContain('tabindex="-1"');
});

test("transcript renders compact entries as dim infrastructure markers", () => {
  const html = render([{ id: "c1", kind: "compact", status: "completed", reason: "auto-threshold", ts: T }]);

  expect(html).toContain("compact-entry completed");
  expect(html).toContain("--- Context Compacted ---");
  expect(html).toContain("completed");
});
