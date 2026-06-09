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

test("relative image src with context rewrites to the API route", () => {
  expect(rewriteAgentImageSrc("diagram.png", author)).toBe("/api/agents/codex-1/files/diagram.png");
});

test("encoded paths are preserved rather than double-encoded", () => {
  expect(rewriteAgentHref("dir/a%20b.md", author)).toBe("/mesh/dev/agent/codex-1/file/dir/a%20b.md");
  expect(rewriteAgentImageSrc("dir/%E5%9B%BE.png", author)).toBe("/api/agents/codex-1/files/dir/%E5%9B%BE.png");
});
