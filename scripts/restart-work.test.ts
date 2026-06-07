import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "restart-work.sh");
const children: Subprocess[] = [];
const extraPids: number[] = [];
const roots: string[] = [];

type Subprocess = ReturnType<typeof Bun.spawn>;

afterEach(async () => {
  for (const pid of extraPids.splice(0)) killIfAlive(pid);
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
      await child.exited;
    } catch {}
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function randomPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("no random port");
  return address.port;
}

async function waitForState(port: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/state`);
      if (res.ok) return await res.json();
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`backend on ${port} did not become healthy`);
}

async function listenerPid(port: number): Promise<number> {
  const out = await Bun.$`ss -ltnp`.quiet().text();
  const line = out
    .split("\n")
    .find((l) => l.includes(`:${port} `) || l.includes(`:${port}\t`));
  const pid = line?.match(/pid=(\d+)/)?.[1];
  if (!pid) throw new Error(`no listener pid for ${port}; ss output: ${out}`);
  return Number(pid);
}

async function hasHealthyState(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/state`);
    return res.ok;
  } catch {
    return false;
  }
}

function killIfAlive(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

test("restart-work safely restarts only the backend for a temp root and port", async () => {
  const root = await tempRoot("mesh-restart-safe-");
  const port = await randomPort();
  const initial = Bun.spawn(
    [
      "env",
      "-u",
      "MESH_SOCK",
      "-u",
      "MESH_CONFIG",
      "-u",
      "MESH_ROOT",
      "bun",
      "run",
      "src/main.ts",
      "--fake",
      "--no-master",
      "--port",
      String(port),
      "--root",
      root,
    ],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  children.push(initial);
  await waitForState(port);
  const oldPid = await listenerPid(port);

  const restart = Bun.spawn(
    ["env", "-u", "MESH_SOCK", "-u", "MESH_CONFIG", "-u", "MESH_ROOT", "bash", SCRIPT],
    {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        MESH_WORK_ROOT: root,
        MESH_WORK_PORT: String(port),
        MESH_LAUNCH_CMD: "env -u MESH_SOCK -u MESH_CONFIG -u MESH_ROOT bun run src/main.ts --fake --no-master",
      },
    },
  );
  const [code, stdout, stderr] = await Promise.all([restart.exited, restart.stdout.text(), restart.stderr.text()]);
  expect({ code, stdout, stderr }).toMatchObject({ code: 0 });

  await waitForState(port);
  const newPid = await listenerPid(port);
  extraPids.push(newPid);
  expect(newPid).not.toBe(oldPid);
  expect(stdout).toContain(`url: http://localhost:${port}`);
});

test("restart-work refuses cross-check mismatches without starting another backend", async () => {
  const root = await tempRoot("mesh-restart-refuse-");
  const port = await randomPort();
  const fakeListener = net.createServer((socket) => socket.end("not mesh\n"));
  await new Promise<void>((resolve) => fakeListener.listen(port, "127.0.0.1", resolve));
  try {
    const listenerBefore = await listenerPid(port);
    const restart = Bun.spawn(
      ["env", "-u", "MESH_SOCK", "-u", "MESH_CONFIG", "-u", "MESH_ROOT", "bash", SCRIPT],
      {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          MESH_WORK_ROOT: root,
          MESH_WORK_PORT: String(port),
          MESH_LAUNCH_CMD: "env -u MESH_SOCK -u MESH_CONFIG -u MESH_ROOT bun run src/main.ts --fake --no-master",
        },
      },
    );
    const [code, stdout, stderr] = await Promise.all([restart.exited, restart.stdout.text(), restart.stderr.text()]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("refusing");
    expect(stdout).not.toContain("starting backend:");
    expect(await listenerPid(port)).toBe(listenerBefore);
    expect(await hasHealthyState(port)).toBe(false);
  } finally {
    await new Promise<void>((resolve) => fakeListener.close(() => resolve()));
  }
});

test("restart-work --cold reaps registry daemons and removes their files", async () => {
  const root = await tempRoot("mesh-restart-cold-");
  const port = await randomPort();
  const runDir = join(root, "run");
  await mkdir(runDir, { recursive: true });

  const dummy = Bun.spawn(["sleep", "60"]);
  children.push(dummy);
  const sock = join(runDir, "demo.sock");
  const rec = join(runDir, "demo.json");
  await writeFile(sock, "");
  await writeFile(
    rec,
    JSON.stringify({ name: "demo", pid: dummy.pid, socketPath: sock, proto: 2, startedAt: new Date().toISOString() }),
  );

  const restart = Bun.spawn(
    ["env", "-u", "MESH_SOCK", "-u", "MESH_CONFIG", "-u", "MESH_ROOT", "bash", SCRIPT, "--cold"],
    {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        MESH_WORK_ROOT: root,
        MESH_WORK_PORT: String(port),
        MESH_LAUNCH_CMD: "env -u MESH_SOCK -u MESH_CONFIG -u MESH_ROOT bun run src/main.ts --fake --no-master",
      },
    },
  );
  const [code, stdout, stderr] = await Promise.all([restart.exited, restart.stdout.text(), restart.stderr.text()]);
  expect({ code, stdout, stderr }).toMatchObject({ code: 0 });

  await waitForState(port);
  extraPids.push(await listenerPid(port));
  await expect(Bun.file(rec).exists()).resolves.toBe(false);
  await expect(Bun.file(sock).exists()).resolves.toBe(false);
  const dummyExit = await Promise.race([dummy.exited, Bun.sleep(1000).then(() => undefined)]);
  expect(dummyExit).toBeDefined();
});
