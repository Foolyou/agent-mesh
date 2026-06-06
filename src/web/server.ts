// Bun HTTP + WebSocket server. Uses Bun's native bundler to serve the React SPA
// (the imported index.html bundles index.tsx), routes /api/* to the pure handleApi,
// and fans out gateway deltas over a single /ws WebSocket. Thin glue over WebGateway.
import index from "./client/index.html";
import { handleApi } from "./api";
import type { WebGateway } from "./gateway";

export interface WebServerOptions {
  port?: number;
  dev?: boolean;
}
export interface WebServerHandle {
  port: number;
  url: string;
  stop: () => void;
}

interface WsData {
  unsub?: () => void;
}

export function startWebServer(gw: WebGateway, opts: WebServerOptions = {}): WebServerHandle {
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
        const body = hasBody ? await req.json().catch(() => ({})) : undefined;
        const r = await handleApi(gw, req.method, url.pathname, body);
        return Response.json(r.body, { status: r.status });
      }
      return new Response("not found", { status: 404 });
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
  const port = server.port ?? opts.port ?? 7317;
  const url = `http://localhost:${port}`;
  return { port, url, stop: () => server.stop(true) };
}
