import { readFileSync } from "node:fs";
import { test, expect } from "bun:test";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const i18n = readFileSync(new URL("./i18n.ts", import.meta.url), "utf8");
const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");

test("web app no longer wires global keyboard shortcuts", () => {
  expect(app).not.toContain("useKeyboard");
});

test("user-facing docs and hints do not advertise global keyboard shortcuts", () => {
  expect(i18n).not.toContain("keyboard:");
  expect(readme).not.toContain("Keyboard shortcuts");
  expect(readme).not.toContain("including keyboard shortcuts");
});

test("composer no longer exposes Ctrl+Enter steer as a shortcut", () => {
  const ui = readFileSync(new URL("./ui.tsx", import.meta.url), "utf8");
  expect(ui).not.toContain("e.ctrlKey");
  expect(ui).not.toContain("Ctrl+Enter");
  expect(i18n).not.toContain("Ctrl+Enter");
});
