// src/channels/consumer.ts
//
// Supervises a `lark-cli event consume im.message.receive_v1 --as bot` subprocess and turns its
// NDJSON stdout into InboundMsg callbacks. The lark-cli subprocess contract (see the lark-event
// skill) is honored precisely:
//   - HANDSHAKE: block until the stderr ready-marker `[event] ready event_key=...` appears
//     BEFORE processing any stdout. No sleep is ever used as a synchronization primitive.
//   - stdin is kept open (piped, never EOF'd) so an unbounded run is not taken down by EOF;
//     teardown closes it / SIGTERMs the child.
//   - exit codes are classified structurally (2/3 => fatal: validation/auth — never tight-loop;
//     everything else => exponential backoff reconnect). Structured `{"ok":false,"error":{...}}`
//     stderr envelopes are parsed for logging, never regex-matched for control flow.
//   - teardown uses SIGTERM only (NEVER SIGKILL — that would leak server-side subscriptions);
//     once stop() is called the supervisor never reconnects.
//
// All subprocess behavior is funneled through the injectable SpawnConsumer seam so the handshake
// gate, backoff schedule, and no-orphan teardown are deterministically unit-testable with a fake.

import type { InboundMsg } from "./types";

/** Handle to one spawned consumer subprocess. Implementations MUST NOT expose SIGKILL. */
export interface ConsumerHandle {
  /** Send SIGTERM to the child. Implementations MUST NOT use SIGKILL/`kill -9`. */
  terminate(): void;
  /** Close the child's stdin — an alternative graceful-stop signal. */
  closeStdin(): void;
  /** Resolves with the exit code (or null for signal termination) when the child exits. */
  readonly exited: Promise<number | null>;
}

export interface SpawnHooks {
  onStdoutLine(line: string): void;
  onStderrLine(line: string): void;
}

/** Spawn a consumer subprocess wired to the given hooks. Injected so tests need no real CLI. */
export type SpawnConsumer = (hooks: SpawnHooks) => ConsumerHandle;

export const READY_MARKER = "[event] ready event_key=";

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** A child that stayed ready at least this long before exiting resets the backoff. */
  resetAfterMs: number;
}
export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1000, maxMs: 30000, resetAfterMs: 10000 };

export interface LarkConsumerOptions {
  onMessage: (msg: InboundMsg) => void;
  spawn: SpawnConsumer;
  log?: (msg: string) => void;
  backoff?: Partial<BackoffOptions>;
  /** Max wait after the first SIGTERM before re-sending a SECOND SIGTERM (never SIGKILL). */
  teardownGraceMs?: number;
  // ── injectable for deterministic tests ──
  setTimer?: (fn: () => void, ms: number) => () => void; // returns a cancel fn
  now?: () => number;
  random?: () => number; // [0,1)
}

/** Parse one lark-cli `im.message.receive_v1` NDJSON line into an InboundMsg.
 *  Returns undefined for non-JSON lines or events missing required identity fields. */
export function parseInbound(line: string): InboundMsg | undefined {
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!o || typeof o !== "object") return undefined;
  const eventId = str(o.event_id);
  const chatId = str(o.chat_id);
  const senderId = str(o.sender_id);
  const chatType = o.chat_type === "group" ? "group" : o.chat_type === "p2p" ? "p2p" : undefined;
  if (!eventId || !chatId || !senderId || !chatType) return undefined;
  return {
    eventId,
    chatId,
    chatType,
    senderId,
    messageType: str(o.message_type) || "text",
    text: str(o.content),
  };
}

/** Extract a compact summary from a structured `{"ok":false,"error":{...}}` stderr envelope,
 *  or undefined if the line is not such an envelope. Used for logging only — never control flow. */
export function parseErrorEnvelope(line: string): string | undefined {
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!o || o.ok !== false || !o.error || typeof o.error !== "object") return undefined;
  const e = o.error;
  const parts = [e.type, e.subtype, e.param, e.hint].filter((p: unknown) => typeof p === "string" && p.length > 0);
  return parts.length ? parts.join(" / ") : "error";
}

