// Client store: a tiny external store (no Redux/zustand) fed by one WebSocket.
// `applyMsg` is the pure reducer over ServerMsg, mirroring the gateway's folding on
// the client. createStore() owns the socket + REST command helpers; useStore wires it
// into React via useSyncExternalStore.
import { useSyncExternalStore } from "react";
import type { GatewayState, ServerMsg, PerMeshState, TranscriptItem, ConvRef, MeshConfig } from "../types";

const CAP = 500;
function cap<T>(a: T[], n: number): T[] {
  return a.length > n ? a.slice(a.length - n) : a;
}

export function emptyState(): GatewayState {
  return { meshes: [], master: { status: "absent", transcript: [] }, perMesh: {} };
}

function emptyPerMesh(name: string): PerMeshState {
  return { config: { name, agents: [], edges: [] }, transcripts: {}, activity: [], mail: [], pending: [], history: [] };
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
      return { ...state, master: { ...state.master, status: msg.status } };
    default:
      return state;
  }
}

// ── The live store (browser) ─────────────────────────────────────────────────
const enc = encodeURIComponent;

export interface Store {
  getState(): GatewayState;
  subscribe(cb: () => void): () => void;
  wsConnected(): boolean;
  startMesh(name: string): Promise<any>;
  stopMesh(name: string): Promise<any>;
  reload(): Promise<any>;
  defineMesh(config: MeshConfig): Promise<any>;
  promptRouter(name: string, text: string): Promise<any>;
  promptAgent(name: string, agentId: string, text: string): Promise<any>;
  promptMaster(text: string): Promise<any>;
  resolvePermission(name: string, requestId: string, optionId: string): Promise<any>;
  setMode(name: string, agentId: string, modeId: string): Promise<any>;
}

export function createStore(): Store {
  let state = emptyState();
  let connected = false;
  const subs = new Set<() => void>();
  const emit = () => {
    for (const s of subs) s();
  };
  const set = (next: GatewayState) => {
    state = next;
    emit();
  };

  let delay = 500;
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      connected = true;
      delay = 500;
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
      connected = false;
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

  async function post(path: string, body?: unknown): Promise<any> {
    const res = await fetch(path, {
      method: "POST",
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
    return json;
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
    startMesh: (n) => post(`/api/meshes/${enc(n)}/start`),
    stopMesh: (n) => post(`/api/meshes/${enc(n)}/stop`),
    reload: () => post(`/api/meshes/reload`),
    defineMesh: (c) => post(`/api/meshes`, c),
    promptRouter: (n, t) => post(`/api/meshes/${enc(n)}/prompt`, { text: t }),
    promptAgent: (n, a, t) => post(`/api/meshes/${enc(n)}/agents/${enc(a)}/prompt`, { text: t }),
    promptMaster: (t) => post(`/api/master/prompt`, { text: t }),
    resolvePermission: (n, r, o) => post(`/api/meshes/${enc(n)}/permissions/${enc(r)}/resolve`, { optionId: o }),
    setMode: (n, a, m) => post(`/api/meshes/${enc(n)}/agents/${enc(a)}/mode`, { modeId: m }),
  };
}

export function useStore(store: Store): GatewayState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
export function useConnected(store: Store): boolean {
  return useSyncExternalStore(store.subscribe, store.wsConnected, store.wsConnected);
}
