// React-level rendering tests for the agent message Markdown pipeline. Unit-level here
// (renderToStaticMarkup) so a regression is caught in `bun test` without spinning up a
// real server; the e2e in src/web/file-viewer.e2e.ts is the integration backstop.
import { test, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthorContext } from "./AuthorContext";
import { Markdown } from "./Markdown";

const author = { meshId: "dev", agent: "codex-1" };

function renderMd(text: string, withAuthor = true): string {
  const tree = withAuthor
    ? createElement(AuthorContext.Provider, { value: author }, createElement(Markdown, { text }))
    : createElement(Markdown, { text });
  return renderToStaticMarkup(tree);
}

test("relative href renders an <a> that DOES NOT leak the hast `node` AST as a DOM attribute", () => {
  const html = renderMd("[open](report.md)");
  expect(html).toContain('href="/mesh/dev/agent/codex-1/file/report.md"');
  expect(html).not.toContain("node=");
  expect(html).not.toContain("[object Object]");
});

test("http href renders an <a> with no `node` DOM attribute", () => {
  const html = renderMd("[ext](https://example.com/x)");
  expect(html).toContain('href="https://example.com/x"');
  expect(html).not.toContain("node=");
});

test("stripped href (absolute path) renders as plain text — no dead anchor", () => {
  const html = renderMd("[open](/home/me/report.md)");
  expect(html).toContain("open");
  // No anchor tag at all — a dead `<a>` would invite clicks that do nothing.
  expect(html).not.toMatch(/<a\b/);
});

test("stripped href (javascript: scheme) renders as plain text — no dead anchor", () => {
  const html = renderMd("[click](javascript:alert(1))");
  expect(html).toContain("click");
  expect(html).not.toMatch(/<a\b/);
  expect(html).not.toContain("javascript:");
});

test("relative href without AuthorContext renders as plain text — no dead anchor", () => {
  const html = renderMd("[open](report.md)", false);
  expect(html).toContain("open");
  expect(html).not.toMatch(/<a\b/);
});

test("img does not leak the hast `node` AST as a DOM attribute", () => {
  const html = renderMd("![pic](diagram.png)");
  expect(html).toContain('src="/api/agents/codex-1/files/diagram.png"');
  expect(html).not.toContain("node=");
});

test("strong does not leak the hast `node` AST as a DOM attribute", () => {
  const html = renderMd("**bold**");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).not.toContain("node=");
});

test("fenced code renders as the app themed pre/code block instead of Streamdown chrome", () => {
  const html = renderMd('```ts\ntype TaskStatus = "pending";\ninterface Task { id: string }\n```');

  expect(html).toContain('<pre><code class="language-ts">type TaskStatus = &quot;pending&quot;');
  expect(html).toContain(";\ninterface Task");
  expect(html).not.toContain("data-streamdown=\"code-block");
  expect(html).not.toContain("code-block-header");
});
