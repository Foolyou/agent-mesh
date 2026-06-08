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
import type { PromptImageRef } from "./types";

export type PermissionDecision = { optionId: string } | "cancel";

/** The host's env minus every MESH_* control var, so spawned agents (and any command
 *  they run) can't accidentally re-exec the mesh binary as a mesh-host. */
export function agentEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("MESH_")) out[k] = v;
  }
  return out;
}

// --- process-tree teardown -------------------------------------------------
// Harnesses launch as a node wrapper that spawns a real binary child (e.g.
// codex-acp -> codex-acp-linux-x64). Killing only the wrapper orphans the
// grandchild, so we kill the whole descendant tree. We also install one set of
// process handlers so abrupt-but-catchable exits (SIGINT/SIGTERM/uncaught)
// still reap every agent. (SIGKILL cannot be caught; nothing can help there.)
export function killTree(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  const descendants: number[] = [];
  const collect = (p: number) => {
    let out = "";
    try {
      out = Bun.spawnSync(["pgrep", "-P", String(p)]).stdout.toString();
    } catch {}
    for (const line of out.split("\n")) {
      const child = Number.parseInt(line.trim(), 10);
      if (child) {
        descendants.push(child);
        collect(child);
      }
    }
  };
  collect(pid);
  for (const p of descendants.reverse()) {
    try {
      process.kill(p, signal);
    } catch {}
  }
  try {
    process.kill(pid, signal);
  } catch {}
}

const LIVE = new Set<AcpAgentConnection>();
let handlersInstalled = false;
function installCleanupHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const cleanup = () => {
    for (const c of LIVE) c.kill();
  };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      cleanup();
      process.exit(130);
    });
  }
  process.on("uncaughtException", (err) => {
    console.error(err);
    cleanup();
    process.exit(1);
  });
}

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
  /** extra env layered on top of the stripped host env (e.g. MAX_THINKING_TOKENS for claude) */
  extraEnv?: Record<string, string>;
}

type PromptPlacement = "back" | "front";
type QueuedPrompt = {
  text: string;
  images: PromptImageRef[];
  priority: "normal" | "steer";
  resolve: (r: any) => void;
  reject: (e: any) => void;
};

export class AcpAgentConnection {
  readonly id: string;
  sessionId?: string;
  supportsLoadSession = false;
  alive = false;
  private child?: ReturnType<typeof Bun.spawn>;
  private conn?: ClientSideConnection;
  private rawRequestSeq = 0;

  constructor(private opts: AcpConnectionOptions) {
    this.id = opts.id;
  }

