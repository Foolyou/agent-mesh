import { test, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveRoot, expandHome, DEFAULT_ROOT } from "./root";

test("defaults to ~/.agent-mesh when no arg and no env", () => {
  expect(resolveRoot([], {})).toBe(join(homedir(), ".agent-mesh"));
  expect(DEFAULT_ROOT).toBe("~/.agent-mesh");
});

test("--root arg takes precedence and expands ~", () => {
  expect(resolveRoot(["bun", "main.ts", "--root", "/tmp/data"], {})).toBe("/tmp/data");
  expect(resolveRoot(["--root", "~/custom"], {})).toBe(join(homedir(), "custom"));
});

test("MESH_ROOT env is used when no arg; arg beats env", () => {
  expect(resolveRoot([], { MESH_ROOT: "/srv/mesh" })).toBe("/srv/mesh");
  expect(resolveRoot(["--root", "/from/arg"], { MESH_ROOT: "/from/env" })).toBe("/from/arg");
});

test("relative root resolves against cwd", () => {
  expect(expandHome("./local")).toBe(join(process.cwd(), "local"));
});
