import { test, expect } from "bun:test";
import { isRelativeRef, rewriteAgentHref, rewriteAgentImageSrc } from "./Markdown";

const author = { meshId: "dev", agent: "codex-1" };

test("http hrefs are untouched", () => {
  expect(isRelativeRef("https://example.com/report.md")).toBe(false);
  expect(rewriteAgentHref("https://example.com/report.md", author)).toBe("https://example.com/report.md");
});

test("relative href with context rewrites to the viewer route", () => {
  expect(isRelativeRef("report.md")).toBe(true);
  expect(rewriteAgentHref("report.md", author)).toBe("/mesh/dev/agent/codex-1/file/report.md");
});

test("relative href without context has no href", () => {
  expect(rewriteAgentHref("report.md", undefined)).toBeUndefined();
});

test("unsafe href schemes are not rewritten", () => {
  expect(isRelativeRef("javascript:alert(1)")).toBe(false);
  expect(rewriteAgentHref("javascript:alert(1)", author)).toBeUndefined();
  expect(rewriteAgentImageSrc("data:text/html,<script>alert(1)</script>", author)).toBeUndefined();
});

test("relative image src with context rewrites to the API route", () => {
  expect(rewriteAgentImageSrc("diagram.png", author)).toBe("/api/agents/codex-1/files/diagram.png");
});

test("encoded paths are preserved rather than double-encoded", () => {
  expect(rewriteAgentHref("dir/a%20b.md", author)).toBe("/mesh/dev/agent/codex-1/file/dir/a%20b.md");
  expect(rewriteAgentImageSrc("dir/%E5%9B%BE.png", author)).toBe("/api/agents/codex-1/files/dir/%E5%9B%BE.png");
});

test("artifact refs rewrite through AuthorContext", () => {
  expect(rewriteAgentImageSrc("artifact:foo.png", author)).toBe("/api/meshes/dev/agents/codex-1/artifacts/foo.png");
  expect(rewriteAgentHref("artifact:report.md", author)).toBe("/api/meshes/dev/agents/codex-1/artifacts/report.md");
});

test("artifact explicit owner refs rewrite through the current mesh", () => {
  expect(rewriteAgentImageSrc("artifact://builder/x.png", author)).toBe("/api/meshes/dev/agents/builder/artifacts/x.png");
  expect(rewriteAgentHref("artifact://builder/docs/a%20b.md", author)).toBe("/api/meshes/dev/agents/builder/artifacts/docs/a%20b.md");
});

test("unsafe artifact refs are dropped", () => {
  expect(rewriteAgentImageSrc("artifact://bad..name/x.png", author)).toBeUndefined();
  expect(rewriteAgentImageSrc("artifact:/abs/path", author)).toBeUndefined();
  expect(rewriteAgentImageSrc("artifact://evil.com/x", author)).toBeUndefined();
  expect(rewriteAgentImageSrc("artifact://builder//x.png", author)).toBeUndefined();
  expect(rewriteAgentImageSrc("artifact://builder/..%2Fx.png", author)).toBeUndefined();
  expect(rewriteAgentImageSrc("artifact:foo.png", undefined)).toBeUndefined();
});
