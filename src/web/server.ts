// Web tier: serves the React SPA (Bun bundles the imported index.html) and exposes
// /api + /ws to the browser. It works in two modes:
//   - gateway mode  ({ gateway })    — combined single process: handle /api + /ws in
//                                       process from the WebGateway. (default `mesh`)
//   - proxy mode    ({ backendUrl }) — reverse-proxy /api + /ws to a separate backend
//                                       process (`mesh web` → `mesh backend`).
// Same browser origin either way; the SPA is identical and never knows the difference.
import index from "./client/index.html";
import { handleApi } from "./api";
import type { WebGateway } from "./gateway";

export interface WebServerOptions {
  port?: number;
  dev?: boolean;
  gateway?: WebGateway;
  backendUrl?: string;
}
export interface WebServerHandle {
  port: number;
  url: string;
  mode: "gateway" | "proxy";
  backendUrl?: string;
  stop: () => void;
}

interface WsData {
  unsub?: () => void; // gateway mode
  back?: WebSocket; // proxy mode (upstream backend socket)
}

export function startWebServer(opts: WebServerOptions = {}): WebServerHandle {
  const gw = opts.gateway;
  const backendUrl = opts.backendUrl ? opts.backendUrl.replace(/\/+$/, "") : undefined;
  if (!gw && !backendUrl) throw new Error("startWebServer needs either a gateway or a backendUrl");
  const wsBackend = backendUrl ? backendUrl.replace(/^http/, "ws") + "/ws" : undefined;
  const dev = opts.dev ?? process.env.NODE_ENV !== "production";

  const server = Bun.serve<WsData>({
    port: opts.port ?? 7317,
    development: dev ? { hmr: true, console: false } : false,
    routes: { "/": index },
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (srv.upgrade(req, { data: {} })) return undefined;
        return new Response("ws upgrade failed", { status: 400 });
      }

      if (url.pathname.startsWith("/api/")) {
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        if (gw) {
          const body = hasBody ? await req.json().catch(() => ({})) : undefined;
          const r = await handleApi(gw, req.method, url.pathname, body);
          return Response.json(r.body, { status: r.status });
        }
        // proxy mode: forward to the backend verbatim
        const body = hasBody ? await req.text() : undefined;
        const resp = await fetch(backendUrl + url.pathname + url.search, {
          method: req.method,
          headers: { "content-type": req.headers.get("content-type") ?? "application/json" },
          body,
        }).catch(() => null);
        if (!resp) return Response.json({ error: { message: "backend unreachable" } }, { status: 502 });
        return new Response(resp.body, {
          status: resp.status,
          headers: { "content-type": resp.headers.get("content-type") ?? "application/json" },
        });
      }

      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (gw) {
          ws.data.unsub = gw.subscribe((m) => {
            try {
              ws.send(JSON.stringify(m));
            } catch {
              /* socket closing */
            }
          });
          return;
        }
        // proxy mode: bridge the browser socket to a backend socket
        const back = new WebSocket(wsBackend!);
        ws.data.back = back;
        back.onmessage = (e) => {
          try {
            ws.send(e.data as string);
          } catch {
            /* closing */
          }
        };
        back.onclose = () => {
          try {
            ws.close();
          } catch {
            /* already closed */
          }
        };
        back.onerror = () => {
          try {
            ws.close();
          } catch {
            /* already closed */
          }
        };
      },
      message(ws, msg) {
        try {
          ws.data.back?.send(msg as string);
        } catch {
          /* not open / not proxy mode */
        }
      },
      close(ws) {
        ws.data.unsub?.();
        try {
          ws.data.back?.close();
        } catch {
          /* already closed */
        }
      },
    },
  });

  const port = server.port ?? opts.port ?? 7317;
  return {
    port,
    url: `http://localhost:${port}`,
    mode: gw ? "gateway" : "proxy",
    backendUrl,
    stop: () => server.stop(true),
  };
}
