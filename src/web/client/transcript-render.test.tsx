import { test, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Transcript } from "./Transcript";
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
