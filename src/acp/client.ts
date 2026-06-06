// AcpAgentConnection: one control-plane -> agent ACP connection.
// Spawns a harness process, speaks ACP over stdio via the Zed client library,
// and routes inbound session updates / permission requests to callbacks.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
} from "@zed-industries/agent-client-protocol";

export type PermissionDecision = { optionId: string } | "cancel";

export interface AcpConnectionOptions {
  id: string;
  command: string;
  args: string[];
  cwd: string; // absolute
  onUpdate?: (update: any) => void;
  onPermission?: (req: any) => Promise<PermissionDecision>;
  onExit?: (code: number) => void;
  /** inherit agent stderr to this process (debugging) */
  debug?: boolean;
}

export class AcpAgentConnection {
  readonly id: string;
  sessionId?: string;
  alive = false;
  private child?: ReturnType<typeof Bun.spawn>;
  private conn?: ClientSideConnection;

  constructor(private opts: AcpConnectionOptions) {
    this.id = opts.id;
  }

  async start(): Promise<void> {
    const child = Bun.spawn([this.opts.command, ...this.opts.args], {
      cwd: this.opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: this.opts.debug ? "inherit" : "ignore",
      env: { ...process.env },
    });
    this.child = child;
    this.alive = true;

    const output = new WritableStream<Uint8Array>({
      write: (chunk) => {
        child.stdin.write(chunk);
        child.stdin.flush();
      },
      close: () => {
        child.stdin.end();
      },
    });
    const stream = ndJsonStream(output, child.stdout as ReadableStream<Uint8Array>);

    const self = this;
    this.conn = new ClientSideConnection(
      (): Client => ({
        async sessionUpdate(params: any) {
          self.opts.onUpdate?.(params.update);
        },
        async requestPermission(params: any) {
          const options = params.options ?? [];
          let decision: PermissionDecision;
          if (self.opts.onPermission) {
            decision = await self.opts.onPermission(params);
          } else {
            const allow =
              options.find((o: any) => o.kind === "allow_once") ?? options[0];
            decision = allow ? { optionId: allow.optionId } : "cancel";
          }
          if (decision === "cancel") return { outcome: { outcome: "cancelled" } };
          return { outcome: { outcome: "selected", optionId: decision.optionId } };
        },
        async writeTextFile(params: any) {
          await mkdir(dirname(params.path), { recursive: true });
          await writeFile(params.path, params.content, "utf8");
          return {};
        },
        async readTextFile(params: any) {
          let content = await readFile(params.path, "utf8");
          if (params.line != null || params.limit != null) {
            const lines = content.split("\n");
            const start = (params.line ?? 1) - 1;
            const end = params.limit != null ? start + params.limit : lines.length;
            content = lines.slice(start, end).join("\n");
          }
          return { content };
        },
      }),
      stream,
    );

    child.exited.then((code) => {
      self.alive = false;
      self.opts.onExit?.(code);
    });
  }

  async initialize() {
    return this.conn!.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    });
  }

  async newSession(mcpServers: any[] = []) {
    const res = await this.conn!.newSession({ cwd: this.opts.cwd, mcpServers });
    this.sessionId = res.sessionId;
    return res;
  }

  private busy = false;
  private queue: { text: string; resolve: (r: any) => void; reject: (e: any) => void }[] = [];

  /**
   * Send a prompt turn. Resolves with the PromptResponse (stopReason) when the
   * turn ends. Prompts to one agent are serialized: if a turn is in flight
   * (e.g. the agent was woken by mail while still working), the new prompt is
   * queued rather than sent concurrently (ACP allows one prompt turn at a time).
   */
  prompt(text: string): Promise<any> {
    if (!this.sessionId) throw new Error(`${this.id}: no session`);
    return new Promise((resolve, reject) => {
      this.queue.push({ text, resolve, reject });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    try {
      const res = await this.conn!.prompt({
        sessionId: this.sessionId!,
        prompt: [{ type: "text", text: job.text }],
      });
      job.resolve(res);
    } catch (err) {
      job.reject(err);
    } finally {
      this.busy = false;
      void this.pump();
    }
  }

  /** Switch the session's permission/approval mode (e.g. codex "read-only"). */
  async setMode(modeId: string) {
    if (this.sessionId) await this.conn!.setSessionMode({ sessionId: this.sessionId, modeId });
  }

  /** Interrupt the current turn (Router-authorized at the control-plane layer). */
  async cancel() {
    if (this.sessionId) await this.conn!.cancel({ sessionId: this.sessionId });
  }

  kill() {
    try {
      this.child?.kill();
    } catch {}
  }
}
