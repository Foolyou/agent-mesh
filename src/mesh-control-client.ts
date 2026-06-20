// src/mesh-control-client.ts — authenticated client the `mesh` CLI uses to drive ONE mesh through the
// running control plane (design: docs/design/mesh-cli-lifecycle.md §B/§D). It signs a short-lived
// host-key bearer (Approach 2) and calls the local API; it classifies transport/HTTP failures into the
// approved CLI error reasons so the dispatcher can map them to exit codes. No mesh logic lives here —
// just transport + classification (the command orchestration is in mesh-cli-ops.ts).

import { signHostBearer } from "./cli-host-bearer";

/** Minimal view of a mesh the lifecycle ops need (parsed loosely from GET /api/meshes). */
export interface MeshLifecycleInfo {
  name: string;
  status: string; // "stopped" | "starting" | "running" | "dead"
  agents: { id: string; harness: string; status: string }[];
}

export type ControlError = "backend-down" | "auth" | "not-found" | "error";

export type ControlOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; reason: ControlError; message?: string };

/** The transport the lifecycle ops depend on (injectable, so the ops are unit-testable with a fake). */
export interface MeshControlClient {
  /** GET /api/meshes → the lifecycle view of every defined mesh. */
  getMeshes(): Promise<ControlOutcome<MeshLifecycleInfo[]>>;
  /** POST /api/meshes/:name/(start|stop) with an optional JSON body. */
  meshAction(name: string, action: "start" | "stop", body?: unknown): Promise<ControlOutcome<void>>;
}

const REQUEST_TIMEOUT_MS = 8000;

/** A live client against the local control plane at `127.0.0.1:<port>`, signing a fresh host bearer per
 *  request (TTL 60s — far longer than a single call). `root` provides the key store the bearer is signed
 *  with; the backend verifies it against the same `<root>/auth/keys.json`. */
export function httpMeshControlClient(root: string, port: number): MeshControlClient {
  const base = `http://127.0.0.1:${port}`;

  async function call(method: string, path: string, body?: unknown): Promise<ControlOutcome<any>> {
    let bearer: string;
    try {
      bearer = await signHostBearer(root);
    } catch {
      return { ok: false, reason: "error", message: "could not sign host credential" };
    }
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // ECONNREFUSED / DNS / timeout → the control plane isn't reachable.
      return { ok: false, reason: "backend-down" };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "auth" };
    if (res.status === 404) return { ok: false, reason: "not-found" };
    if (res.status >= 400) {
      const message = await errorMessage(res);
      return { ok: false, reason: "error", message };
    }
    const data = await res.json().catch(() => undefined);
    return { ok: true, data };
  }

  return {
    async getMeshes() {
      const r = await call("GET", "/api/meshes");
      if (!r.ok) return r;
      return { ok: true, data: Array.isArray(r.data) ? r.data.map(toLifecycleInfo) : [] };
    },
    async meshAction(name, action, body) {
      const r = await call("POST", `/api/meshes/${encodeURIComponent(name)}/${action}`, body);
      return r.ok ? { ok: true, data: undefined } : r;
    },
  };
}

function toLifecycleInfo(m: any): MeshLifecycleInfo {
  return {
    name: String(m?.name ?? ""),
    status: String(m?.status ?? "unknown"),
    agents: Array.isArray(m?.agents)
      ? m.agents.map((a: any) => ({ id: String(a?.id ?? ""), harness: String(a?.harness ?? ""), status: String(a?.status ?? "") }))
      : [],
  };
}

async function errorMessage(res: Response): Promise<string | undefined> {
  try {
    const body = await res.json();
    const msg = (body as any)?.error?.message ?? (body as any)?.error;
    return typeof msg === "string" ? msg : undefined;
  } catch {
    return undefined;
  }
}
