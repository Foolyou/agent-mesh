import { test, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isTranscriptAtBottom, mailFoldButtonLabel, mailFoldInitialLineCount, nextMailExpanded, Transcript } from "./Transcript";
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

test("short mail renders fully without an expand button", () => {
  const html = render([{ id: "m1", kind: "mail", from: "lead", to: "fixer", body: "short mail", ts: T }]);

  expect(html).toContain("short mail");
  expect(html).not.toContain("mail-expand-btn");
  expect(html).not.toContain("mail-fold collapsed");
});

test("long mail renders collapsed by default with an accessible expand button", () => {
  const html = render([
    {
      id: "m1",
      kind: "mail",
      from: "lead",
      to: "fixer",
      body: ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"].join("\n"),
      ts: T,
    },
  ]);

  expect(html).toContain("mail-fold collapsed");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('aria-controls="mail-body-m1"');
  expect(html).toContain("show more (+3 lines)");
});

test("mail fold helpers switch between expand and collapse states", () => {
  expect(mailFoldInitialLineCount("one line")).toBe(1);
  expect(mailFoldInitialLineCount("one\ntwo\nthree\nfour")).toBe(4);
  expect(mailFoldButtonLabel(false, 47)).toBe("show more (+47 lines)");
  expect(mailFoldButtonLabel(true, 47)).toBe("show less");
  expect(nextMailExpanded(false)).toBe(true);
  expect(nextMailExpanded(true)).toBe(false);
});
