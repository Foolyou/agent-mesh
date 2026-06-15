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
import { HARNESSES } from "../harness";
import { parseAvailableCommands, parseTokenCount, parseUsageUpdate } from "./usage-compat";
import { killProcessTree } from "../os-shim";

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
  return command === HARNESSES.claude.command;
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
  void killProcessTree(pid, signal);
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

// codex-acp streams `usage_update` session notifications (token/context usage) as a
// liveness + cost heartbeat, but the ACP library's strict session-update schema rejects
// the kind outright ("Invalid params"), so the frame never reaches our sessionUpdate
// handler — it is dropped AND never counts as a turn signal. We intercept it at the raw
// ndjson layer BEFORE the library parses: hand the update to our own callback (so it
// feeds the cost waterline and the quiet-turn watchdog) and filter the frame out so the
// library never sees the unknown kind. Scoped to usage_update only — every other frame
// passes through byte-for-byte, so nothing the library already understands is diverted.
export function filterUsageUpdates(
  src: ReadableStream<Uint8Array>,
  onUsageUpdate: (update: any) => void,
): ReadableStream<Uint8Array> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl + 1); // keep the trailing newline for pass-through
        buf = buf.slice(nl + 1);
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            if (msg?.method === "session/update" && msg.params?.update?.sessionUpdate === "usage_update") {
              onUsageUpdate(msg.params.update);
              continue; // consume: keep it away from the library's strict schema
            }
          } catch {
            /* not parseable here; let the library handle it verbatim */
          }
        }
        controller.enqueue(enc.encode(line));
      }
    },
    flush(controller) {
      if (buf) controller.enqueue(enc.encode(buf));
    },
  });
  return src.pipeThrough(transform);
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
  onContextUsage?: (usage: { used: number; size: number; percent: number; cost?: number }) => void;
  onAvailableCommands?: (commands: string[]) => void;
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
  contextUsage: { used: number; size: number; percent: number; cost?: number } | null = null;
  advertisedCommands = new Set<string>();
  private child?: ReturnType<typeof Bun.spawn>;
  private conn?: ClientSideConnection;
  private rawRequestSeq = 0;
  private activeJob?: QueuedPrompt;
  private killed = false;

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
    const input = filterUsageUpdates(child.stdout as ReadableStream<Uint8Array>, (update) => {
      this.recordStreamState(update);
      this.opts.onPromptSignal?.(this.activeJob?.turn, update);
      this.opts.onUpdate?.(update);
    });
    const stream = ndJsonStream(output, input);

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
        this.recordStreamState(params.update);
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

  private recordStreamState(update: unknown): void {
    const usage = parseUsageUpdate(update);
    if (usage) {
      const contextUsage: { used: number; size: number; percent: number; cost?: number } = { used: usage.used, size: usage.size, percent: usage.usagePercent };
      if (usage.cost !== undefined) contextUsage.cost = usage.cost;
      this.contextUsage = contextUsage;
      this.opts.onContextUsage?.(contextUsage);
    }

    const tokenCount = parseTokenCount(update);
    if (tokenCount && tokenCount.contextWindow > 0) {
      const contextUsage = {
        used: tokenCount.lastTokens,
        size: tokenCount.contextWindow,
        percent: tokenCount.lastTokens / tokenCount.contextWindow,
      };
      this.contextUsage = contextUsage;
      this.opts.onContextUsage?.(contextUsage);
    }

    const commands = parseAvailableCommands(update);
    if (commands) {
      this.advertisedCommands = new Set(commands);
      this.opts.onAvailableCommands?.(commands);
    }
  }

  async newSession(mcpServers: any[] = []) {
    const params: any = { cwd: this.opts.cwd, mcpServers };
    if (isClaudeCommand(this.opts?.command)) params._meta = claudeRawSdkMeta();
    const res = await this.conn!.newSession(params);
    this.sessionId = res.sessionId;
    return res;
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: any[] = []) {
    const params: any = { sessionId, cwd, mcpServers };
    if (isClaudeCommand(this.opts?.command)) params._meta = claudeRawSdkMeta();
    const res = await this.conn!.loadSession(params);
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
    // Backstop for the respawn leak: a killed connection's child is gone, so a prompt enqueued
    // now would await an ACP request that never resolves. Reject synchronously instead — the
    // control plane should never route here (it re-checks conn currency), but if one slips
    // through, trackTurn()'s try/catch still runs finishTurn so the count is released.
    if (this.killed) throw new Error(`${this.id}: connection killed`);
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

  /** Switch a generic ACP session config option, e.g. thought_level/thinking. */
  async setConfigOption(configId: string, value: string) {
    if (!this.sessionId) return;
    if (!this.child) throw new Error(`${this.id}: no child process`);
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: `mesh-set-config-option-${++this.rawRequestSeq}`,
      method: "session/set_config_option",
      params: { sessionId: this.sessionId, configId, value },
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
    this.killed = true;
    const pid = this.child?.pid;
    if (pid) killTree(pid);
    this.alive = false;
    // The child is gone, so the in-flight ACP prompt request will never resolve on its own
    // (its stream just ends — the library does not reject pending requests on stream close).
    // Settle the in-flight and queued prompt promises so callers stop awaiting forever. In
    // particular this lets the control plane's trackTurn().finally run, so turnCounts does not
    // leak and an agent's activity does not stick on "working" after a respawn/new-session
    // supersede kills its old connection mid-turn.
    this.failPending(new Error(`${this.id}: connection killed`));
  }

  /** Reject the in-flight job and every queued job. State is cleared before rejecting so a
   *  rejection handler that re-enters (e.g. a resume-retry) cannot observe a half-killed conn,
   *  and pump() is intentionally NOT restarted — this connection is being discarded. */
  private failPending(err: unknown): void {
    const active = this.activeJob;
    const queued = this.queue;
    this.activeJob = undefined;
    this.queue = [];
    this.busy = false;
    if (active) active.reject(err);
    for (const job of queued) job.reject(err);
  }
}
