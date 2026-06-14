import { test, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { artifactCardUrls, didTranscriptScrollUp, isTranscriptAtBottom, isTranscriptScrollIntentKey, mailFoldButtonLabel, mailFoldInitialLineCount, nextMailExpanded, nextTranscriptStickState, Transcript, VIRTUAL_THRESHOLD } from "./Transcript";
import type { TranscriptItem } from "../types";

const T = "2026-06-09T00:00:00.000Z";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4DwQACfsD/aDefpkAAAAASUVErkJggg==";

function render(items: TranscriptItem[]): string {
  return renderToStaticMarkup(createElement(Transcript, { items }));
}

function messageItems(count: number): TranscriptItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m-${i}`,
    kind: "message" as const,
    role: "agent" as const,
    text: `message ${i}`,
    ts: T,
    complete: true,
  }));
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

test("transcript keeps stick-to-bottom across layout-only scroll drift", () => {
  expect(nextTranscriptStickState(true, false, true, false)).toBe(true);
  expect(nextTranscriptStickState(true, false, true, true)).toBe(false);
  expect(nextTranscriptStickState(true, false, false, true)).toBe(true);
  expect(nextTranscriptStickState(false, true, false, false)).toBe(true);
});

test("transcript only treats meaningful upward scroll as leave-bottom intent", () => {
  expect(didTranscriptScrollUp(120, 100)).toBe(false);
  expect(didTranscriptScrollUp(97, 100)).toBe(false);
  expect(didTranscriptScrollUp(95, 100)).toBe(true);
});

test("transcript recognizes keyboard scroll intent keys", () => {
  expect(isTranscriptScrollIntentKey("PageUp")).toBe(true);
  expect(isTranscriptScrollIntentKey("ArrowDown")).toBe(true);
  expect(isTranscriptScrollIntentKey("Enter")).toBe(false);
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

test("small transcripts use the full DOM renderer", () => {
  const html = render(messageItems(50));

  expect(html).not.toContain('data-virtual-row="true"');
  expect((html.match(/class="msg agent"/g) ?? []).length).toBe(50);
});

test("large transcripts use the virtual renderer", () => {
  const html = render(messageItems(VIRTUAL_THRESHOLD + 50));
  const virtualRows = (html.match(/data-virtual-row="true"/g) ?? []).length;

  expect(virtualRows).toBeGreaterThan(0);
  expect(virtualRows).toBeLessThan(50);
  expect((html.match(/class="msg agent"/g) ?? []).length).toBe(virtualRows);
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

function renderWithAuthor(items: TranscriptItem[], author?: { meshId: string; agent: string }): string {
  return renderToStaticMarkup(createElement(Transcript, { items, author }));
}

test("image attachment renders an inline image from the mesh-scoped artifact API url", () => {
  const html = renderWithAuthor(
    [{ id: "att:dev|out/chart.png|t1", kind: "attachment", agent: "dev", path: "out/chart.png", caption: "the chart", contentType: "image/png", ts: T }],
    { meshId: "demo", agent: "dev" },
  );
  expect(html).toContain("<img");
  expect(html).toContain('src="/api/meshes/demo/agents/dev/artifacts/out/chart.png"');
  expect(html).toContain('href="/mesh/demo/agent/dev/artifact/out/chart.png"');
  expect(html).toContain("the chart");
});

test("document attachment renders a viewer link (not an inline image)", () => {
  const html = renderWithAuthor(
    [{ id: "att:dev|report.md|t1", kind: "attachment", agent: "dev", path: "report.md", name: "Weekly report", contentType: "text/markdown; charset=utf-8", ts: T }],
    { meshId: "demo", agent: "dev" },
  );
  expect(html).toContain('href="/mesh/demo/agent/dev/artifact/report.md"');
  expect(html).toContain("Weekly report");
  expect(html).not.toContain("<img");
});

test("attachment without an author context is inert (no artifact url, just a label)", () => {
  const html = renderWithAuthor([
    { id: "att:dev|secret.png|t1", kind: "attachment", agent: "dev", path: "secret.png", contentType: "image/png", ts: T },
  ]);
  expect(html).not.toContain("/api/meshes/");
  expect(html).not.toContain("/artifact/");
  expect(html).toContain("secret.png");
});

test("a published attachment from another agent forwards to that agent's artifact path", () => {
  const html = renderWithAuthor(
    [{ id: "att:builder|art.png|t1", kind: "attachment", agent: "builder", path: "art.png", contentType: "image/png", ts: T }],
    { meshId: "demo", agent: "reviewer" },
  );
  // The card uses the attachment's own owner (builder), not the viewing author (reviewer).
  expect(html).toContain('src="/api/meshes/demo/agents/builder/artifacts/art.png"');
});

test("user-bubble artifact: link stays inert without an author context", () => {
  const html = render([
    { id: "u1", kind: "message", role: "user", text: "see [report](artifact:report.md)", ts: T, complete: true },
  ]);
  // No AuthorContext on user bubbles → artifact: cannot resolve → rendered as plain text, no link.
  expect(html).not.toContain("/api/meshes/");
  expect(html).not.toContain("/artifact/");
  expect(html).not.toContain("href=\"artifact:");
});

test("artifactCardUrls builds matching api + viewer urls and encodes segments", () => {
  const { api, viewer } = artifactCardUrls("demo", "dev", "sub dir/a b.png");
  expect(api).toBe("/api/meshes/demo/agents/dev/artifacts/sub%20dir/a%20b.png");
  expect(viewer).toBe("/mesh/demo/agent/dev/artifact/sub%20dir/a%20b.png");
});
