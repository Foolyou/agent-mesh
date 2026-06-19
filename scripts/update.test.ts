// Tests for scripts/update.sh — the build/deploy + rollback flow. Drives the script with its
// test hooks (MESH_BUILD_CMD / MESH_RESTART_CMD / MESH_GATE_CMD / MESH_NOW) so it never runs a
// real 30s `bun build`, never recursively runs `bun test`, and never touches production: the
// "binary" is a marker file, the "restart" is a no-op, and health is controlled by whether a
// dummy server listens on the (random) port.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "update.sh");
const dirs: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const shellTest = process.platform === "win32" ? test.skip : test;

afterEach(async () => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(prefix: string) {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  await new Promise<void>((r) => srv.close(() => r()));
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

/** A stand-in backend that answers /api/state so the script's health check passes. */
function healthyServer(port: number) {
  const s = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  servers.push(s);
  return s;
}

interface Run {
  bin: string;
  backups: string;
  base: string;
  port: number;
  env: Record<string, string>;
}
async function harness(extra: Partial<Record<string, string>> = {}): Promise<Run> {
  const work = await tmp("mesh-update-");
  const bin = join(work, "mesh");
  const backups = join(work, "backups");
  const base = join(work, "home");
  await mkdir(base, { recursive: true });
  const port = await freePort();
  const env: Record<string, string> = {
    MESH_BIN: bin,
    MESH_BACKUP_DIR: backups,
    MESH_WORK_ROOT: base,
    MESH_WORK_PORT: String(port),
    MESH_UPDATE_GATE: "0",
    MESH_RESTART_CMD: ":", // no-op restart
    MESH_HEALTH_TIMEOUT: "3",
    MESH_BUILD_CMD: 'printf NEWBIN > "$OUT"',
    ...extra,
  };
  return { bin, backups, base, port, env };
}

async function runScript(env: Record<string, string>, ...args: string[]) {
  const p = Bun.spawn(["bash", SCRIPT, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [code, out, err] = await Promise.all([p.exited, p.stdout.text(), p.stderr.text()]);
  return { code, out, err };
}

const exists = (p: string) => Bun.file(p).exists();

shellTest("deploy: builds, archives the old binary, swaps in the new, restarts healthy", async () => {
  const h = await harness();
  await writeFile(h.bin, "OLDBIN");
  healthyServer(h.port);

  const { code, out } = await runScript({ ...h.env, MESH_NOW: "20260608-000001" });
  expect({ code, out }).toMatchObject({ code: 0 });
  expect(await readFile(h.bin, "utf8")).toBe("NEWBIN"); // new binary installed
  expect(await readFile(`${h.bin}.build-id`, "utf8")).toBe("20260608-000001\n"); // deployed build id
  expect(await readFile(join(h.backups, "mesh-20260608-000001"), "utf8")).toBe("OLDBIN"); // old archived
  expect(out).toContain("✓ new binary live and healthy");
});

shellTest("deploy: gate failure aborts before building — binary untouched, nothing archived", async () => {
  const h = await harness({ MESH_UPDATE_GATE: "1", MESH_GATE_CMD: "false" });
  await writeFile(h.bin, "OLDBIN");
  healthyServer(h.port);

  const { code } = await runScript(h.env);
  expect(code).not.toBe(0);
  expect(await readFile(h.bin, "utf8")).toBe("OLDBIN"); // never swapped
  expect(await exists(h.backups)).toBe(false); // never archived
});

shellTest("deploy: build failure leaves the live binary in place", async () => {
  const h = await harness({ MESH_BUILD_CMD: "exit 1" });
  await writeFile(h.bin, "OLDBIN");

  const { code } = await runScript(h.env);
  expect(code).not.toBe(0);
  expect(await readFile(h.bin, "utf8")).toBe("OLDBIN");
});

shellTest("deploy: unhealthy after restart → non-zero, NO auto-rollback (stops and reports)", async () => {
  const h = await harness(); // no healthy server on the port → health check fails
  await writeFile(h.bin, "OLDBIN");

  const { code, err } = await runScript({ ...h.env, MESH_NOW: "20260608-000002" });
  expect(code).not.toBe(0);
  expect(await readFile(h.bin, "utf8")).toBe("NEWBIN"); // swap happened and was NOT undone
  expect(await readFile(join(h.backups, "mesh-20260608-000002"), "utf8")).toBe("OLDBIN");
  expect(err).toContain("--rollback");
});

shellTest("deploy: retention keeps only MESH_BACKUP_KEEP newest archives", async () => {
  const h = await harness({ MESH_BACKUP_KEEP: "2" });
  healthyServer(h.port);
  for (const ts of ["20260608-000001", "20260608-000002", "20260608-000003"]) {
    await writeFile(h.bin, `BIN-${ts}`);
    const { code } = await runScript({ ...h.env, MESH_NOW: ts });
    expect(code).toBe(0);
  }
  const keptAll = (await readdir(h.backups)).sort();
  const kept = keptAll.filter((name) => !name.endsWith(".build-id"));
  // 3 deploys archived 3 old binaries, but only the 2 newest are retained
  expect(kept).toEqual(["mesh-20260608-000002", "mesh-20260608-000003"]);
  expect(keptAll).toContain("mesh-20260608-000002.build-id");
  expect(keptAll).toContain("mesh-20260608-000003.build-id");
  expect(keptAll).not.toContain("mesh-20260608-000001.build-id");
});

shellTest("rollback: restores the newest archive and restarts healthy", async () => {
  const h = await harness();
  await mkdir(h.backups, { recursive: true });
  await writeFile(join(h.backups, "mesh-20260608-000001"), "OLD1");
  await writeFile(join(h.backups, "mesh-20260608-000001.build-id"), "20260608-000001\n");
  await writeFile(join(h.backups, "mesh-20260608-000002"), "OLD2"); // newest
  await writeFile(join(h.backups, "mesh-20260608-000002.build-id"), "20260608-000002\n");
  await writeFile(h.bin, "BADBIN");
  await writeFile(`${h.bin}.build-id`, "bad-build\n");
  healthyServer(h.port);

  const { code, out } = await runScript(h.env, "--rollback");
  expect({ code, out }).toMatchObject({ code: 0 });
  expect(await readFile(h.bin, "utf8")).toBe("OLD2"); // newest archive restored
  expect(await readFile(`${h.bin}.build-id`, "utf8")).toBe("20260608-000002\n");
  expect(await exists(join(h.backups, "mesh-20260608-000002"))).toBe(true); // archive preserved
});

shellTest("rollback: a specific timestamp restores that archive", async () => {
  const h = await harness();
  await mkdir(h.backups, { recursive: true });
  await writeFile(join(h.backups, "mesh-20260608-000001"), "OLD1");
  await writeFile(join(h.backups, "mesh-20260608-000002"), "OLD2");
  await writeFile(h.bin, "BADBIN");
  healthyServer(h.port);

  const { code } = await runScript(h.env, "--rollback", "20260608-000001");
  expect(code).toBe(0);
  expect(await readFile(h.bin, "utf8")).toBe("OLD1");
});

shellTest("rollback: with no archives errors and does not touch the binary", async () => {
  const h = await harness();
  await writeFile(h.bin, "CURRENT");

  const { code, err } = await runScript(h.env, "--rollback");
  expect(code).not.toBe(0);
  expect(err).toContain("no archived binary");
  expect(await readFile(h.bin, "utf8")).toBe("CURRENT");
});

shellTest("list: prints archived binaries newest-first", async () => {
  const h = await harness();
  await mkdir(h.backups, { recursive: true });
  await writeFile(join(h.backups, "mesh-20260608-000001"), "a");
  await writeFile(join(h.backups, "mesh-20260608-000002"), "b");

  const { code, out } = await runScript(h.env, "--list");
  expect(code).toBe(0);
  const lines = out.split("\n").filter((l) => l.includes("mesh-2026"));
  expect(lines[0]).toContain("mesh-20260608-000002"); // newest first
  expect(lines[1]).toContain("mesh-20260608-000001");
});
