// src/tui/line-editor.test.ts
import { test, expect } from "bun:test";
import { LineEditor } from "./line-editor";

test("types characters and submits on Enter", () => {
  const ed = new LineEditor();
  for (const c of "hello") ed.handle(c);
  expect(ed.value).toBe("hello");
  expect(ed.handle("\r")).toBe("hello"); // Enter returns the submitted line
  expect(ed.value).toBe("");             // and clears
});

test("backspace deletes the last character", () => {
  const ed = new LineEditor();
  for (const c of "abc") ed.handle(c);
  ed.handle("\x7f");
  expect(ed.value).toBe("ab");
});

test("non-submit keys return null", () => {
  const ed = new LineEditor();
  expect(ed.handle("x")).toBeNull();
});
