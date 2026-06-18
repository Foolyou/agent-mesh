import { test, expect } from "bun:test";
import { BoundedDedup } from "./dedup";

test("check returns false for new ids and true for repeats", () => {
  const d = new BoundedDedup(10);
  expect(d.check("e1")).toBe(false);
  expect(d.check("e1")).toBe(true);
  expect(d.check("e2")).toBe(false);
  expect(d.size).toBe(2);
});

test("evicts oldest beyond capacity (FIFO)", () => {
  const d = new BoundedDedup(2);
  d.check("a");
  d.check("b"); // [a, b]
  expect(d.size).toBe(2);
  expect(d.check("c")).toBe(false); // new; evicts "a" -> [b, c]
  expect(d.size).toBe(2);
  expect(d.check("a")).toBe(false); // "a" was evicted, new again; evicts "b" -> [c, a]
  expect(d.check("c")).toBe(true); // "c" still remembered
});

test("size never exceeds capacity", () => {
  const d = new BoundedDedup(3);
  for (let i = 0; i < 100; i++) d.check(`e${i}`);
  expect(d.size).toBe(3);
});

test("capacity floors at 1", () => {
  const d = new BoundedDedup(0);
  expect(d.check("x")).toBe(false);
  expect(d.check("y")).toBe(false); // evicts x
  expect(d.size).toBe(1);
  expect(d.check("x")).toBe(false); // x was evicted
});