export class LarkConsumer {
  private readonly opts: LarkConsumerOptions;
  private readonly backoff: BackoffOptions;
  private readonly log: (msg: string) => void;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly teardownGraceMs: number;

  private handle?: ConsumerHandle;
  private ready = false;
  private readyAt = 0;
  private attempts = 0;
  private stopping = false; // user asked to stop — never reconnect
  private stopped = false; // fatal exit — never reconnect
  private cancelBackoff?: () => void;

  constructor(opts: LarkConsumerOptions) {
    this.opts = opts;
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
    this.log = opts.log ?? (() => {});
    this.setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? (() => Math.random());
    this.teardownGraceMs = opts.teardownGraceMs ?? 5000;
  }

  /** Whether the current child has cleared the ready handshake. */
  get isReady(): boolean {
    return this.ready;
  }

  start(): void {
    if (this.stopped || this.stopping || this.handle) return;
    this.spawnOnce();
  }

  private spawnOnce(): void {
    this.ready = false;
    let stderrLast: string | undefined;
    const handle = this.opts.spawn({
      onStderrLine: (line) => {
        if (!this.ready && line.includes(READY_MARKER)) {
          this.ready = true;
          this.readyAt = this.now();
          this.log(`lark consumer: ready (handshake complete)`);
          return;
        }
        const env = parseErrorEnvelope(line);
        if (env) {
          stderrLast = env;
          this.log(`lark consumer: stderr error envelope: ${env}`);
        }
      },
      onStdoutLine: (line) => {
        // HANDSHAKE GATE: never process stdout until the ready marker has been seen.
        if (!this.ready) return;
        const msg = parseInbound(line);
        if (msg) this.opts.onMessage(msg);
      },
    });
    this.handle = handle;
    handle.exited.then((code) => this.onExit(code ?? null, stderrLast));
  }

  private onExit(code: number | null, stderrLast?: string): void {
    const wasReady = this.ready;
    const upMs = wasReady ? this.now() - this.readyAt : 0;
    this.handle = undefined;
    this.ready = false;
    if (this.stopping || this.stopped) return; // teardown / fatal — no reconnect

    // Exit codes 2 (validation / duplicate bus) and 3 (auth / missing scope) are fatal: a
    // restart would just reproduce them, so we mark stopped and never tight-loop.
    if (code === 2 || code === 3) {
      this.stopped = true;
      this.log(`lark consumer: fatal exit code ${code} (validation/auth)${stderrLast ? ` — ${stderrLast}` : ""}; not restarting`);
      return;
    }

    if (wasReady && upMs >= this.backoff.resetAfterMs) this.attempts = 0;
    const delay = this.nextDelay();
    this.attempts++;
    this.log(`lark consumer: exited (code ${code}); reconnecting in ${delay}ms (attempt ${this.attempts})`);
    this.cancelBackoff = this.setTimer(() => {
      this.cancelBackoff = undefined;
      if (!this.stopping && !this.stopped) this.spawnOnce();
    }, delay);
  }

  /** Exponential backoff with +0..20% jitter, capped at maxMs. Uses attempts BEFORE increment. */
  private nextDelay(): number {
    const exp = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** this.attempts);
    return Math.round(exp + exp * 0.2 * this.random());
  }

  /** Stop the consumer: cancel any pending reconnect, SIGTERM a live child, and await its exit.
   *  After the grace window a SECOND SIGTERM is sent — never SIGKILL. Once called, no reconnect. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.cancelBackoff) {
      this.cancelBackoff();
      this.cancelBackoff = undefined;
    }
    const handle = this.handle;
    if (!handle) return;
    handle.terminate(); // SIGTERM
    await this.awaitExitWithGrace(handle);
  }

  private awaitExitWithGrace(handle: ConsumerHandle): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const cancel = this.setTimer(() => {
        if (settled) return;
        // Grace elapsed and the child is still alive: re-send SIGTERM ONCE more. Never SIGKILL.
        this.log(`lark consumer: teardown grace elapsed; re-sending SIGTERM`);
        handle.terminate();
      }, this.teardownGraceMs);
      handle.exited.then(() => {
        settled = true;
        cancel();
        resolve();
      });
    });
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
