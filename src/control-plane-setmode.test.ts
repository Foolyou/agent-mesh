// src/control-plane-setmode.test.ts
import { test, expect } from "bun:test";
import { ControlPlane } from "./control-plane";
import { DEMO_MESH } from "./config";

test("setMode throws for an unknown agent (no connection)", () => {
  const cp = new ControlPlane(DEMO_MESH);
  expect(() => cp.setMode("ghost", "read-only")).toThrow(/no connection/);
});

test("prompt injects the mesh briefing exactly once per agent", () => {
  const cp = new ControlPlane(DEMO_MESH);
  const seen: string[] = [];
  const fake = { prompt: (t: string) => (seen.push(t), Promise.resolve({})) };
  (cp as any).conns.set("router", fake);
  cp.prompt("router", "do the thing");
  cp.prompt("router", "again");
  expect(seen[0]).toContain("[MESH BRIEFING]");
  expect(seen[0]).toContain("do the thing");
  expect(seen[1]).toBe("again"); // briefing not repeated
});
