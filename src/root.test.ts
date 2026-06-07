import { test, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveRoot, expandHome, DEFAULT_ROOT, MESH_DIR } from "./root";

test("defaults to ~/.agent-mesh (base = home) when no arg and no env", () => {
  expect(resolveRoot([], {})).toBe(join(homedir(), MESH_DIR));
  expect(DEFAULT_ROOT).toBe("~/.agent-mesh");
});

test("--root <dir> uses <dir>/.agent-mesh; ~ expands", () => {
  expect(resolveRoot(["bun", "main.ts", "--root", "/tmp/data"], {})).toBe(join("/tmp/data", MESH_DIR));
  expect(resolveRoot(["--root", "~/custom"], {})).toBe(join(homedir(), "custom", MESH_DIR));
});

test("MESH_ROOT env names the base too; arg beats env", () => {
  expect(resolveRoot([], { MESH_ROOT: "/srv/mesh" })).toBe(join("/srv/mesh", MESH_DIR));
  expect(resolveRoot(["--root", "/from/arg"], { MESH_ROOT: "/from/env" })).toBe(join("/from/arg", MESH_DIR));
});

test("a relative base resolves against cwd, then appends .agent-mesh", () => {
  expect(resolveRoot(["--root", "./local"], {})).toBe(join(process.cwd(), "local", MESH_DIR));
  expect(expandHome("./local")).toBe(join(process.cwd(), "local"));
});
