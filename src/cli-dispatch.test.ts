import { test, expect } from "bun:test";
import { resolveCommand, isKnownCommand } from "./cli-dispatch";

// Convenience: assert a "run" result and return it narrowed.
function run(argv: string[]) {
  const r = resolveCommand(argv);
  if (r.mode !== "run") throw new Error(`expected run mode, got ${r.mode}`);
  return r;
}

test("boolean global before the command does NOT eat the command", () => {
  const r = run(["--fake", "status"]);
  expect(r.command).toBe("status");
  expect(r.globals.fake).toBe(true);
  expect(r.commandTail).toEqual([]);
});

test("value globals are equivalent before and after the command", () => {
  const post = run(["status", "--root", ".", "--port", "10010"]);
  const pre = run(["--root", ".", "--port", "10010", "status"]);
  for (const r of [post, pre]) {
    expect(r.command).toBe("status");
    expect(r.globals.root).toBe(".");
    expect(r.globals.port).toBe("10010");
    expect(r.commandTail).toEqual([]);
  }
});

test("--cold works both as a leading global and a trailing global", () => {
  const lead = run(["--cold", "restart"]);
  const trail = run(["restart", "--cold"]);
  for (const r of [lead, trail]) {
    expect(r.command).toBe("restart");
    expect(r.globals.cold).toBe(true);
    expect(r.commandTail).toEqual([]);
  }
});

test("scripts/update.sh form: restart --root X --port Y --cold", () => {
  const r = run(["restart", "--root", "/srv", "--port", "10010", "--cold"]);
  expect(r.command).toBe("restart");
  expect(r.globals).toEqual({ root: "/srv", port: "10010", cold: true });
  expect(r.commandTail).toEqual([]);
});

test("command-local flags are kept verbatim in the tail (device --label)", () => {
  const r = run(["device", "approve", "CODE", "--label", "laptop"]);
  expect(r.command).toBe("device");
  expect(r.commandTail).toEqual(["approve", "CODE", "--label", "laptop"]);
  expect(r.globals).toEqual({});
});

test("command-local flags are kept verbatim in the tail (auth --ttl)", () => {
  const r = run(["auth", "bootstrap", "--ttl", "60"]);
  expect(r.command).toBe("auth");
  expect(r.commandTail).toEqual(["bootstrap", "--ttl", "60"]);
});

test("local short flags (-v / -f / --all) are not swallowed by the top level", () => {
  expect(run(["ps", "-v"]).commandTail).toEqual(["-v"]);
  expect(run(["logs", "-f"]).commandTail).toEqual(["-f"]);
  expect(run(["kill", "--all"]).commandTail).toEqual(["--all"]);
});

test("a value global mixed with a trailing local flag peels only the known global", () => {
  // --root is global (peeled); --label/laptop are command-local (kept). Order-independent.
  const r = run(["device", "approve", "CODE", "--root", "/r", "--label", "x"]);
  expect(r.command).toBe("device");
  expect(r.globals.root).toBe("/r");
  expect(r.commandTail).toEqual(["approve", "CODE", "--label", "x"]);
});

test("--key=value form is supported for value globals", () => {
  const r = run(["--port=8080", "status"]);
  expect(r.command).toBe("status");
  expect(r.globals.port).toBe("8080");
});

test("assistant globals are captured (incl. = form) so startup validation can see them", () => {
  // The bug: parseAssistantHarness used indexOf and missed `--assistant-harness=bogus`. The resolver
  // captures it into globals, and resolveAssistant() now reads from globals — so the = form is validated.
  expect(run(["run", "--assistant-harness=bogus"]).globals["assistant-harness"]).toBe("bogus");
  expect(run(["--assistant-harness", "codex", "run"]).globals["assistant-harness"]).toBe("codex");
  expect(run(["up", "--master-harness=zzz"]).globals["master-harness"]).toBe("zzz");
  expect(run(["run", "--no-assistant"]).globals["no-assistant"]).toBe(true);
});

test("help tokens resolve to help mode (leading and as a flag after a command)", () => {
  for (const argv of [["help"], ["--help"], ["-h"], ["status", "--help"], ["device", "-h"]]) {
    expect(resolveCommand(argv).mode).toBe("help");
  }
});

test("an unknown LEADING flag is an error (never a command, never a service)", () => {
  const r = resolveCommand(["--bogus", "status"]);
  expect(r.mode).toBe("error");
  if (r.mode === "error") expect(r.message).toContain("--bogus");
});

test("a value global missing its value is an error", () => {
  expect(resolveCommand(["--root"]).mode).toBe("error");
  expect(resolveCommand(["status", "--port"]).mode).toBe("error");
});

test("channels is a known command; its provider/action ride in the verbatim tail", () => {
  expect(isKnownCommand("channels")).toBe(true);
  expect(run(["channels", "feishu", "approve", "CODE"]).commandTail).toEqual(["feishu", "approve", "CODE"]);
  expect(run(["channels", "feishu", "revoke", "K", "O"]).commandTail).toEqual(["feishu", "revoke", "K", "O"]);
  expect(run(["channels", "nope"]).commandTail).toEqual(["nope"]);
  expect(isKnownCommand("feishu")).toBe(false);
});

test("an unknown command resolves (command set, but not known) — caller exits 2", () => {
  const r = run(["frobnicate"]);
  expect(r.command).toBe("frobnicate");
  expect(isKnownCommand("frobnicate")).toBe(false);
  expect(isKnownCommand("backend")).toBe(false);
  expect(isKnownCommand("web")).toBe(false);
  expect(isKnownCommand("status")).toBe(true);
  expect(isKnownCommand("run")).toBe(true);
  expect(isKnownCommand("restart")).toBe(true);
});

test("bare mesh (and globals-only) resolve to no command → caller prints status + usage", () => {
  expect(run([]).command).toBeUndefined();
  const onlyRoot = run(["--root", "."]);
  expect(onlyRoot.command).toBeUndefined();
  expect(onlyRoot.globals.root).toBe(".");
});

test("post-command unknown flag is left to the command, not a top-level error", () => {
  const r = run(["status", "--whatever"]);
  expect(r.command).toBe("status");
  expect(r.commandTail).toEqual(["--whatever"]); // status ignores it; not an error
});

// ── single-mesh lifecycle arity/tail (mesh-cli-lifecycle): the resolver keeps the name + command-local
// flags verbatim in the tail; main.ts decides arity (a positional name → one mesh, none → control plane).

test("start <name> --fresh keeps the name and --fresh verbatim in the tail", () => {
  const r = run(["start", "demo", "--fresh"]);
  expect(r.command).toBe("start");
  expect(r.commandTail).toEqual(["demo", "--fresh"]);
});

test("restart/status with no name → empty tail (control-plane); with a name → name in tail (one mesh)", () => {
  expect(run(["restart"]).commandTail).toEqual([]);
  expect(run(["restart", "demo"]).commandTail).toEqual(["demo"]);
  expect(run(["status"]).commandTail).toEqual([]);
  expect(run(["status", "demo"]).commandTail).toEqual(["demo"]);
});

test("a global flag after status is peeled, never mistaken for the mesh name", () => {
  const r = run(["status", "--port", "10010"]);
  expect(r.commandTail).toEqual([]); // --port is a known global → peeled
  expect(r.globals.port).toBe("10010");
});
