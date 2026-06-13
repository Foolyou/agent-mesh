import { test, expect } from "bun:test";
import { join } from "node:path";
import { assertManagedNpmPrefix, assertSafeNpmPackageSpec, managedNpmPrefix, npmPackageSpec } from "./harness-install-spec";

test("npmPackageSpec returns pinned semver specs only for npm-installable harnesses", () => {
  expect(npmPackageSpec("claude")).toBe("@agentclientprotocol/claude-agent-acp@0.44.0");
  expect(npmPackageSpec("codex")).toBe("@zed-industries/codex-acp@0.16.0");
  expect(() => npmPackageSpec("opencode")).toThrow(/not npm-installable/);
  expect(() => npmPackageSpec("kimi")).toThrow(/not npm-installable/);
});

test("assertSafeNpmPackageSpec rejects non-pinned and executable package specs", () => {
  const bad = [
    "https://registry.npmjs.org/pkg.tgz",
    "git+ssh://github.com/x/y",
    "@scope/pkg@latest",
    "@scope/pkg",
    "@scope/pkg@1.2.3+build",
    "@scope/pkg@1.2.3;touch /tmp/pwned",
    "pkg@1.2",
    "pkg@1.2.3 && echo bad",
  ];
  for (const spec of bad) expect(() => assertSafeNpmPackageSpec(spec)).toThrow(/unsafe/);
  expect(() => assertSafeNpmPackageSpec("@scope/pkg@1.2.3")).not.toThrow();
  expect(() => assertSafeNpmPackageSpec("pkg@1.2.3-beta.1")).not.toThrow();
});

test("managed npm prefix must stay under ~/.agent-mesh", () => {
  const home = "/tmp/mesh-home";
  expect(managedNpmPrefix(home)).toBe(join(home, ".agent-mesh", "npm-global"));
  expect(assertManagedNpmPrefix(join(home, ".agent-mesh", "npm-global"), home)).toBe(join(home, ".agent-mesh", "npm-global"));
  expect(() => assertManagedNpmPrefix(join(home, ".agent-mesh-other", "npm-global"), home)).toThrow(/prefix/);
  expect(() => assertManagedNpmPrefix("/usr/local", home)).toThrow(/prefix/);
});
