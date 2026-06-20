// Headless backend: serves ONLY the REST API (/api/*) and the WebSocket fan-out
// (/ws) from an in-process WebGateway. No frontend — the web tier (web-server.ts /
// `mesh web`) serves the SPA and reverse-proxies here. This is the stateful engine:
// it owns the WebGateway, which owns MeshManager + the mesh-host subprocesses.
import { handleApi } from "./api";
import { authorizeRequest, bearerToken, gateLogLine, isPreAuthApiPath } from "./auth";
import type { WebGateway } from "./gateway";

export interface ApiServerOptions {
  port?: number;
  hostname?: string;
}
export interface ServerHandle {
  port: number;
  url: string;
  stop: () => void;
}

interface WsData {
  unsub?: () => void;
}

export function startApiServer(gw: WebGateway, opts: ApiServerOptions = {}): ServerHandle {
  // Default to loopback so the REST API + WS fan-out are never exposed on all interfaces.
  const hostname = opts.hostname ?? "127.0.0.1";
  const authRoot = gw.authRoot();
  // Log every deny + the first allow per (remote, via, route); includes remote/bind for diagnosis,
  // never a token. An approved device token is the only allow path (no loopback bypass).
  const loggedGate = new Set<string>();
  async function gate(req: Request, srv: Bun.Server<WsData>, url: URL, route: "api" | "ws"): Promise<boolean> {
    const remoteAddress = srv.requestIP(req)?.address; // socket-derived; never a header
    // `/api/*` ONLY via Authorization: Bearer (URLs leak); `/ws` via `?token=` (+ Bearer if present).
    const token = route === "ws"
      ? url.searchParams.get("token") ?? bearerToken(req.headers) ?? undefined
      : bearerToken(req.headers) ?? undefined;
    const result = await authorizeRequest({ root: authRoot, token, remoteAddress });
    const key = `${remoteAddress}|${result.via}|${route}`;
    if (!result.ok || !loggedGate.has(key)) {
      if (loggedGate.size < 1000) loggedGate.add(key);
      console.log(gateLogLine(route, result, remoteAddress, hostname));
    }
    return result.ok;
  }
  const server = Bun.serve<WsData>({
    port: opts.port ?? 7300,
    hostname,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (!(await gate(req, srv, url, "ws"))) return new Response("unauthorized", { status: 401 });
        if (srv.upgrade(req, { data: {} })) return undefined;
        return new Response("ws upgrade failed", { status: 400 });
      }
      if (url.pathname.startsWith("/api/")) {
        // Device-auth endpoints are pre-auth; everything else is gated by socket address + bind.
        if (!isPreAuthApiPath(url.pathname) && !(await gate(req, srv, url, "api"))) {
          return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
        }
        const remoteAddress = srv.requestIP(req)?.address;
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        const body = hasBody ? await requestBody(req) : undefined;
        const expectedOrigin = `http://${req.headers.get("host") ?? url.host}`;
        const r = await handleApi(gw, req.method, url.pathname, body, url.searchParams, undefined, undefined, undefined, { headers: req.headers, expectedOrigin, root: authRoot, remoteAddress });
        if (r.body instanceof Response) return r.body;
        return Response.json(r.body, { status: r.status });
      }
      return new Response("mesh backend — REST at /api/*, WebSocket at /ws", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.data.unsub = gw.subscribe((m) => {
          try {
            ws.send(JSON.stringify(m));
          } catch {
            /* socket closing */
          }
        });
      },
      message() {
        /* commands go over REST; ignore inbound frames */
      },
      close(ws) {
        ws.data.unsub?.();
      },
    },
  });
  const port = server.port ?? opts.port ?? 7300;
  return { port, url: `http://${hostname}:${port}`, stop: () => server.stop(true) };
}

async function requestBody(req: Request): Promise<any> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    const fd = await req.formData();
    return { files: fd.getAll("files").filter((f): f is File => f instanceof File) };
  }
  return req.json().catch(() => ({}));
}
