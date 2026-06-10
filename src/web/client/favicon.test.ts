import { readFileSync } from "node:fs";
import { test, expect } from "bun:test";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("index html declares the agent-mesh favicon and theme color", () => {
  expect(html).toContain('<link rel="icon" type="image/svg+xml" href="./favicon.svg" />');
  expect(html).toContain('<meta name="theme-color" content="#0a0b0d" />');
});

test("favicon svg contains the approved mesh glyph mark", () => {
  const svg = readFileSync(new URL("./favicon.svg", import.meta.url), "utf8");

  expect(svg).toContain('viewBox="0 0 32 32"');
  expect(svg).toContain("#0a0b0d");
  expect(svg).toContain("#4ec97a");
  expect(svg).toContain('data-part="brand-block"');
  expect(svg).toContain('data-part="mesh-edge"');
  expect(svg).toContain('data-part="mesh-node"');
});
