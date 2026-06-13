import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type HostOs = "linux" | "darwin" | "win32";
export const HOST_OS: HostOs = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
export const IS_WINDOWS = HOST_OS === "win32";

export type PtyBackend = {
  write(data: string | Uint8Array): void;
  kill(): void;
  exited: Promise<number>;
};

export type PtyBackendOpts = {
  command: string;
  cwd: string;
  rawLogPath: string;
  env?: Record<string, string | undefined>;
  onData?: (data: string) => void;
};

type SpawnSyncResult = { stdout?: string | Uint8Array; stderr?: string | Uint8Array; exitCode?: number | null };
type SpawnSyncFn = (cmd: string[]) => SpawnSyncResult;
type KillFn = (pid: number, signal?: NodeJS.Signals | number) => void;

export function ptySpawnArgsForPlatform(platform: HostOs, command: string, _rawLogPath: string): string[] {
  if (platform === "win32") return ["cmd.exe", "/d", "/s", "/c", command];
  if (platform === "darwin") {
    // BSD/macOS `script` differs from util-linux: command argv follows the
    // typescript file argument and command strings with spaces need `sh -c`.
    // Verify on real macOS before changing; this is locked by os-shim.test.ts.
    return ["script", "-q", "/dev/null", "sh", "-c", command];
  }
  return ["script", "-qfec", command, "/dev/null"];
}

function text(value: string | Uint8Array | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

export function parseSsPid(out: string, port: number): number | null {
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes("LISTEN")) continue;
    if (!line.includes(`:${port} `) && !line.includes(`:${port}\t`)) continue;
    const m = line.match(/pid=(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

export function parseLsofPid(out: string): number | null {
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes("LISTEN")) continue;
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[1]);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return null;
}

export function parseNetstatPid(out: string, port: number): number | null {
  for (const line of out.split(/\r?\n/)) {
    if (!/\bLISTENING\b/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const local = parts[1] ?? "";
    if (!local.endsWith(`:${port}`)) continue;
    const pid = Number(parts.at(-1));
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return null;
}

export function createOsShimForTest(opts: { platform: HostOs; spawnSync?: SpawnSyncFn; kill?: KillFn }) {
  const spawnSync: SpawnSyncFn =
    opts.spawnSync ??
    ((cmd) => {
      const r = Bun.spawnSync(cmd);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    });
  const kill: KillFn = opts.kill ?? ((pid, signal) => process.kill(pid, signal));

  function findPidOnPort(port: number): number | null {
    try {
      if (opts.platform === "win32") return parseNetstatPid(text(spawnSync(["netstat", "-ano"]).stdout), port);
      if (opts.platform === "darwin") return parseLsofPid(text(spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).stdout));
      return parseSsPid(text(spawnSync(["ss", "-ltnp"]).stdout), port);
    } catch {
      return null;
    }
  }

  async function portInUse(port: number): Promise<boolean> {
    return findPidOnPort(port) !== null;
  }

  async function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    if (opts.platform === "win32") {
      try {
        spawnSync(["taskkill", "/T", "/F", "/PID", String(pid)]);
      } catch {}
      return;
    }
    const descendants: number[] = [];
    const collect = (p: number) => {
      let out = "";
      try {
        out = text(spawnSync(["pgrep", "-P", String(p)]).stdout);
      } catch {}
      for (const line of out.split(/\r?\n/)) {
        const child = Number.parseInt(line.trim(), 10);
        if (child) {
          descendants.push(child);
          collect(child);
        }
      }
    };
    collect(pid);
    for (const child of descendants.reverse()) {
      try {
        kill(child, signal);
      } catch {}
    }
    try {
      kill(pid, signal);
    } catch {}
  }

  return { findPidOnPort, portInUse, killProcessTree };
}

const realShim = createOsShimForTest({ platform: HOST_OS });

export const findPidOnPort = realShim.findPidOnPort;
export const portInUse = realShim.portInUse;
export const killProcessTree = realShim.killProcessTree;

async function spawnScriptPtyImpl(input: PtyBackendOpts, args: string[]): Promise<PtyBackend> {
  await mkdir(dirname(resolve(input.cwd, input.rawLogPath)), { recursive: true });
  const child = Bun.spawn(args, {
    cwd: input.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...input.env,
      TERM: input.env?.TERM || process.env.TERM || "xterm-256color",
      COLUMNS: input.env?.COLUMNS || process.env.COLUMNS || "100",
      LINES: input.env?.LINES || process.env.LINES || "30",
    },
  });

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  async function pumpOutput(stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const data = decoder.decode(value);
      input.onData?.(data);
      appendFile(resolve(input.cwd, input.rawLogPath), data, "utf8").catch(() => {});
    }
  }
  pumpOutput(child.stdout).catch((error) => console.error(error));
  pumpOutput(child.stderr).catch((error) => console.error(error));
  return {
    write(data: string | Uint8Array): void {
      const bytes = typeof data === "string" ? encoder.encode(data) : data;
      child.stdin.write(bytes);
      child.stdin.flush();
    },
    kill(): void {
      child.kill();
    },
    exited: child.exited,
  };
}

export async function createPtyBackend(input: PtyBackendOpts): Promise<PtyBackend> {
  if (HOST_OS === "win32") {
    const message = "PTY unavailable on Windows in v1; falling back to non-tty mode. ConPTY support is planned for a later release.\n";
    input.onData?.(message);
    await mkdir(dirname(resolve(input.cwd, input.rawLogPath)), { recursive: true });
    await appendFile(resolve(input.cwd, input.rawLogPath), message, "utf8").catch(() => {});
    const child = Bun.spawn(ptySpawnArgsForPlatform("win32", input.command, resolve(input.cwd, input.rawLogPath)), {
      cwd: input.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...input.env },
    });
    return {
      write(data: string | Uint8Array): void {
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        child.stdin.write(bytes);
        child.stdin.flush();
      },
      kill(): void {
        child.kill();
      },
      exited: child.exited,
    };
  }
  return spawnScriptPtyImpl(input, ptySpawnArgsForPlatform(HOST_OS, input.command, resolve(input.cwd, input.rawLogPath)));
}
