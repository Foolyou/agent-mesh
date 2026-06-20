// Unit tests for the authenticated control-plane client (mesh-cli-lifecycle §B). `fetch` is stubbed so
// we assert the request shape (URL/method/host-bearer header/body) and the HTTP→ControlError
// classification, against a real temp keystore so the bearer actually signs.
import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureKeys } from "./auth-codes";
import { isHostBearer } from "./cli-host-bearer";
import { httpMeshControlClient } from "./mesh-control-client";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "mesh-ctlclient-"));
  try {
    await ensureKeys(root); // so signHostBearer has an active key
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function stubFetch(handler: (url: string, init: any) => Response | Promise<Response>) {
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return await handler(String(url), init);
  }) as unknown as typeof fetch;
  return calls;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("getMeshes: GET /api/meshes with a host-key bearer; parses name/status/agents", async () => {
  await withRoot(async (root) => {
    const calls = stubFetch(() => json(200, [{ name: "demo", status: "running", agents: [{ id: "router", harness: "codex", status: "idle", extra: 1 }] }]));
    const r = await httpMeshControlClient(root, 19999).getMeshes();
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.data).toEqual([{ name: "demo", status: "running", agents: [{ id: "router", harness: "codex", status: "idle" }] }]);
    expect(calls[0].url).toBe("http://127.0.0.1:19999/api/meshes");
    expect(calls[0].init.method).toBe("GET");
    const auth = calls[0].init.headers.authorization as string;
    expect(auth.startsWith("Bearer ")).toBe(true);
    expect(isHostBearer(auth.slice("Bearer ".length))).toBe(true); // a real mhk1 host bearer
  });
});

test("meshAction start --fresh: POST .../start with JSON body + content-type", async () => {
  await withRoot(async (root) => {
    const calls = stubFetch(() => json(200, { ok: true }));
    const r = await httpMeshControlClient(root, 19999).meshAction("demo", "start", { sessionStrategy: "fresh" });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe("http://127.0.0.1:19999/api/meshes/demo/start");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body)).toEqual({ sessionStrategy: "fresh" });
  });
});

test("meshAction stop: POST .../stop with no body", async () => {
  await withRoot(async (root) => {
    const calls = stubFetch(() => json(200, { ok: true }));
    await httpMeshControlClient(root, 19999).meshAction("demo", "stop");
    expect(calls[0].url).toBe("http://127.0.0.1:19999/api/meshes/demo/stop");
    expect(calls[0].init.body).toBeUndefined();
  });
});

test("transport failure (ECONNREFUSED) → backend-down", async () => {
  await withRoot(async (root) => {
    stubFetch(() => { throw new Error("ECONNREFUSED"); });
    expect(await httpMeshControlClient(root, 19999).getMeshes()).toEqual({ ok: false, reason: "backend-down" });
  });
});

test("401 and 403 → auth", async () => {
  await withRoot(async (root) => {
    for (const status of [401, 403]) {
      stubFetch(() => json(status, { error: { message: "unauthorized" } }));
      expect(await httpMeshControlClient(root, 19999).getMeshes()).toMatchObject({ ok: false, reason: "auth" });
    }
  });
});

test("404 → not-found", async () => {
  await withRoot(async (root) => {
    stubFetch(() => json(404, { error: { message: "no route" } }));
    expect(await httpMeshControlClient(root, 19999).meshAction("demo", "start")).toMatchObject({ ok: false, reason: "not-found" });
  });
});

test("other 4xx/5xx → error, surfacing the server message", async () => {
  await withRoot(async (root) => {
    stubFetch(() => json(400, { error: { message: "no such mesh" } }));
    const r = await httpMeshControlClient(root, 19999).meshAction("demo", "stop");
    expect(r).toMatchObject({ ok: false, reason: "error", message: "no such mesh" });
  });
});
