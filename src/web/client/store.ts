// Client store: a tiny external store (no Redux/zustand) fed by one WebSocket.
// `applyMsg` is the pure reducer over ServerMsg, mirroring the gateway's folding on
// the client. createStore() owns the socket + REST command helpers; useStore wires it
// into React via useSyncExternalStore.
import { useSyncExternalStore } from "react";
import type { AgentConfig, GatewayState, ServerMsg, PerMeshState, TranscriptItem, ConvRef, MeshConfig, MeshEdge, PromptImageRef, StartSessionStrategy, HarnessProbeRow, HarnessId, HarnessInstallEvent, RespawnMode, TranscriptSnapshot } from "../types";

const CAP = 500;
const HARNESS_CHANGE_DEBOUNCE_MS = 300;
const HARNESS_LIST_RETRY_DELAYS_MS = [200, 500];
function cap<T>(a: T[], n: number): T[] {
  return a.length > n ? a.slice(a.length - n) : a;
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function emptyState(): GatewayState {
  return { meshes: [], assistant: { status: "absent", transcript: [], capabilities: { image: false } }, perMesh: {} };
}

function emptyPerMesh(name: string): PerMeshState {
  return { config: { name, agents: [], edges: [] }, transcripts: {}, activity: [], mail: [], pending: [], history: [], modes: {}, models: {}, efforts: {}, capabilities: {}, usage: {}, health: {}, selfAwareness: {}, queues: {} };
}
function withPerMesh(state: GatewayState, name: string, fn: (pm: PerMeshState) => PerMeshState): GatewayState {
  const pm = state.perMesh[name] ?? emptyPerMesh(name);
  return { ...state, perMesh: { ...state.perMesh, [name]: fn(pm) } };
}
function upsertItem(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  const i = items.findIndex((x) => x.id === item.id);
  return i >= 0 ? [...items.slice(0, i), item, ...items.slice(i + 1)] : [...items, item];
}
function patchItem(items: TranscriptItem[], id: string, p: Partial<TranscriptItem>): TranscriptItem[] {
  return items.map((it) => (it.id === id ? ({ ...it, ...p } as TranscriptItem) : it));
}
function transcriptSnapshot(items: TranscriptItem[], previous?: TranscriptSnapshot): TranscriptSnapshot {
  const first = items[0];
  return {
    items,
    hasMore: previous?.hasMore ?? false,
    ...(first ? { oldestSeq: first.id } : {}),
  };
}
function withTranscript(state: GatewayState, conv: ConvRef, fn: (items: TranscriptItem[]) => TranscriptItem[]): GatewayState {
  if (conv.scope === "assistant") {
    return { ...state, assistant: { ...state.assistant, transcript: fn(state.assistant.transcript) } };
  }
  return withPerMesh(state, conv.mesh, (pm) => ({
    ...pm,
    transcripts: { ...pm.transcripts, [conv.agent]: transcriptSnapshot(fn(pm.transcripts[conv.agent]?.items ?? []), pm.transcripts[conv.agent]) },
  }));
}

export function applyMsg(state: GatewayState, msg: ServerMsg): GatewayState {
  switch (msg.t) {
    case "snapshot":
      return msg.state;
    case "mesh.list":
      return { ...state, meshes: msg.meshes };
    case "mesh.status":
      return { ...state, meshes: state.meshes.map((m) => (m.name === msg.name ? { ...m, status: msg.status } : m)) };
    case "agent.status":
      return {
        ...state,
        meshes: state.meshes.map((m) =>
          m.name === msg.name
            ? { ...m, agents: m.agents.map((a) => (a.id === msg.agent ? { ...a, status: msg.status } : a)) }
            : m,
        ),
      };
    case "agent.activity":
      return {
        ...state,
        meshes: state.meshes.map((m) =>
          m.name === msg.name
            ? { ...m, agents: m.agents.map((a) => (a.id === msg.agent ? { ...a, activity: msg.activity } : a)) }
            : m,
        ),
      };
    case "agent.modes":
      return withPerMesh(state, msg.name, (pm) => ({
        ...pm,
        modes: { ...pm.modes, [msg.agent]: { current: msg.current, available: msg.available } },
      }));
    case "agent.models":
      return withPerMesh(state, msg.name, (pm) => ({
        ...pm,
        models: { ...pm.models, [msg.agent]: { current: msg.current, available: msg.available } },
        config: pm.config,
      }));
    case "agent.efforts":
      return withPerMesh(state, msg.name, (pm) => ({
        ...pm,
        efforts: { ...pm.efforts, [msg.agent]: { configId: msg.configId, current: msg.current, available: msg.available } },
      }));
    case "agent.capabilities":
      return withPerMesh(state, msg.name, (pm) => ({
        ...pm,
        capabilities: { ...pm.capabilities, [msg.agent]: { image: msg.image } },
      }));
    case "agent.usage":
      return withPerMesh(state, msg.name, (pm) => ({
        ...pm,
        usage: { ...pm.usage, [msg.agent]: msg.usage },
      }));
    case "agent.health":
      return withPerMesh(state, msg.name, (pm) => ({
        ...pm,
        health:
          msg.health.signal === "compact_done"
            ? Object.fromEntries(Object.entries(pm.health).filter(([agent]) => agent !== msg.agent))
            : { ...pm.health, [msg.agent]: msg.health },
      }));
    case "agent.selfAwareness":
      return withPerMesh(state, msg.name, (pm) => ({
        ...pm,
        selfAwareness: { ...pm.selfAwareness, [msg.agent]: { ...(pm.selfAwareness[msg.agent] ?? {}), ...msg.selfAwareness } },
      }));
    case "agent.queue":
      return withPerMesh(state, msg.name, (pm) => ({
        ...pm,
        queues: { ...pm.queues, [msg.agent]: msg.summary },
      }));
    case "assistant.capabilities":
      return { ...state, assistant: { ...state.assistant, capabilities: { image: msg.image, harness: msg.harness } } };
    case "transcript.upsert":
      return withTranscript(state, msg.conv, (items) => upsertItem(items, msg.item));
    case "transcript.patch":
      return withTranscript(state, msg.conv, (items) => patchItem(items, msg.id, msg.patch));
    case "activity":
      return withPerMesh(state, msg.name, (pm) => ({ ...pm, activity: cap([...pm.activity, msg.entry], CAP) }));
    case "mail":
      return withPerMesh(state, msg.name, (pm) => ({ ...pm, mail: cap([...pm.mail, msg.entry], CAP) }));
    case "permission.add":
      return withPerMesh(state, msg.name, (pm) => ({ ...pm, pending: [...pm.pending, msg.req] }));
    case "permission.remove":
      return withPerMesh(state, msg.name, (pm) => ({
        ...pm,
        pending: pm.pending.filter((p) => p.requestId !== msg.resolved.requestId),
        history: cap([...pm.history, msg.resolved], CAP),
      }));
    case "assistant.status":
      return { ...state, assistant: { ...state.assistant, status: msg.status, working: msg.working ?? state.assistant.working } };
    default:
      return state;
  }
}

// ── The live store (browser) ─────────────────────────────────────────────────
const enc = encodeURIComponent;

export interface Toast {
  id: number;
  kind: "error" | "info";
  text: string;
}

export interface UpgradeState {
  available: boolean;
  current?: string;
  next?: string;
}

export interface Store {
  getState(): GatewayState;
  subscribe(cb: () => void): () => void;
  wsConnected(): boolean;
  getToasts(): Toast[];
  getUpgrade(): UpgradeState;
  apply(msg: ServerMsg): void;
  dismissToast(id: number): void;
  startMesh(name: string, sessionStrategy?: StartSessionStrategy): Promise<any>;
  stopMesh(name: string): Promise<any>;
  reload(): Promise<any>;
  defineMesh(config: MeshConfig): Promise<any>;
  deleteMesh(name: string): Promise<any>;
  uploadImages(bucket: string, files: File[]): Promise<PromptImageRef[]>;
  promptRouter(name: string, text: string, images?: PromptImageRef[]): Promise<any>;
  promptAgent(name: string, agentId: string, text: string, images?: PromptImageRef[]): Promise<any>;
  removeQueuedTurn(name: string, agentId: string, turnId: string): Promise<any>;
  steerAgent(name: string, agentId: string, text: string, images?: PromptImageRef[]): Promise<any>;
  promptAssistant(text: string, images?: PromptImageRef[]): Promise<any>;
  resolvePermission(name: string, requestId: string, optionId: string): Promise<any>;
  setMode(name: string, agentId: string, modeId: string): Promise<any>;
  setModel(name: string, agentId: string, modelId: string): Promise<any>;
  setEffort(name: string, agentId: string, effort?: string): Promise<any>;
  addEdge(name: string, edge: MeshEdge): Promise<any>;
  addAgent(name: string, agent: AgentConfig, edges?: MeshEdge[]): Promise<any>;
  interruptAgent(name: string, agentId: string): Promise<any>;
  wakeAgent(name: string, agentId: string): Promise<any>;
  stopAgent(name: string, agentId: string): Promise<any>;
  newAgentSession(name: string, agentId: string): Promise<any>;
  newAllSessions(name: string): Promise<any>;
  respawnAgent(name: string, agentId: string, mode: RespawnMode): Promise<any>;
  isTranscriptInitialLoaded(mesh: string, agentId: string): boolean;
  loadInitialTranscript(mesh: string, agentId: string): Promise<void>;
  loadOlderTranscript(mesh: string, agentId: string): Promise<void>;
  listHarnesses(): Promise<HarnessProbeRow[]>;
  installHarness(id: HarnessId): Promise<{ jobId: string; status: "running" | "done"; harnessId: HarnessId; pkgSpec: string }>;
  streamHarnessInstall(id: HarnessId, jobId: string, onEvent: (event: HarnessInstallEvent) => void, onClose?: (err?: Error) => void): Promise<void>;
  reprobeHarness(id: HarnessId): Promise<any>;
  interruptAssistant(): Promise<any>;
}

export function createStore(): Store {
  let state = emptyState();
  let connected = false;
  let everConnected = false;
  let toasts: Toast[] = [];
  let loadedAppVersion: string | undefined;
  let upgrade: UpgradeState = { available: false };
  let toastSeq = 0;
  let harnessChangeTimer: ReturnType<typeof setTimeout> | undefined;
  let harnessListInFlight: Promise<HarnessProbeRow[]> | undefined;
  const initialLoadedTranscripts = new Set<string>();
  const loadingInitialTranscript = new Map<string, Promise<void>>();
  const loadingOlderTranscript = new Map<string, Promise<void>>();
  const subs = new Set<() => void>();
  const emit = () => {
    for (const s of subs) s();
  };
  const set = (next: GatewayState) => {
    state = next;
    emit();
  };
  function noteSnapshotVersion(next?: string) {
    if (!next) return;
    if (!loadedAppVersion) {
      loadedAppVersion = next;
      return;
    }
    if (next !== loadedAppVersion) {
      upgrade = { available: true, current: loadedAppVersion, next };
    }
  }
  function applyIncoming(msg: ServerMsg) {
    if (msg.t === "snapshot") noteSnapshotVersion(msg.state.appVersion);
    if (msg.t === "harnesses-changed") {
      if (harnessChangeTimer !== undefined) clearTimeout(harnessChangeTimer);
      harnessChangeTimer = setTimeout(() => {
        harnessChangeTimer = undefined;
        emit();
      }, HARNESS_CHANGE_DEBOUNCE_MS);
      return;
    }
    set(applyMsg(state, msg));
  }
  function pushToast(kind: Toast["kind"], text: string) {
    const id = ++toastSeq;
    toasts = [...toasts, { id, kind, text }];
    emit();
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
      emit();
    }, kind === "error" ? 7000 : 3500);
  }
  /** Surface a failed command as a toast (and still reject for inline handlers). */
  function guard<T>(p: Promise<T>, label: string): Promise<T> {
    return p.catch((e: any) => {
      pushToast("error", `${label}: ${String(e?.message ?? e)}`);
      throw e;
    });
  }
  async function withRetries<T>(fn: () => Promise<T>, retryDelaysMs: number[]): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const delayMs = retryDelaysMs[attempt];
        if (delayMs === undefined) break;
        await sleep(delayMs);
      }
    }
    throw lastError;
  }
  function listHarnesses(): Promise<HarnessProbeRow[]> {
    if (!harnessListInFlight) {
      harnessListInFlight = guard(
        withRetries(() => send("GET", "/api/harnesses") as Promise<HarnessProbeRow[]>, HARNESS_LIST_RETRY_DELAYS_MS),
        "list harnesses",
      ).finally(() => {
        harnessListInFlight = undefined;
      });
    }
    return harnessListInFlight;
  }
  const transcriptKey = (mesh: string, agentId: string) => `${mesh}:${agentId}`;
  function replaceTranscriptItems(mesh: string, agentId: string, items: TranscriptItem[], hasMore: boolean): void {
    set(withPerMesh(state, mesh, (pm) => ({
      ...pm,
      transcripts: {
        ...pm.transcripts,
        [agentId]: {
          items,
          hasMore,
          ...(items[0] ? { oldestSeq: items[0].id } : {}),
        },
      },
    })));
  }
  function prependTranscriptItems(mesh: string, agentId: string, items: TranscriptItem[], hasMore: boolean): void {
    set(withPerMesh(state, mesh, (pm) => {
      const previous = pm.transcripts[agentId];
      const nextItems = [...items, ...(previous?.items ?? [])];
      return {
        ...pm,
        transcripts: {
          ...pm.transcripts,
          [agentId]: {
            items: nextItems,
            hasMore,
            ...(nextItems[0] ? { oldestSeq: nextItems[0].id } : {}),
          },
        },
      };
    }));
  }
  function isTranscriptInitialLoaded(mesh: string, agentId: string): boolean {
    return initialLoadedTranscripts.has(transcriptKey(mesh, agentId));
  }
  function loadInitialTranscript(mesh: string, agentId: string): Promise<void> {
    const current = state.perMesh[mesh]?.transcripts[agentId];
    if (!current?.hasMore || initialLoadedTranscripts.has(transcriptKey(mesh, agentId))) return Promise.resolve();
    const key = transcriptKey(mesh, agentId);
    const existing = loadingInitialTranscript.get(key);
    if (existing) return existing;
    const params = new URLSearchParams();
    params.set("limit", "100");
    const request = guard(
      send("GET", `/api/meshes/${enc(mesh)}/agents/${enc(agentId)}/transcript?${params.toString()}`) as Promise<{ items?: TranscriptItem[]; hasMore?: boolean }>,
      `load transcript ${agentId}`,
    )
      .then((res) => {
        const items = Array.isArray(res.items) ? res.items : [];
        initialLoadedTranscripts.add(key);
        replaceTranscriptItems(mesh, agentId, items, res.hasMore === true);
      })
      .finally(() => {
        loadingInitialTranscript.delete(key);
      });
    loadingInitialTranscript.set(key, request);
    return request;
  }
  function loadOlderTranscript(mesh: string, agentId: string): Promise<void> {
    const current = state.perMesh[mesh]?.transcripts[agentId];
    if (!current?.hasMore) return Promise.resolve();
    const key = `${mesh}:${agentId}`;
    const existing = loadingOlderTranscript.get(key);
    if (existing) return existing;
    const params = new URLSearchParams();
    if (current.oldestSeq) params.set("before", current.oldestSeq);
    params.set("limit", "100");
    const request = guard(
      send("GET", `/api/meshes/${enc(mesh)}/agents/${enc(agentId)}/transcript?${params.toString()}`) as Promise<{ items?: TranscriptItem[]; hasMore?: boolean }>,
      `load older transcript ${agentId}`,
    )
      .then((res) => {
        prependTranscriptItems(mesh, agentId, Array.isArray(res.items) ? res.items : [], res.hasMore === true);
      })
      .finally(() => {
        loadingOlderTranscript.delete(key);
      });
    loadingOlderTranscript.set(key, request);
    return request;
  }

  let delay = 500;
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      connected = true;
      delay = 500;
      if (everConnected) pushToast("info", "reconnected");
      everConnected = true;
      emit();
    };
    ws.onmessage = (ev) => {
      try {
        applyIncoming(JSON.parse(String(ev.data)) as ServerMsg);
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      const was = connected;
      connected = false;
      if (was) pushToast("info", "connection lost — reconnecting…");
      emit();
      const d = delay;
      delay = Math.min(delay * 2, 5000);
      setTimeout(connect, d);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
  }
  if (typeof window !== "undefined") connect();

  async function send(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
    return json;
  }
  const post = (path: string, body?: unknown) => send("POST", path, body);
  async function streamHarnessInstall(id: HarnessId, jobId: string, onEvent: (event: HarnessInstallEvent) => void, onClose?: (err?: Error) => void): Promise<void> {
    try {
      const res = await fetch(`/api/harnesses/${enc(id)}/install/${enc(jobId)}/stream`);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          onEvent(JSON.parse(line) as HarnessInstallEvent);
        }
      }
      buf += decoder.decode();
      if (buf.trim()) onEvent(JSON.parse(buf) as HarnessInstallEvent);
      onClose?.();
    } catch (err: any) {
      const e = err instanceof Error ? err : new Error(String(err));
      onClose?.(e);
      throw e;
    }
  }
  async function uploadImages(bucket: string, files: File[]): Promise<PromptImageRef[]> {
    const fd = new FormData();
    for (const file of files) fd.append("files", file, file.name);
    const res = await fetch(`/api/uploads?bucket=${enc(bucket)}`, { method: "POST", body: fd });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
    return json as PromptImageRef[];
  }

  return {
    getState: () => state,
    subscribe: (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    wsConnected: () => connected,
    getToasts: () => toasts,
    getUpgrade: () => upgrade,
    apply: (msg) => applyIncoming(msg),
    dismissToast: (id) => {
      toasts = toasts.filter((t) => t.id !== id);
      emit();
    },
    // fire-and-forget commands surface failures as toasts; defineMesh stays raw so
    // the builder can show its validation error inline.
    startMesh: (n, sessionStrategy) => guard(post(`/api/meshes/${enc(n)}/start`, sessionStrategy === "fresh" ? { sessionStrategy } : undefined), `start ${n}`),
    stopMesh: (n) => guard(post(`/api/meshes/${enc(n)}/stop`), `stop ${n}`),
    reload: () => guard(post(`/api/meshes/reload`), "reload"),
    defineMesh: (c) => post(`/api/meshes`, c),
    deleteMesh: (n) => guard(send("DELETE", `/api/meshes/${enc(n)}`), `delete ${n}`),
    uploadImages: (bucket, files) => guard(uploadImages(bucket, files), "upload images"),
    promptRouter: (n, t, images) => guard(post(`/api/meshes/${enc(n)}/prompt`, { text: t, images }), `prompt ${n}`),
    promptAgent: (n, a, t, images) => guard(post(`/api/meshes/${enc(n)}/agents/${enc(a)}/prompt`, { text: t, images }), `prompt ${a}`),
    removeQueuedTurn: (n, a, turnId) => guard(send("DELETE", `/api/meshes/${enc(n)}/agents/${enc(a)}/queue/${enc(turnId)}`), `remove queued message`),
    steerAgent: (n, a, t, images) => guard(post(`/api/meshes/${enc(n)}/agents/${enc(a)}/steer`, { text: t, images }), `steer ${a}`),
    promptAssistant: (t, images) => guard(post(`/api/assistant/prompt`, { text: t, images }), "assistant"),
    interruptAssistant: () => guard(post(`/api/assistant/interrupt`), "interrupt assistant"),
    resolvePermission: (n, r, o) => guard(post(`/api/meshes/${enc(n)}/permissions/${enc(r)}/resolve`, { optionId: o }), "resolve permission"),
    setMode: (n, a, m) => guard(post(`/api/meshes/${enc(n)}/agents/${enc(a)}/mode`, { modeId: m }), `set mode ${a}`),
    setModel: (n, a, m) => guard(post(`/api/meshes/${enc(n)}/agents/${enc(a)}/model`, { modelId: m }), `set model ${a}`),
    setEffort: (n, a, e) => guard(post(`/api/meshes/${enc(n)}/agents/${enc(a)}/effort`, { effort: e }), `set effort ${a}`),
    addEdge: (n, edge) => guard(post(`/api/meshes/${enc(n)}/edges`, edge), `add edge ${edge.from}->${edge.to}`),
    addAgent: (n, agent, edges = []) => guard(post(`/api/meshes/${enc(n)}/agents`, { agent, edges }), `add agent ${agent.id}`),
    interruptAgent: (n, a) => guard(post(`/api/meshes/${enc(n)}/agents/${enc(a)}/interrupt`), `interrupt ${a}`),
    wakeAgent: (n, a) => guard(post(`/api/meshes/${enc(n)}/agents/${enc(a)}/wake`), `wake ${a}`),
    stopAgent: (n, a) => guard(post(`/api/meshes/${enc(n)}/agents/${enc(a)}/stop`), `stop ${a}`),
    newAgentSession: (n, a) => guard(post(`/api/meshes/${enc(n)}/agents/${enc(a)}/session`), `new session ${a}`),
    newAllSessions: (n) => guard(post(`/api/meshes/${enc(n)}/session`), `new sessions ${n}`),
    respawnAgent: (n, a, mode) => guard(post(`/api/meshes/${enc(n)}/agents/${enc(a)}/respawn`, { mode }), `respawn ${a}`),
    isTranscriptInitialLoaded,
    loadInitialTranscript,
    loadOlderTranscript,
    listHarnesses,
    installHarness: (id) => guard(post(`/api/harnesses/${enc(id)}/install`), `install ${id}`),
    streamHarnessInstall,
    reprobeHarness: (id) => guard(post(`/api/harnesses/${enc(id)}/reprobe`), `reprobe ${id}`),
  };
}

export function useStore(store: Store): GatewayState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
export function useConnected(store: Store): boolean {
  return useSyncExternalStore(store.subscribe, store.wsConnected, store.wsConnected);
}
export function useToasts(store: Store): Toast[] {
  return useSyncExternalStore(store.subscribe, store.getToasts, store.getToasts);
}
export function useUpgrade(store: Store): UpgradeState {
  return useSyncExternalStore(store.subscribe, store.getUpgrade, store.getUpgrade);
}
