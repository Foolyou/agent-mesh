// src/protocol.test.ts
import { test, expect } from "bun:test";
import { LineBuffer, encodeFrame } from "./protocol";

test("encodeFrame appends exactly one newline", () => {
  expect(encodeFrame({ t: "ready" })).toBe('{"t":"ready"}\n');
});

test("LineBuffer splits complete lines and holds the partial remainder", () => {
  const lb = new LineBuffer();
  expect(lb.push('{"a":1}\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
  expect(lb.push(':3}\n')).toEqual(['{"c":3}']);
});

test("LineBuffer drops blank lines", () => {
  const lb = new LineBuffer();
  expect(lb.push("\n\n")).toEqual([]);
});
