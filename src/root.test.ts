import { test, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveRoot, resolveRootFrom, expandHome, DEFAULT_ROOT, MESH_DIR } from "./root";

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

test("resolveRootFrom returns a CONSISTENT base + root from an already-extracted --root value", () => {
  // The CLI dispatcher hands the parsed `--root` value (incl. the `--root=<v>` form) straight here, so
  // base and root can never disagree. base is forwarded as --root to a re-spawned backend.
  expect(resolveRootFrom("/tmp/data", {})).toEqual({ base: "/tmp/data", root: join("/tmp/data", MESH_DIR) });
  expect(resolveRootFrom("~/custom", {})).toEqual({ base: join(homedir(), "custom"), root: join(homedir(), "custom", MESH_DIR) });
  expect(resolveRootFrom("./local", {})).toEqual({ base: join(process.cwd(), "local"), root: join(process.cwd(), "local", MESH_DIR) });
});

test("resolveRootFrom: env fallback + arg precedence + home default", () => {
  expect(resolveRootFrom(undefined, {})).toEqual({ base: homedir(), root: join(homedir(), MESH_DIR) });
  expect(resolveRootFrom(undefined, { MESH_ROOT: "/srv/mesh" })).toEqual({ base: "/srv/mesh", root: join("/srv/mesh", MESH_DIR) });
  // an explicit --root value beats MESH_ROOT, and base/root stay in lockstep
  expect(resolveRootFrom("/from/arg", { MESH_ROOT: "/from/env" })).toEqual({ base: "/from/arg", root: join("/from/arg", MESH_DIR) });
});
