// src/mesh-host-client.ts
// Parent-side handle for one mesh DAEMON. The daemon owns the socket; this client
// connects to it. It can either cold-start a daemon (spawn detached, then connect) or
// reattach to one that outlived a previous backend (connect only). On connect it sends
// `hello{resumeFrom}` and replays everything it missed, so the backend's view is rebuilt
// without disturbing the live agents. Disconnecting does NOT stop the daemon — only
// stop() (an explicit `mesh stop`) does.
import net from "node:net";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { killTree } from "./acp/client";
import { LineBuffer, encodeFrame, PROTO_VERSION, type ChildMsg, type MutationAckStatus, type ParentMsg } from "./protocol";
import type { AgentConfig, MeshConfig, MeshEdge, MeshEvent } from "./acp/types";
import type { PromptImageRef } from "./acp/types";
import type { RespawnMode, RespawnResult } from "./control-plane";
import type { BoardActor, BoardCommand, BoardCommandResult } from "./board";

/** Host-side acknowledgement for a config mutation (setMode/setModel/setEffort). */
export interface MutationAck {
  status: MutationAckStatus;
}

export interface MeshHostClientOptions {
  name: string;
  config: MeshConfig;
  socketPath: string;
  hostScript?: string; // defaults to the real mesh-host
  root?: string; // data root → passed to the daemon for the mailbox + registry location
  runDir?: string; // registry/session dir; required when socketPath is a Windows named pipe
  leaseMs?: number; // optional idle lease passed to the daemon (0 = survive indefinitely)
  debug?: boolean;
  onEvent?: (event: MeshEvent) => void;
  onExit?: (code: number) => void; // only fires for a daemon WE spawned
  onClose?: () => void; // the socket closed unexpectedly (daemon died / lost) — not on stop()
  rpcTimeoutMs?: number; // request/ack (respawn + mutation) waiter timeout; default 10s
}

const CONNECT_TIMEOUT_MS = 8000;
const READY_TIMEOUT_MS = 60_000;
const RESPAWN_TIMEOUT_MS = 10_000;
const MUTATION_ACK_TIMEOUT_MS = 10_000;

export class MeshHostClient {
  private conn?: net.Socket;
  private child?: ReturnType<typeof Bun.spawn>; // set only when we spawned the daemon
  private daemonPid?: number; // pid of the daemon (from spawn or from the registry on reattach)
  private lastSeq = 0;
  private exited = false; // a daemon WE spawned has exited
  private stopping = false;

