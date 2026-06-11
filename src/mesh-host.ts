// src/mesh-host.ts
// Subprocess body for one mesh, run as a DETACHABLE DAEMON: it owns the listening
// Unix socket (the parent MeshManager connects as a client), buffers ControlPlane
// events in a replayable ring, and SURVIVES the parent disconnecting — so the backend
// can restart and reconnect without killing the live agents. It stops only on an
// explicit `stop` command, a SIGTERM/SIGINT (`mesh kill`), or the idle/cold-start lease.
import net from "node:net";
import { join, dirname } from "node:path";
import { rm, mkdir } from "node:fs/promises";
import { ControlPlane, type ControlPlaneStopReason } from "./control-plane";
import { LineBuffer, encodeFrame, PROTO_VERSION, type ParentMsg, type SeqEvent } from "./protocol";
import { writeRecord, removeRecord } from "./mesh-registry";
import { now, type AgentConfig, type MeshConfig, type MeshEdge, type MeshEvent, type PromptImageRef } from "./acp/types";

/** The slice of ControlPlane the daemon depends on (keeps it unit-testable). */
export interface BridgeControlPlane {
  on(listener: (e: MeshEvent) => void): () => void;
  snapshotEvents(): MeshEvent[];
  prompt(target: string, text: string, images?: PromptImageRef[]): Promise<unknown>;
  removeQueuedTurn(target: string, turnId: string): boolean;
  steer(target: string, text: string, images?: PromptImageRef[]): Promise<void>;
  resolveDecision(requestId: string, optionId: string, by?: "human" | "timeout"): boolean;
  setMode(target: string, modeId: string): Promise<void>;
  setModel(target: string, modelId: string): Promise<void>;
  setEffort(target: string, effort?: string): Promise<void>;
  setBypass(target: string, bypass?: boolean): Promise<void>;
  interrupt(target: string): Promise<void>;
  newSession(target: string): Promise<void>;
  newAllSessions(): Promise<void>;
  wakeAgent(target: string): Promise<void>;
  stopAgent(target: string): Promise<void>;
  addEdge(edge: MeshEdge): void;
  addAgent(agent: AgentConfig, edges?: MeshEdge[]): void;
  stop(reason?: ControlPlaneStopReason): Promise<void>;
}

export interface MeshHostDaemonOptions {
  socketPath: string;
  /** max events retained for replay on (re)connect */
  ringCap?: number;
  /** self-stop after this long with no client, once one has connected (0 = never) */
  leaseMs?: number;
  /** self-stop if NO client ever connects within this long after listen (cold-start orphan guard) */
  startupGraceMs?: number;
  /** called after a clean stop (the entrypoint exits the process here) */
  onStopped?: () => void;
}

/** A mesh-host daemon: owns the socket, buffers events, serves one client at a time. */
export class MeshHostDaemon {
  private server?: net.Server;
  private client?: net.Socket;
  private ring: SeqEvent[] = [];
  private seq = 0;
  private ready = false;
  private stopping = false;
  private everConnected = false;
  private unsub?: () => void;
  private leaseTimer?: ReturnType<typeof setTimeout>;
  private readonly ringCap: number;
  private readonly leaseMs: number;
  private readonly startupGraceMs: number;
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(
    private cp: BridgeControlPlane,
    private opts: MeshHostDaemonOptions,
  ) {
    this.ringCap = opts.ringCap ?? 2000;
    this.leaseMs = opts.leaseMs ?? 0;
    this.startupGraceMs = opts.startupGraceMs ?? 120_000;
  }

  /** Begin buffering events and listen on the socket. Resolves once listening. */
  async listen(): Promise<void> {
    await mkdir(dirname(this.opts.socketPath), { recursive: true });
    this.unsub = this.cp.on((event) => this.onEvent(event));
    this.server = net.createServer((sock) => this.attach(sock));
    await new Promise<void>((res, rej) => {
      this.server!.once("error", rej);
      this.server!.listen(this.opts.socketPath, () => res());
    });
    this.armLease(); // cold-start grace until the first client connects
  }

  /** Agents are up: notify a connected client (and any that reconnects sees it via hello-ack). */
  markReady(): void {
    this.ready = true;
    if (this.client) this.write(this.client, { t: "ready" });
  }

  get currentSeq(): number {
    return this.seq;
  }

  private onEvent(event: MeshEvent): void {
    const item: SeqEvent = { seq: ++this.seq, event };
    this.ring.push(item);
    if (this.ring.length > this.ringCap) this.ring.splice(0, this.ring.length - this.ringCap);
    if (this.client) this.write(this.client, { t: "event", seq: item.seq, event });
  }

  private write(sock: net.Socket, m: unknown): void {
    try {
      sock.write(encodeFrame(m as Parameters<typeof encodeFrame>[0]));
    } catch {
      /* client went away mid-write */
    }
  }

  private enqueue(action: () => Promise<void> | void): void {
    const run = this.commandQueue.then(() => action());
    this.commandQueue = run.catch(() => {});
  }