  async start(): Promise<void> {
    const child = Bun.spawn([this.opts.command, ...this.opts.args], {
      cwd: this.opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: this.opts.debug ? "inherit" : "ignore",
      // Strip the mesh-host's control-plane env from agents (and any command they run).
      // A leaked MESH_SOCK/MESH_CONFIG would make a `mesh` / `bun src/main.ts` invocation
      // re-exec as a mesh-host instead of the CLI/backend — which is exactly how an agent
      // running the restart script spawned a duplicate host and took the backend down.
      // Agents reach the mesh via the injected MCP URL + prompt, never via env.
      // extraEnv is layered AFTER agentEnv() so per-agent vars (e.g. MAX_THINKING_TOKENS) apply
      // without re-introducing any stripped MESH_* control vars.
      env: { ...agentEnv(), ...(this.opts.extraEnv ?? {}) },
    });
    this.child = child;
    this.alive = true;
    LIVE.add(this);
    installCleanupHandlers();

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
      LIVE.delete(self);
      self.opts.onExit?.(code);
    });
  }

  async initialize() {
    const res = await this.conn!.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    });
    this.supportsLoadSession = !!(res as any)?.agentCapabilities?.loadSession;
    return res;
  }

  async newSession(mcpServers: any[] = []) {
    const res = await this.conn!.newSession({ cwd: this.opts.cwd, mcpServers });
    this.sessionId = res.sessionId;
    return res;
  }

  private busy = false;
  private queue: QueuedPrompt[] = [];

  /**
   * Send a prompt turn. Resolves with the PromptResponse (stopReason) when the
   * turn ends. Prompts to one agent are serialized: if a turn is in flight
   * (e.g. the agent was woken by mail while still working), the new prompt is
   * queued rather than sent concurrently (ACP allows one prompt turn at a time).
   */
  prompt(text: string, images: PromptImageRef[] = []): Promise<any> {
    return this.enqueuePrompt(text, images, "back");
  }

  /**
   * Queue a prompt ahead of ordinary queued prompts while preserving FIFO among
   * steer prompts. The job is placed before cancel is sent, so when the cancelled
   * in-flight turn settles and pump() runs, steer is already at the head. ACP
   * writes cancel before the later prompt; if no turn is in flight, cancel is a no-op.
   */
  steerPrompt(text: string, images: PromptImageRef[] = []): Promise<any> {
    const wasBusy = this.busy;
    const turn = this.enqueuePrompt(text, images, "front");
    if (wasBusy) {
      this.cancel().catch((err) => {
        console.warn(`${this.id}: steer cancel failed: ${String(err)}`);
      });
    }
    return turn;
  }

  private enqueuePrompt(text: string, images: PromptImageRef[], placement: PromptPlacement): Promise<any> {
    if (!this.sessionId) throw new Error(`${this.id}: no session`);
    return new Promise((resolve, reject) => {
      const job: QueuedPrompt = { text, images, priority: placement === "front" ? "steer" : "normal", resolve, reject };
      if (placement === "front") {
        const firstNormal = this.queue.findIndex((queued) => queued.priority !== "steer");
        if (firstNormal === -1) this.queue.push(job);
        else this.queue.splice(firstNormal, 0, job);
      } else {
        this.queue.push(job);
      }
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    try {
      const prompt: any[] = [{ type: "text", text: job.text }];
      for (const image of job.images) {
        if (!image.path) {
          console.warn(`${this.id}: skipping image ${image.id} without path`);
          continue;
        }
        try {
          const bytes = await readFile(image.path);
          prompt.push({ type: "image", mimeType: image.mimeType, data: bytes.toString("base64") });
        } catch (err) {
          console.warn(`${this.id}: skipping unreadable image ${image.id}: ${String(err)}`);
        }
      }
      const res = await this.conn!.prompt({
        sessionId: this.sessionId!,
        prompt,
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

  /** Switch the session's model when the agent advertises ACP configOptions(model). */
  async setModel(modelId: string) {
    if (!this.sessionId) return;
    if (!this.child) throw new Error(`${this.id}: no child process`);
    // WORKAROUND (@zed-industries/agent-client-protocol@0.4.5): setSessionModel() is bugged —
    // it sends "session/set_mode" instead of "session/set_model" (dist/acp.js:434). We can't use
    // conn.setSessionModel(); extMethod() also mangles the name with a "_" prefix which the agent
    // rejects. So we write the raw session/set_model line straight to child.stdin (the same sink
    // `output` writes to), bypassing stream.writable's per-message writer lock to avoid racing the
    // library's Connection.#writeQueue. Fire-and-forget: the library doesn't track our response id
    // and drops it; we optimistically re-emit agent_models.
    // TODO: once upstream fixes setSessionModel, delete this raw-write and call
    // conn.setSessionModel({ sessionId, modelId }) instead.
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: `mesh-set-model-${++this.rawRequestSeq}`,
      method: "session/set_model",
      params: { sessionId: this.sessionId, modelId },
    }) + "\n";
    const stdin = this.child.stdin;
    if (!stdin || typeof stdin === "number") throw new Error(`${this.id}: child stdin is not writable`);
    stdin.write(new TextEncoder().encode(line));
    stdin.flush();
  }

  /** Interrupt the current turn (Router-authorized at the control-plane layer). */
  async cancel() {
    if (this.sessionId) await this.conn!.cancel({ sessionId: this.sessionId });
  }

  kill() {
    LIVE.delete(this);
    const pid = this.child?.pid;
    if (pid) killTree(pid);
    this.alive = false;
  }
}
