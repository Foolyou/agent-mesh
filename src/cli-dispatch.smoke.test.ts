// Smoke test: drive the real `mesh` binary (source) to prove help/unknown return WITHOUT booting a
// service (no "web console" banner, correct exit code). Complements the pure resolver unit tests.
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runMesh(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["bun", "run", "src/main.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, ...env },
  });
  const [code, out, err] = await Promise.all([
    p.exited,
    Bun.readableStreamToText(p.stdout as ReadableStream),
    Bun.readableStreamToText(p.stderr as ReadableStream),
  ]);
  return { code, out: out + err };
}

test("mesh help → exit 0, prints usage, starts no server", async () => {
  const { code, out } = await runMesh(["help"]);
  expect(code).toBe(0);
  expect(out).toContain("usage: mesh");
  expect(out).not.toContain("→ http"); // server-boot banner ("…console → http://…") never printed
}, 20000);

test("mesh --help and mesh -h → exit 0 + usage", async () => {
  for (const flag of ["--help", "-h"]) {
    const { code, out } = await runMesh([flag]);
    expect(code).toBe(0);
    expect(out).toContain("usage: mesh");
    expect(out).not.toContain("→ http"); // server-boot banner ("…console → http://…") never printed
  }
}, 20000);

test("mesh <unknown command> → exit 2 + usage, starts no server", async () => {
  const { code, out } = await runMesh(["frobnicate"]);
  expect(code).toBe(2);
  expect(out).toContain("unknown command 'frobnicate'");
  expect(out).toContain("usage: mesh");
  expect(out).not.toContain("→ http"); // server-boot banner ("…console → http://…") never printed
}, 20000);

test("mesh --bogus (unknown leading flag) → exit 2 + usage, starts no server", async () => {
  const { code, out } = await runMesh(["--bogus"]);
  expect(code).toBe(2);
  expect(out).toContain("unknown option --bogus");
  expect(out).not.toContain("→ http"); // server-boot banner ("…console → http://…") never printed
}, 20000);

test("--root in =, pre-command, and post-command forms all resolve the SAME storage root", async () => {
  // `mesh status` prints `service : <root>` (service.ts), so the storage root the binary actually uses
  // is observable. All three flag forms must agree with the parsed global — this pins the bug where
  // `--root=<v>` set base from globals but root fell back to env/home.
  const base = await mkdtemp(join(tmpdir(), "cli-root-"));
  try {
    const expected = `service : ${join(base, ".agent-mesh")}`;
    for (const args of [[`--root=${base}`, "status"], ["--root", base, "status"], ["status", "--root", base]]) {
      const { out } = await runMesh([...args, "--port", "1"]); // dead port → fast DOWN probe, no env backend
      expect(out).toContain(expected);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 30000);

// ── Commit 2: assistant-harness parsing is downshifted to control-plane startup paths only ──

test("read-only commands do NOT validate the assistant harness (bogus env never breaks them)", async () => {
  const base = await mkdtemp(join(tmpdir(), "cli-asst-ro-"));
  const env = { MESH_ASSISTANT_HARNESS: "totally-bogus" };
  try {
    // status / ps / auth exit 0 and never surface the harness parse error; doctor must not throw it.
    for (const cmd of [["status"], ["ps"], ["auth", "list"]]) {
      const { code, out } = await runMesh([...cmd, "--root", base, "--port", "1"], env);
      expect(out).not.toContain("invalid assistant harness");
      expect(out).not.toContain("→ http");
      expect(code).toBe(0);
    }
    const doctor = await runMesh(["doctor", "--root", base, "--port", "1"], env);
    expect(doctor.out).not.toContain("invalid assistant harness");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 30000);

test("a startup path STILL rejects an invalid assistant harness, before booting anything", async () => {
  const base = await mkdtemp(join(tmpdir(), "cli-asst-boot-"));
  try {
    const { code, out } = await runMesh(["backend", "--assistant-harness", "bogus", "--port", "1", "--root", base]);
    expect(code).not.toBe(0); // parse throws before startApiServer
    expect(out).toContain("invalid assistant harness");
    expect(out).not.toContain("→ http"); // no server banner
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 30000);

test("deprecated assistant flag warnings print on a startup path but NOT on read-only commands", async () => {
  const base = await mkdtemp(join(tmpdir(), "cli-asst-dep-"));
  try {
    // read-only: --master-harness is just a (consumed) global; status never consults the assistant,
    // so no deprecation warning is emitted.
    const ro = await runMesh(["status", "--master-harness", "codex", "--root", base, "--port", "1"]);
    expect(ro.out).not.toContain("deprecated");
    // startup path: `up` builds the passthrough → resolveAssistant() prints the deprecation warning,
    // then the bogus value fails fast (before spawning the backend), so the test never hangs.
    const startup = await runMesh(["up", "--master-harness", "bogus", "--root", base, "--port", "1"]);
    expect(startup.out).toContain("--master-harness is deprecated");
    expect(startup.out).toContain("invalid assistant harness");
    expect(startup.code).not.toBe(0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 30000);

// ── Commit 2 follow-up: the = form of assistant flags must be validated on startup, ignored read-only ──

test("startup rejects --assistant-harness=bogus (equals form), before booting anything", async () => {
  const base = await mkdtemp(join(tmpdir(), "cli-asst-eq-"));
  try {
    const { code, out } = await runMesh(["backend", "--assistant-harness=bogus", "--port", "1", "--root", base]);
    expect(code).not.toBe(0);
    expect(out).toContain("invalid assistant harness");
    expect(out).not.toContain("→ http");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 30000);

test("read-only command ignores the = form of assistant flags (no throw, no warning)", async () => {
  const base = await mkdtemp(join(tmpdir(), "cli-asst-eq-ro-"));
  try {
    const { code, out } = await runMesh(["status", "--assistant-harness=bogus", "--root", base, "--port", "1"]);
    expect(code).toBe(0);
    expect(out).toContain("service :");
    expect(out).not.toContain("invalid assistant harness");
    expect(out).not.toContain("deprecated");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 30000);

test("--master-harness=bogus (equals form) on a startup path warns AND rejects", async () => {
  const base = await mkdtemp(join(tmpdir(), "cli-asst-eq-dep-"));
  try {
    const { code, out } = await runMesh(["up", "--master-harness=bogus", "--root", base, "--port", "1"]);
    expect(out).toContain("--master-harness is deprecated");
    expect(out).toContain("invalid assistant harness");
    expect(code).not.toBe(0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 30000);
