// AcpAgentConnection: one control-plane -> agent ACP connection.
// Spawns a harness process, speaks ACP over stdio via the Zed client library,
// and routes inbound session updates / permission requests to callbacks.
import "./notification-compat";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
} from "@zed-industries/agent-client-protocol";
import type { AgentTurn, PromptImageRef } from "./types";

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

function isClaudeCommand(command: string | undefined): boolean {
  return !!command && command.includes("claude");
}

function claudeRawSdkMeta(): { claudeCode: { emitRawSDKMessages: Array<Record<string, string>> } } {
  return {
    claudeCode: {
      emitRawSDKMessages: [
        { type: "rate_limit_event" },
        { type: "system", subtype: "api_retry" },
        { type: "system", subtype: "status" },
        { type: "system", subtype: "compact_boundary" },
      ],
    },
  };
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
  /** expose ACP filesystem tools to the agent; defaults to true */
  fs?: boolean;
  /** extra env layered on top of the stripped host env (e.g. MAX_THINKING_TOKENS for claude) */
  extraEnv?: Record<string, string>;
  onPromptQueued?: (turn: AgentTurn) => void;
  onPromptStarted?: (turn: AgentTurn) => void;
  onPromptSignal?: (turn: AgentTurn | undefined, signal: unknown) => void;
  onExtNotification?: (method: string, params: unknown, turn: AgentTurn | undefined) => void;
}

type PromptPlacement = "back" | "front";
type QueuedPrompt = {
  text: string;
  images: PromptImageRef[];
  priority: "normal" | "steer";
  turn?: AgentTurn;
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
  private activeJob?: QueuedPrompt;

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

    this.conn = new ClientSideConnection((): Client => this.clientHandlers() as Client, stream);

    child.exited.then((code) => {
      this.alive = false;
      LIVE.delete(this);
      this.opts.onExit?.(code);
    });
  }

  async initialize() {
    const clientCapabilities: Record<string, unknown> = { terminal: false };
    if (this.opts?.fs !== false) clientCapabilities.fs = { readTextFile: true, writeTextFile: true };
    const res = await this.conn!.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities,
    });
    this.supportsLoadSession = !!(res as any)?.agentCapabilities?.loadSession;
    return res;
  }

  private clientHandlers(): Client & { extNotification?: (notification: any, params?: unknown) => Promise<void> } {
    return {
      sessionUpdate: async (params: any) => {
        this.opts.onPromptSignal?.(this.activeJob?.turn, params.update);
        this.opts.onUpdate?.(params.update);
      },
      requestPermission: async (params: any) => {
        this.opts.onPromptSignal?.(this.activeJob?.turn, params);
        const options = params.options ?? [];
        let decision: PermissionDecision;
        if (this.opts.onPermission) {
          decision = await this.opts.onPermission(params);
        } else {
          const allow = options.find((o: any) => o.kind === "allow_once") ?? options[0];
          decision = allow ? { optionId: allow.optionId } : "cancel";
        }
        if (decision === "cancel") return { outcome: { outcome: "cancelled" } };
        return { outcome: { outcome: "selected", optionId: decision.optionId } };
      },
      extNotification: async (notification: any, params?: unknown) => {
        const method = typeof notification === "string" ? notification : notification?.method;
        const payload = typeof notification === "string" ? params : notification?.params;
        if (method === "_claude/sdkMessage") this.opts.onExtNotification?.(method, payload, this.activeJob?.turn);
      },
      writeTextFile: async (params: any) => {
        await mkdir(dirname(params.path), { recursive: true });
        await writeFile(params.path, params.content, "utf8");
        return {};
      },
      readTextFile: async (params: any) => {
        let content = await readFile(params.path, "utf8");
        if (params.line != null || params.limit != null) {
          const lines = content.split("\n");
          const start = (params.line ?? 1) - 1;
          const end = params.limit != null ? start + params.limit : lines.length;
          content = lines.slice(start, end).join("\n");
        }
        return { content };
      },
    };
  }

  async newSession(mcpServers: any[] = []) {
    const params: any = { cwd: this.opts.cwd, mcpServers };
    if (isClaudeCommand(this.opts.command)) params._meta = claudeRawSdkMeta();
    const res = await this.conn!.newSession(params);
    this.sessionId = res.sessionId;
    return res;
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: any[] = []) {
    const res = await this.conn!.loadSession({ sessionId, cwd, mcpServers });
    this.sessionId = sessionId;
    return { ...res, sessionId };
  }

  private busy = false;
  private queue: QueuedPrompt[] = [];

  /**
   * Send a prompt turn. Resolves with the PromptResponse (stopReason) when the
   * turn ends. Prompts to one agent are serialized: if a turn is in flight
   * (e.g. the agent was woken by mail while still working), the new prompt is
   * queued rather than sent concurrently (ACP allows one prompt turn at a time).
   */
  prompt(text: string, images: PromptImageRef[] = [], turn?: AgentTurn): Promise<any> {
    return this.enqueuePrompt(text, images, "back", turn);
  }

  /**
   * Queue a prompt ahead of ordinary queued prompts while preserving FIFO among
   * steer prompts. The job is placed before cancel is sent, so when the cancelled
   * in-flight turn settles and pump() runs, steer is already at the head. ACP
   * writes cancel before the later prompt; if no turn is in flight, cancel is a no-op.
   */
  steerPrompt(text: string, images: PromptImageRef[] = [], turn?: AgentTurn): Promise<any> {
    const wasBusy = this.busy;
    const queued = this.enqueuePrompt(text, images, "front", turn);
    if (wasBusy) {
      this.cancel().catch((err) => {
        console.warn(`${this.id}: steer cancel failed: ${String(err)}`);
      });
    }
    return queued;
  }

  private enqueuePrompt(text: string, images: PromptImageRef[], placement: PromptPlacement, turn?: AgentTurn): Promise<any> {
    if (!this.sessionId) throw new Error(`${this.id}: no session`);
    return new Promise((resolve, reject) => {
      const job: QueuedPrompt = { text, images, priority: placement === "front" ? "steer" : "normal", turn, resolve, reject };
      if (placement === "front") {
        const firstNormal = this.queue.findIndex((queued) => queued.priority !== "steer");
        if (firstNormal === -1) this.queue.push(job);
        else this.queue.splice(firstNormal, 0, job);
      } else {
        this.queue.push(job);
      }
      if (turn) this.opts.onPromptQueued?.(turn);
      void this.pump();
    });
  }

  /** Drop queued (not yet started) prompt turns matching `predicate`. Each removed
   *  job's promise resolves with `{ stopReason: "superseded" }` so fire-and-forget
   *  callers settle cleanly. The in-flight turn is never touched. */
  removeQueued(predicate: (turn: AgentTurn) => boolean): AgentTurn[] {
    const removed: AgentTurn[] = [];
    this.queue = this.queue.filter((job) => {
      if (!job.turn || !predicate(job.turn)) return true;
      removed.push(job.turn);
      job.resolve({ stopReason: "superseded" });
      return false;
    });
    return removed;
  }

  failActiveTurn(turnId: string, err: unknown): boolean {
    if (this.activeJob?.turn?.id !== turnId) return false;
    const job = this.activeJob;
    this.activeJob = undefined;
    this.busy = false;
    job.reject(err);
    return true;
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    this.activeJob = job;
    if (job.turn) this.opts.onPromptStarted?.(job.turn);
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
      if (this.activeJob === job) this.activeJob = undefined;
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
