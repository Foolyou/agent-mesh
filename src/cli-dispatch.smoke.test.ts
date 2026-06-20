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
  expect(out).toContain("usage:");
  expect(out).toContain("mesh <command> [args] [flags]");
  expect(out).not.toContain("→ http"); // server-boot banner ("…console → http://…") never printed
}, 20000);

test("mesh --help and mesh -h → exit 0 + usage", async () => {
  for (const flag of ["--help", "-h"]) {
    const { code, out } = await runMesh([flag]);
    expect(code).toBe(0);
    expect(out).toContain("usage:");
    expect(out).toContain("mesh <command> [args] [flags]");
    expect(out).not.toContain("→ http"); // server-boot banner ("…console → http://…") never printed
  }
}, 20000);

test("mesh <unknown command> → exit 2 + usage, starts no server", async () => {
  const { code, out } = await runMesh(["frobnicate"]);
  expect(code).toBe(2);
  expect(out).toContain("unknown command 'frobnicate'");
  expect(out).toContain("usage:");
  expect(out).toContain("mesh <command> [args] [flags]");
  expect(out).not.toContain("→ http"); // server-boot banner ("…console → http://…") never printed
}, 20000);

test("mesh --bogus (unknown leading flag) → exit 2 + usage, starts no server", async () => {
  const { code, out } = await runMesh(["--bogus"]);
  expect(code).toBe(2);
  expect(out).toContain("unknown option --bogus");
  expect(out).not.toContain("→ http"); // server-boot banner ("…console → http://…") never printed
}, 20000);

test("bare mesh prints status + usage and starts no server", async () => {
  const base = await mkdtemp(join(tmpdir(), "cli-bare-"));
  try {
    const { code, out } = await runMesh(["--root", base, "--port", "1"]);
    expect(code).toBe(0);
    expect(out).toContain(`service : ${join(base, ".agent-mesh")}`);
    expect(out).toContain("control : DOWN");
    expect(out).toContain("usage:");
    expect(out).toContain("mesh run");
    expect(out).not.toContain("→ http");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
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
    const { code, out } = await runMesh(["run", "--assistant-harness", "bogus", "--port", "1", "--root", base]);
    expect(code).not.toBe(0); // parse throws before startWebServer
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
    const { code, out } = await runMesh(["run", "--assistant-harness=bogus", "--port", "1", "--root", base]);
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

// ── channels feishu subcommand tree ──

test("`mesh channels feishu list` is the official form — works, no deprecation warning", async () => {
  const base = await mkdtemp(join(tmpdir(), "cli-ch-list-"));
  try {
    const { code, out } = await runMesh(["channels", "feishu", "list", "--root", base]);
    expect(code).toBe(0);
    expect(out).toContain("Pending feishu authorizations");
    expect(out).not.toContain("deprecated");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 20000);

test("removed top-level and split commands are unknown", async () => {
  const base = await mkdtemp(join(tmpdir(), "cli-removed-"));
  try {
    for (const cmd of ["feishu", "backend", "web"]) {
      const { code, out } = await runMesh([cmd, "--root", base]);
      expect(code).toBe(2);
      expect(out).toContain(`unknown command '${cmd}'`);
      expect(out).toContain("usage:");
      expect(out).not.toContain("→ http");
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 20000);

test("`mesh channels feishu approve|revoke` route to the existing Feishu auth behavior", async () => {
  const base = await mkdtemp(join(tmpdir(), "cli-ch-route-"));
  try {
    const approve = await runMesh(["channels", "feishu", "approve", "BADCODE", "--root", base]);
    expect(approve.code).toBe(2);
    expect(approve.out).toContain("no pending feishu authorization 'BADCODE'");
    const revoke = await runMesh(["channels", "feishu", "revoke", "ck", "oid", "--root", base]);
    expect(revoke.code).toBe(2);
    expect(revoke.out).toContain("no approved feishu entry");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 20000);

test("unknown channels provider / action → exit 2 + usage, no service", async () => {
  const base = await mkdtemp(join(tmpdir(), "cli-ch-unk-"));
  try {
    const prov = await runMesh(["channels", "nope", "--root", base]);
    expect(prov.code).toBe(2);
    expect(prov.out).toContain("unknown channels provider 'nope'");
    expect(prov.out).toContain("usage: mesh channels");
    expect(prov.out).not.toContain("→ http");
    const noProv = await runMesh(["channels", "--root", base]);
    expect(noProv.code).toBe(2);
    expect(noProv.out).toContain("missing channels provider");
    const action = await runMesh(["channels", "feishu", "nope", "--root", base]);
    expect(action.code).toBe(2);
    expect(action.out).toContain("usage:"); // auth-cli feishu sub-usage
    expect(action.out).not.toContain("→ http");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 20000);

test("device/auth command-local flags still pass through after the channels refactor", async () => {
  const base = await mkdtemp(join(tmpdir(), "cli-passthru-"));
  try {
    // --label / --ttl must reach auth-cli intact (a swallowed flag would surface a different error).
    const dev = await runMesh(["device", "approve", "CODE", "--label", "laptop", "--root", base]);
    expect(dev.out).toContain("no pending device code 'CODE'");
    expect(dev.out).not.toContain("invalid --label");
    const auth = await runMesh(["auth", "bootstrap", "--ttl", "60", "--root", base]);
    expect(auth.code).toBe(0);
    expect(auth.out).toContain("bootstrap token"); // --ttl 60 accepted
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 20000);

// ── control-plane wording ──

test("status/down name the combined control plane and explain daemon retention", async () => {
  const base = await mkdtemp(join(tmpdir(), "cli-word-"));
  try {
    const status = await runMesh(["status", "--root", base, "--port", "1"]); // dead port → DOWN
    expect(status.out).toContain("control : DOWN");
    const down = await runMesh(["down", "--root", base, "--port", "1"]); // nothing running
    expect(down.code).toBe(0);
    expect(down.out).toContain("mesh daemons left running (use --cold to reap them)");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 20000);
