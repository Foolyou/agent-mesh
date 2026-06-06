import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type PtyBackend = {
  write(data: string | Uint8Array): void;
  kill(): void;
  exited: Promise<number>;
};

export async function spawnScriptPty(input: {
  command: string;
  cwd: string;
  rawLogPath: string;
  env?: Record<string, string | undefined>;
  onData?: (data: string) => void;
}): Promise<PtyBackend> {
  await mkdir(dirname(resolve(input.cwd, input.rawLogPath)), { recursive: true });

  const child = Bun.spawn(["script", "-qfec", input.command, "/dev/null"], {
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
    if (!stream) {
      return;
    }

    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const data = decoder.decode(value);
      input.onData?.(data);
      appendFile(resolve(input.cwd, input.rawLogPath), data, "utf8").catch(() => {});
    }
  }

  pumpOutput(child.stdout).catch((error) => {
    console.error(error);
  });
  pumpOutput(child.stderr).catch((error) => {
    console.error(error);
  });

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