  private ackResolve?: (a: { running: boolean; proto: number }) => void;
  private readyResolve?: () => void;
  private stoppedResolve?: () => void;
  private rpcSeq = 0;
  /** In-flight request/ack waiters keyed by reqId, shared by respawn and config-mutation acks.
   *  Every waiter is settled exactly once — by its result frame, its timeout, or a connection
   *  loss/takeover (rejectAllRpc) — so no waiter can leak or hang forever. */
  private rpcWaiters = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private opts: MeshHostClientOptions) {}

  get pid(): number | undefined {
    return this.child?.pid ?? this.daemonPid;
  }
  /** Last event sequence the parent has applied (for resume on a later reconnect). */
  get seq(): number {
    return this.lastSeq;
  }

  /** Cold start: spawn a detached daemon, then connect + handshake. */
  async start(): Promise<void> {
    this.spawnDaemon();
    await this.connectWithRetry(CONNECT_TIMEOUT_MS);
    await this.handshake();
  }

  /** Reattach to a daemon that's already running (no spawn). */
  async attach(record: { pid: number }, resumeFrom = 0): Promise<void> {
    this.daemonPid = record.pid;
    this.lastSeq = resumeFrom;
    await this.connectWithRetry(CONNECT_TIMEOUT_MS);
    await this.handshake();
  }

  private spawnDaemon(): void {
    const script = this.opts.hostScript ?? resolve(import.meta.dir, "mesh-host.ts");
    // Compiled single-binary: the host `.ts` isn't on disk → re-exec the binary itself
    // (it runs the host when MESH_SOCK/MESH_CONFIG are present). Dev: spawn the script.
    const cmd = existsSync(script) ? [process.execPath, script] : [process.execPath];
    // NOT detached: Bun resolves child.exited prematurely for detached children, which
    // would break liveness tracking. Unix doesn't kill children when the parent exits,
    // so the daemon already outlives this backend — it just ignores terminal signals
    // (SIGINT/SIGHUP) so Ctrl-C / closing the terminal can't take it down with us.
    this.child = Bun.spawn(cmd, {
      env: {
        ...process.env,
        MESH_SOCK: this.opts.socketPath,
        MESH_CONFIG: JSON.stringify(this.opts.config),
        MESH_DEBUG: this.opts.debug ? "1" : "0",
        MESH_LEASE_MS: String(this.opts.leaseMs ?? 0),
        ...(this.opts.root ? { MESH_ROOT: this.opts.root } : {}),
        ...(this.opts.runDir ? { MESH_RUN_DIR: this.opts.runDir } : {}),
      },
      stdin: "ignore",
      stdout: this.opts.debug ? "inherit" : "ignore",
      stderr: this.opts.debug ? "inherit" : "ignore",
    });
    this.daemonPid = this.child.pid;
    this.child.exited.then((code) => {
      this.exited = true;
      this.opts.onExit?.(code);
    });
  }

  /** Retry connecting to the daemon's socket until it's listening (it may still be
   *  coming up after a cold spawn), the deadline passes, or a spawned daemon dies. */
  private connectWithRetry(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const tryOnce = (): Promise<void> =>
      new Promise<void>((res, rej) => {
        if (this.exited) return rej(new Error(`mesh-host "${this.opts.name}" exited before ready`));
        const sock = net.connect(this.opts.socketPath);
        const onErr = () => {
          sock.destroy();
          if (Date.now() >= deadline) rej(new Error(`mesh-host "${this.opts.name}": connect timeout`));
          else setTimeout(() => tryOnce().then(res, rej), 60);
        };
        sock.once("error", onErr);
        sock.once("connect", () => {
          sock.removeListener("error", onErr);
          this.bind(sock);
          res();
        });
      });
    return tryOnce();
  }

  private get mutationTimeoutMs(): number { return this.opts.rpcTimeoutMs ?? MUTATION_ACK_TIMEOUT_MS; }
  private get respawnTimeoutMs(): number { return this.opts.rpcTimeoutMs ?? RESPAWN_TIMEOUT_MS; }

  /** Register a waiter for a request/ack RPC. Rejects immediately if there is no live
   *  connection to carry the request, otherwise arms a timeout. */
  private awaitRpc<T>(reqId: string, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.conn) {
        reject(new Error(`mesh-host "${this.opts.name}": ${label} has no connection`));
        return;
      }
      const timer = setTimeout(() => {
        this.rpcWaiters.delete(reqId);
        reject(new Error(`mesh-host "${this.opts.name}": ${label} timed out`));
      }, timeoutMs);
      this.rpcWaiters.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }

  /** Settle one waiter from an incoming result frame. */
  private settleRpc(reqId: string, error: string | undefined, value: unknown): void {
    const waiter = this.rpcWaiters.get(reqId);
    if (!waiter) return;
    this.rpcWaiters.delete(reqId);
    clearTimeout(waiter.timer);
    if (error) waiter.reject(new Error(error));
    else waiter.resolve(value);
  }

  /** Reject and clear every in-flight waiter — used when the connection is lost or replaced,
   *  since their result frames can never arrive on a dead/superseded socket. */
  private rejectAllRpc(err: Error): void {
    if (this.rpcWaiters.size === 0) return;
    const waiters = [...this.rpcWaiters.values()];
    this.rpcWaiters.clear();
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private bind(sock: net.Socket): void {
    // A new socket supersedes any prior one: its in-flight requests can never be answered.
    this.rejectAllRpc(new Error(`mesh-host "${this.opts.name}": connection replaced`));
    this.conn = sock;
    const lb = new LineBuffer();
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      for (const line of lb.push(chunk)) {
        let msg: ChildMsg;
        try {
          msg = JSON.parse(line) as ChildMsg;
        } catch {
          continue;
        }
        this.onMessage(msg);
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      if (this.conn === sock) {
        this.conn = undefined;
        // Any in-flight request/ack on this socket will never be answered now.
        this.rejectAllRpc(new Error(`mesh-host "${this.opts.name}": connection closed`));
        if (!this.stopping) this.opts.onClose?.();
      }
    });
  }

  private onMessage(msg: ChildMsg): void {
    switch (msg.t) {
      case "ack":
        this.ackResolve?.({ running: msg.running, proto: msg.proto });
        break;
      case "ready":
        this.readyResolve?.();
        break;
      case "replay":
        for (const e of msg.events) {
          if (e.seq > this.lastSeq) this.lastSeq = e.seq;
          this.opts.onEvent?.(e.event);
        }
        break;
      case "snapshot":
        for (const e of msg.events) this.opts.onEvent?.(e);
        break;
      case "event":
        if (msg.seq > this.lastSeq) this.lastSeq = msg.seq;
        this.opts.onEvent?.(msg.event);
        break;
      case "respawnResult":
        this.settleRpc(msg.reqId, msg.error, msg.result);
        break;
      case "cmdResult":
        this.settleRpc(msg.reqId, msg.error, msg.status ? { status: msg.status } : undefined);
        break;
      case "boardResult":
        // A board-level error (conflict/forbidden/...) rides inside `result` (it RESOLVES so
        // the REST layer can map it to a status); only a transport/exception uses `error`.
        this.settleRpc(msg.reqId, msg.error, msg.result);
        break;
      case "stopped":
        this.stoppedResolve?.();
        break;
    }
  }

  /** Send hello, await ack (+ replay); if the daemon isn't running yet, await ready. */
  private async handshake(): Promise<void> {
    const acked = new Promise<{ running: boolean; proto: number }>((res) => {
      this.ackResolve = res;
    });
    this.send({ t: "hello", proto: PROTO_VERSION, resumeFrom: this.lastSeq });
    const ack = await Promise.race([
      acked,
      Bun.sleep(CONNECT_TIMEOUT_MS).then(() => null),
    ]);
    if (!ack) throw new Error(`mesh-host "${this.opts.name}": no ack`);
    if (ack.proto !== PROTO_VERSION) {
      throw new Error(`mesh-host "${this.opts.name}": protocol mismatch (daemon ${ack.proto}, backend ${PROTO_VERSION})`);
    }
    if (!ack.running) {
      const ready = new Promise<void>((res) => {
        this.readyResolve = res;
      });
      let waitingForReady = true;
      const exitedFirst = this.child?.exited.then((code) => (waitingForReady ? { kind: "exited" as const, code } : { kind: "ignored" as const }));
      const won = await Promise.race([
        ready.then(() => ({ kind: "ready" as const })),
        Bun.sleep(READY_TIMEOUT_MS).then(() => ({ kind: "timeout" as const })),
        ...(exitedFirst ? [exitedFirst] : []),
      ]);
      waitingForReady = false;
      if (won.kind === "exited") throw new Error(`mesh-host "${this.opts.name}" exited (code ${won.code}) before ready`);
      if (won.kind !== "ready") throw new Error(`mesh-host "${this.opts.name}" not ready (${won.kind})`);
    }
  }

  private send(msg: ParentMsg): void {
    this.conn?.write(encodeFrame(msg));
  }

  prompt(target: string, text: string, images?: PromptImageRef[]): void { this.send({ t: "prompt", target, text, images }); }
  removeQueuedTurn(target: string, turnId: string): void { this.send({ t: "removeQueuedTurn", target, turnId }); }
  steer(target: string, text: string, images?: PromptImageRef[]): void { this.send({ t: "steer", target, text, images }); }
  resolve(requestId: string, optionId: string): void { this.send({ t: "resolve", requestId, optionId }); }
  setMode(target: string, modeId: string): Promise<MutationAck> {
    const reqId = `setMode-${++this.rpcSeq}`;
    const waiting = this.awaitRpc<MutationAck>(reqId, this.mutationTimeoutMs, `setMode ${target}`);
    this.send({ t: "setMode", target, modeId, reqId });
    return waiting;
  }
  setModel(target: string, modelId: string): Promise<MutationAck> {
    const reqId = `setModel-${++this.rpcSeq}`;
    const waiting = this.awaitRpc<MutationAck>(reqId, this.mutationTimeoutMs, `setModel ${target}`);
    this.send({ t: "setModel", target, modelId, reqId });
    return waiting;
  }
  setEffort(target: string, effort?: string): Promise<MutationAck> {
    const reqId = `setEffort-${++this.rpcSeq}`;
    const waiting = this.awaitRpc<MutationAck>(reqId, this.mutationTimeoutMs, `setEffort ${target}`);
    this.send({ t: "setEffort", target, effort, reqId });
    return waiting;
  }
  interrupt(target: string): void { this.send({ t: "interrupt", target }); }
  newSession(target: string): void { this.send({ t: "newSession", target }); }
  respawn(target: string, mode: RespawnMode): Promise<RespawnResult> {
    const reqId = `respawn-${++this.rpcSeq}`;
    const waiting = this.awaitRpc<RespawnResult>(reqId, this.respawnTimeoutMs, `respawn ${target}`);
    this.send({ t: "respawn", reqId, target, mode });
    return waiting;
  }
  boardCommand(actor: BoardActor, command: BoardCommand, expectedBoardRevision: number): Promise<BoardCommandResult> {
    const reqId = `board-${++this.rpcSeq}`;
    const waiting = this.awaitRpc<BoardCommandResult>(reqId, this.mutationTimeoutMs, `board ${command.type}`);
    this.send({ t: "board", reqId, actor, command, expectedBoardRevision });
    return waiting;
  }
  newAllSessions(): void { this.send({ t: "newAllSessions" }); }
  wakeAgent(target: string): void { this.send({ t: "wake", target }); }
  stopAgent(target: string): void { this.send({ t: "stopAgent", target }); }
  addEdge(edge: MeshEdge): void { this.send({ t: "addEdge", edge }); }
  addAgent(agent: AgentConfig, edges: MeshEdge[] = []): void { this.send({ t: "addAgent", agent, edges }); }

  /** Disconnect WITHOUT stopping the daemon (used on backend shutdown — the mesh and
   *  its agents keep running; a future backend reconnects). */
  disconnect(): void {
    this.conn?.destroy();
    this.conn = undefined;
  }

  /** Explicit stop: ask the daemon to reap its agents and exit, with a kill fallback. */
  async stop(timeoutMs = 5000): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.conn && !this.exited) {
      const stopped = new Promise<void>((res) => {
        this.stoppedResolve = res;
      });
      this.send({ t: "stop" });
      await Promise.race([stopped, Bun.sleep(timeoutMs)]);
    }
    const pid = this.pid;
    if (pid && !this.exited) {
      killTree(pid);
      if (this.child) await Promise.race([this.child.exited, Bun.sleep(3000)]);
      else {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0);
          } catch {
            break;
          }
          await Bun.sleep(50);
        }
      }
    }
    this.conn?.destroy();
    this.conn = undefined;
  }
}