  private attach(sock: net.Socket): void {
    if (this.client && this.client !== sock) this.client.destroy(); // latest client wins
    this.client = sock;
    this.everConnected = true;
    this.clearLease();
    const lb = new LineBuffer();
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      for (const line of lb.push(chunk)) {
        let msg: ParentMsg;
        try {
          msg = JSON.parse(line) as ParentMsg;
        } catch {
          continue;
        }
        this.handle(sock, msg);
      }
    });
    sock.on("close", () => {
      if (this.client === sock) {
        this.client = undefined;
        this.armLease();
      }
    });
    sock.on("error", () => {});
  }

  private handle(sock: net.Socket, msg: ParentMsg): void {
    switch (msg.t) {
      case "hello": {
        // replay everything the parent hasn't seen, then acknowledge with run state.
        const replay = this.ring.filter((e) => e.seq > msg.resumeFrom);
        if (replay.length) this.write(sock, { t: "replay", events: replay });
        this.write(sock, { t: "snapshot", events: this.cp.snapshotEvents() });
        this.write(sock, { t: "ack", proto: PROTO_VERSION, running: this.ready, seq: this.seq });
        break;
      }
      case "prompt":
        this.cp.prompt(msg.target, msg.text, msg.images).catch(() => {});
        break;
      case "removeQueuedTurn":
        this.cp.removeQueuedTurn(msg.target, msg.turnId);
        break;
      case "steer":
        this.cp.steer(msg.target, msg.text, msg.images).catch(() => {});
        break;
      case "resolve":
        this.cp.resolveDecision(msg.requestId, msg.optionId, "human");
        break;
      case "setMode":
        this.enqueue(() => this.cp.setMode(msg.target, msg.modeId));
        break;
      case "setModel":
        this.enqueue(() => this.cp.setModel(msg.target, msg.modelId));
        break;
      case "setEffort":
        this.enqueue(() => this.cp.setEffort(msg.target, msg.effort));
        break;
      case "setBypass":
        this.enqueue(() => this.cp.setBypass(msg.target, msg.bypass));
        break;
      case "interrupt":
        this.cp.interrupt(msg.target).catch(() => {});
        break;
      case "newSession":
        this.enqueue(() => this.cp.newSession(msg.target));
        break;
      case "newAllSessions":
        this.enqueue(() => this.cp.newAllSessions());
        break;
      case "wake":
        this.cp.wakeAgent(msg.target).catch(() => {});
        break;
      case "stopAgent":
        this.cp.stopAgent(msg.target).catch(() => {});
        break;
      case "addEdge":
        this.cp.addEdge(msg.edge);
        break;
      case "addAgent":
        this.cp.addAgent(msg.agent, msg.edges);
        break;
      case "stop":
        void this.stop("explicit");
        break;
    }
  }

  private armLease(): void {
    this.clearLease();
    const ms = this.everConnected ? this.leaseMs : this.startupGraceMs;
    if (ms > 0) this.leaseTimer = setTimeout(() => void this.stop("idle"), ms);
  }
  private clearLease(): void {
    if (this.leaseTimer) {
      clearTimeout(this.leaseTimer);
      this.leaseTimer = undefined;
    }
  }

  /** Graceful shutdown: stop agents, tell the client, tear down the socket. */
  async stop(reason: ControlPlaneStopReason = "shutdown"): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.clearLease();
    this.unsub?.();
    await this.cp.stop(reason).catch(() => {});
    if (this.client) this.write(this.client, { t: "stopped" });
    this.client?.destroy();
    this.server?.close();
    this.opts.onStopped?.();
  }
}

// --- entrypoint ----------------------------------------------------------------
// Reads MESH_SOCK / MESH_CONFIG / MESH_ROOT (+ optional MESH_LEASE_MS) from the
// environment and runs the daemon. Invoked either as a standalone `.ts` (dev) or via
// the main binary re-execing itself when MESH_SOCK is present — see src/main.ts.
export async function runMeshHost(): Promise<void> {
  const socketPath = process.env.MESH_SOCK;
  const configJson = process.env.MESH_CONFIG;
  if (!socketPath || !configJson) {
    console.error("mesh-host: MESH_SOCK and MESH_CONFIG are required");
    process.exit(2);
  }
  const config = JSON.parse(configJson) as MeshConfig;
  const root = process.env.MESH_ROOT;
  const runDir = dirname(socketPath); // sockets + registry records share ${root}/run
  const leaseMs = Number(process.env.MESH_LEASE_MS) || 0;

  const cp = new ControlPlane(config, {
    debug: process.env.MESH_DEBUG === "1",
    mailboxPath: root ? join(root, `${config.name}-mailbox.ndjson`) : undefined,
    uploadRoot: root ? join(root, "uploads") : undefined,
    sessionRunDir: runDir,
  });

  await rm(socketPath, { force: true }); // clear a stale socket from a prior crash
  const daemon = new MeshHostDaemon(cp, {
    socketPath,
    leaseMs,
    onStopped: () => void removeRecord(runDir, config.name).finally(() => process.exit(0)),
  });
  await daemon.listen();
  await writeRecord(runDir, { name: config.name, pid: process.pid, socketPath, proto: PROTO_VERSION, startedAt: now() });

  // `mesh kill` sends SIGTERM → reap agents + drop the registry record cleanly.
  process.on("SIGTERM", () => void daemon.stop("explicit"));
  // Survive the backend's terminal going away: ignore SIGINT (Ctrl-C) and SIGHUP so a
  // foreground backend's Ctrl-C / terminal close doesn't take the daemon down with it.
  // (The daemon is reclaimable via `mesh kill`, the stop command, or the idle lease.)
  process.on("SIGINT", () => {});
  process.on("SIGHUP", () => {});

  await cp.start(); // spawn agents; their startup events buffer into the ring meanwhile
  daemon.markReady();
}

if (import.meta.main) await runMeshHost();
