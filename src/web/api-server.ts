// Headless backend: serves ONLY the REST API (/api/*) and the WebSocket fan-out
// (/ws) from an in-process WebGateway. No frontend — the web tier (web-server.ts /
// `mesh web`) serves the SPA and reverse-proxies here. This is the stateful engine:
// it owns the WebGateway, which owns MeshManager + the mesh-host subprocesses.
import { handleApi } from "./api";
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
  const server = Bun.serve<WsData>({
    port: opts.port ?? 7300,
    hostname: opts.hostname,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (srv.upgrade(req, { data: {} })) return undefined;
        return new Response("ws upgrade failed", { status: 400 });
      }
      if (url.pathname.startsWith("/api/")) {
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        const body = hasBody ? await req.json().catch(() => ({})) : undefined;
        const r = await handleApi(gw, req.method, url.pathname, body);
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
  return { port, url: `http://localhost:${port}`, stop: () => server.stop(true) };
}
