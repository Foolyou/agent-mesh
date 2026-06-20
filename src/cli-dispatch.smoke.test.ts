// Smoke test: drive the real `mesh` binary (source) to prove help/unknown return WITHOUT booting a
// service (no "web console" banner, correct exit code). Complements the pure resolver unit tests.
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runMesh(args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["bun", "run", "src/main.ts", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
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
