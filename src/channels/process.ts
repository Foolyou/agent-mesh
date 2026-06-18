// src/channels/process.ts
//
// The REAL (Bun.spawn-backed) implementations of the channel's subprocess seams. They are kept
// out of consumer.ts/sender.ts so those modules stay pure and unit-testable with fakes — this
// file is the only place that touches Bun.spawn, and it is exercised by live verification rather
// than unit tests.

import { LineBuffer } from "../protocol";
import type { ConsumerHandle, SpawnConsumer, SpawnHooks } from "./consumer";
import type { SendFn, SendResult } from "./sender";

export interface RealConsumerOptions {
  eventKey?: string; // default im.message.receive_v1
  identity?: string; // --as value; default "bot"
}

/** Build a SpawnConsumer that runs `lark-cli event consume <key> --as <identity>`.
 *  stdin is left piped and OPEN (never EOF'd) so the unbounded run is not torn down by EOF;
 *  terminate() sends SIGTERM (Bun's default signal) — never SIGKILL. */
export function realSpawnConsumer(opts: RealConsumerOptions = {}): SpawnConsumer {
  const eventKey = opts.eventKey ?? "im.message.receive_v1";
  const identity = opts.identity ?? "bot";
  return (hooks: SpawnHooks): ConsumerHandle => {
    const child = Bun.spawn(["lark-cli", "event", "consume", eventKey, "--as", identity], {
      stdin: "pipe", // kept open; never .end()'d until teardown
      stdout: "pipe",
      stderr: "pipe",
    });
    void pumpStream(child.stdout, hooks.onStdoutLine);
    void pumpStream(child.stderr, hooks.onStderrLine);
    return {
      terminate() {
        try {
          child.kill(); // Bun default signal is SIGTERM — deliberately no SIGKILL
        } catch {
          /* already gone */
        }
      },
      closeStdin() {
        try {
          child.stdin?.end();
        } catch {
          /* already closed */
        }
      },
      exited: child.exited.then((code) => (typeof code === "number" ? code : null)),
    };
  };
}

/** Build a SendFn that runs `lark-cli <args...>` once and resolves its exit code + stderr. */
export function realSend(): SendFn {
  return async (args: string[]): Promise<SendResult> => {
    const child = Bun.spawn(["lark-cli", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { code: typeof code === "number" ? code : 0, stderr: stderr.trim() || undefined };
  };
}

/** Read a Bun subprocess stream, splitting it into complete non-blank lines. */
async function pumpStream(stream: ReadableStream<Uint8Array> | null, onLine: (line: string) => void): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const lb = new LineBuffer();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) for (const line of lb.push(decoder.decode(value, { stream: true }))) onLine(line);
    }
  } catch {
    /* stream closed under us — exit handler drives recovery */
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}
