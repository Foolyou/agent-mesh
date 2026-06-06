// src/mesh-host-client.ts
// Parent-side handle for one mesh subprocess: owns the listening Unix socket,
// spawns the mesh-host, parses its event stream, and exposes typed commands.
import net from "node:net";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { killTree } from "./acp/client";
import { LineBuffer, encodeFrame, type ChildMsg, type ParentMsg } from "./protocol";
import type { MeshConfig, MeshEvent } from "./acp/types";

export interface MeshHostClientOptions {
  name: string;
  config: MeshConfig;
  socketPath: string;
  hostScript?: string; // defaults to the real mesh-host
  debug?: boolean;
  onEvent?: (event: MeshEvent) => void;
  onExit?: (code: number) => void;
}

export class MeshHostClient {
  private server?: net.Server;
  private conn?: net.Socket;
  private child?: ReturnType<typeof Bun.spawn>;
  private readyResolve?: () => void;
  private stoppedResolve?: () => void;
  private exited = false;

  constructor(private opts: MeshHostClientOptions) {}

  get pid(): number | undefined { return this.child?.pid; }

  async start(): Promise<void> {
    await rm(this.opts.socketPath, { force: true });
    const ready = new Promise<void>((res) => { this.readyResolve = res; });

    this.server = net.createServer((sock) => this.attach(sock));
    await new Promise<void>((res) => this.server!.listen(this.opts.socketPath, res));

    const script = this.opts.hostScript ?? resolve(import.meta.dir, "mesh-host.ts");
    this.child = Bun.spawn([process.execPath, script], {
      env: {
        ...process.env,
        MESH_SOCK: this.opts.socketPath,
        MESH_CONFIG: JSON.stringify(this.opts.config),
        MESH_DEBUG: this.opts.debug ? "1" : "0",
      },
      stdin: "ignore",
      stdout: this.opts.debug ? "inherit" : "ignore",
      stderr: this.opts.debug ? "inherit" : "ignore",
    });
    this.child.exited.then((code) => {
      this.exited = true;
      this.opts.onExit?.(code);
    });

    await ready;
  }

  private attach(sock: net.Socket): void {
    this.conn = sock;
    const lb = new LineBuffer();
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      for (const line of lb.push(chunk)) {
        let msg: ChildMsg;
        try { msg = JSON.parse(line) as ChildMsg; } catch { continue; }
        if (msg.t === "ready") this.readyResolve?.();
        else if (msg.t === "event") this.opts.onEvent?.(msg.event);
        else if (msg.t === "stopped") this.stoppedResolve?.();
      }
    });
  }

  private send(msg: ParentMsg): void {
    this.conn?.write(encodeFrame(msg));
  }

  prompt(target: string, text: string): void { this.send({ t: "prompt", target, text }); }
  resolve(requestId: string, optionId: string): void { this.send({ t: "resolve", requestId, optionId }); }
  setMode(target: string, modeId: string): void { this.send({ t: "setMode", target, modeId }); }

  async stop(timeoutMs = 5000): Promise<void> {
    if (!this.exited && this.conn) {
      const stopped = new Promise<void>((res) => { this.stoppedResolve = res; });
      this.send({ t: "stop" });
      await Promise.race([stopped, Bun.sleep(timeoutMs)]);
    }
    if (this.child && !this.exited) {
      killTree(this.child.pid);
      // Wait for the child process to fully exit after the kill signal
      await Promise.race([this.child.exited, Bun.sleep(3000)]);
    }
    this.conn?.destroy();
    this.server?.close();
    await rm(this.opts.socketPath, { force: true });
  }
}
