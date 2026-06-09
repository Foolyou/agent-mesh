// Client store: a tiny external store (no Redux/zustand) fed by one WebSocket.
// `applyMsg` is the pure reducer over ServerMsg, mirroring the gateway's folding on
// the client. createStore() owns the socket + REST command helpers; useStore wires it
// into React via useSyncExternalStore.
import { useSyncExternalStore } from "react";
import type { AgentConfig, GatewayState, ServerMsg, PerMeshState, TranscriptItem, ConvRef, MeshConfig, MeshEdge, PromptImageRef, ThinkingEffort, StartSessionStrategy } from "../types";

const CAP = 500;
function cap<T>(a: T[], n: number): T[] {
  return a.length > n ? a.slice(a.length - n) : a;
}

export function emptyState(): GatewayState {
  return { meshes: [], master: { status: "absent", transcript: [], capabilities: { image: false } }, perMesh: {} };
}

function emptyPerMesh(name: string): PerMeshState {
  return { config: { name, agents: [], edges: [] }, transcripts: {}, activity: [], mail: [], pending: [], history: [], modes: {}, models: {}, capabilities: {} };
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
function withTranscript(state: GatewayState, conv: ConvRef, fn: (items: TranscriptItem[]) => TranscriptItem[]): GatewayState {
  if (conv.scope === "master") {
    return { ...state, master: { ...state.master, transcript: fn(state.master.transcript) } };
  }
  return withPerMesh(state, conv.mesh, (pm) => ({
    ...pm,
    transcripts: { ...pm.transcripts, [conv.agent]: fn(pm.transcripts[conv.agent] ?? []) },
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
    case "agent.capabilities":
      return withPerMesh(state, msg.name, (pm) => ({
        ...pm,
        capabilities: { ...pm.capabilities, [msg.agent]: { image: msg.image } },
      }));
    case "master.capabilities":
      return { ...state, master: { ...state.master, capabilities: { image: msg.image } } };
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
    case "master.status":
      return { ...state, master: { ...state.master, status: msg.status, working: msg.working ?? state.master.working } };
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

export interface Store {
  getState(): GatewayState;
  subscribe(cb: () => void): () => void;
  wsConnected(): boolean;
  getToasts(): Toast[];
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
  steerAgent(name: string, agentId: string, text: string, images?: PromptImageRef[]): Promise<any>;
  promptMaster(text: string, images?: PromptImageRef[]): Promise<any>;
  resolvePermission(name: string, requestId: string, optionId: string): Promise<any>;
  setMode(name: string, agentId: string, modeId: string): Promise<any>;
  setModel(name: string, agentId: string, modelId: string): Promise<any>;
  setEffort(name: string, agentId: string, effort?: ThinkingEffort): Promise<any>;
  addEdge(name: string, edge: MeshEdge): Promise<any>;
  addAgent(name: string, agent: AgentConfig, edges?: MeshEdge[]): Promise<any>;
  interruptAgent(name: string, agentId: string): Promise<any>;
  wakeAgent(name: string, agentId: string): Promise<any>;
  newAgentSession(name: string, agentId: string): Promise<any>;
  newAllSessions(name: string): Promise<any>;
  interruptMaster(): Promise<any>;
}

export function createStore(): Store {
  let state = emptyState();
  let connected = false;
  let everConnected = false;
  let toasts: Toast[] = [];
  let toastSeq = 0;
  const subs = new Set<() => void>();
  const emit = () => {
    for (const s of subs) s();
  };
  const set = (next: GatewayState) => {
    state = next;
    emit();
  };
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
        set(applyMsg(state, JSON.parse(String(ev.data)) as ServerMsg));
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
    apply: (msg) => set(applyMsg(state, msg)),
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
    steerAgent: (n, a, t, images) => guard(post(`/api/meshes/${enc(n)}/agents/${enc(a)}/steer`, { text: t, images }), `steer ${a}`),
    promptMaster: (t, images) => guard(post(`/api/master/prompt`, { text: t, images }), "master"),
    interruptMaster: () => guard(post(`/api/master/interrupt`), "interrupt master"),
    resolvePermission: (n, r, o) => guard(post(`/api/meshes/${enc(n)}/permissions/${enc(r)}/resolve`, { optionId: o }), "resolve permission"),
    setMode: (n, a, m) => guard(post(`/api/meshes/${enc(n)}/agents/${enc(a)}/mode`, { modeId: m }), `set mode ${a}`),
    setModel: (n, a, m) => guard(post(`/api/meshes/${enc(n)}/agents/${enc(a)}/model`, { modelId: m }), `set model ${a}`),
    setEffort: (n, a, e) => guard(post(`/api/meshes/${enc(n)}/agents/${enc(a)}/effort`, { effort: e }), `set effort ${a}`),
    addEdge: (n, edge) => guard(post(`/api/meshes/${enc(n)}/edges`, edge), `add edge ${edge.from}->${edge.to}`),
    addAgent: (n, agent, edges = []) => guard(post(`/api/meshes/${enc(n)}/agents`, { agent, edges }), `add agent ${agent.id}`),
    interruptAgent: (n, a) => guard(post(`/api/meshes/${enc(n)}/agents/${enc(a)}/interrupt`), `interrupt ${a}`),
    wakeAgent: (n, a) => guard(post(`/api/meshes/${enc(n)}/agents/${enc(a)}/wake`), `wake ${a}`),
    newAgentSession: (n, a) => guard(post(`/api/meshes/${enc(n)}/agents/${enc(a)}/session`), `new session ${a}`),
    newAllSessions: (n) => guard(post(`/api/meshes/${enc(n)}/session`), `new sessions ${n}`),
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
