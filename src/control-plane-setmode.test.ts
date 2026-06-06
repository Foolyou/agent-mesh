// src/control-plane-setmode.test.ts
import { test, expect } from "bun:test";
import { ControlPlane } from "./control-plane";
import { DEMO_MESH } from "./config";

test("setMode throws for an unknown agent (no connection)", () => {
  const cp = new ControlPlane(DEMO_MESH);
  expect(() => cp.setMode("ghost", "read-only")).toThrow(/no connection/);
});
