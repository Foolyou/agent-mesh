// Web tier: serves the React SPA (Bun bundles the imported index.html) and exposes
// /api + /ws to the browser. It works in two modes:
//   - gateway mode  ({ gateway })    — combined single process: handle /api + /ws in
//                                       process from the WebGateway. (default `mesh`)
//   - proxy mode    ({ backendUrl }) — reverse-proxy /api + /ws to a separate backend
//                                       process. The public CLI now exposes only combined `mesh run`;
//                                       proxy mode remains for direct tests/embedding.
// Same browser origin either way; the SPA is identical and never knows the difference.
import index from "./client/index.html";
import { handleApi } from "./api";
import { authorizeRequest, bearerToken, gateLogLine, isPreAuthApiPath, type AuthGateResult } from "./auth";
import { resolveRoot } from "../root";
import type { WebGateway } from "./gateway";

const SPA_CACHE_CONTROL = "no-store, max-age=0, must-revalidate";

export interface WebServerOptions {
  port?: number;
  /** Interface to bind. Defaults to loopback (127.0.0.1) so the console is never exposed on
   *  all interfaces / the LAN / a tailnet IP. Pass "0.0.0.0" explicitly to opt into exposure. */
  hostname?: string;
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
  token?: string; // device token observed at upgrade (forwarded to the backend in proxy mode)
}

export function startWebServer(opts: WebServerOptions = {}): WebServerHandle {
  const gw = opts.gateway;
  const backendUrl = opts.backendUrl ? opts.backendUrl.replace(/\/+$/, "") : undefined;
  if (!gw && !backendUrl) throw new Error("startWebServer needs either a gateway or a backendUrl");
  const wsBackend = backendUrl ? backendUrl.replace(/^http/, "ws") + "/ws" : undefined;
  const dev = opts.dev ?? process.env.NODE_ENV !== "production";
  const hostname = opts.hostname ?? "127.0.0.1";
  // Auth root: the gateway carries it in-process; in proxy mode the web tier (where the real browser
  // socket terminates and the authoritative gate runs) resolves the SAME root directly (design §6 /
  // proposal A). A divergent root simply makes non-loopback fail closed.
  const authRoot = gw ? gw.authRoot() : resolveRoot();
  // Proxy mode has no in-process gateway; device-auth routes don't touch it, so a bare stub lets
  // handleApi serve them locally (it never reaches a gateway-using route for these paths).
  const proxyDeviceGw = {} as unknown as WebGateway;
  // Observability: log every deny + the first allow per (remote, via, route) without per-request
  // spam. Includes remote/bind for funnel diagnosis; never logs a token.
  const loggedGate = new Set<string>();
  async function gate(req: Request, srv: Bun.Server<WsData>, url: URL, route: "api" | "ws"): Promise<{ result: AuthGateResult; token: string | undefined }> {
    const remoteAddress = srv.requestIP(req)?.address; // socket-derived; never a header
    // Token transport is per prdmgr's locked channels: `/api/*` ONLY via Authorization: Bearer
    // (URLs leak through history / logs / referrers); `/ws` via `?token=` (the browser WS client
    // can't set headers), with Bearer also accepted if technically present.
    const token = route === "ws"
      ? url.searchParams.get("token") ?? bearerToken(req.headers) ?? undefined
      : bearerToken(req.headers) ?? undefined;
    const result = await authorizeRequest({ root: authRoot, token, remoteAddress, route, method: req.method, path: url.pathname });
    const key = `${remoteAddress}|${result.via}|${route}`;
    if (!result.ok || !loggedGate.has(key)) {
      if (loggedGate.size < 1000) loggedGate.add(key);
      console.log(gateLogLine(route, result, remoteAddress, hostname));
    }
    return { result, token };
  }
  const assetServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    development: dev ? { hmr: true, console: false } : false,
    routes: { "/": index, "/mesh/*": index },
    fetch() {
      return new Response("not found", { status: 404 });
    },
  });
  const assetOrigin = `http://127.0.0.1:${assetServer.port}`;

  const server = Bun.serve<WsData>({
    port: opts.port ?? 7317,
    hostname,
    development: dev ? { hmr: true, console: false } : false,
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        const { result, token } = await gate(req, srv, url, "ws");
        if (!result.ok) return new Response("unauthorized", { status: 401 });
        if (srv.upgrade(req, { data: { token } })) return undefined;
        return new Response("ws upgrade failed", { status: 400 });
      }

      if (url.pathname.startsWith("/api/")) {
        // Device-auth endpoints are pre-auth (they authenticate the device); everything else is gated
        // here at the tier that terminates the real browser socket (true in gateway AND proxy mode).
        if (!isPreAuthApiPath(url.pathname)) {
          const { result } = await gate(req, srv, url, "api");
          if (!result.ok) return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
        }
        const remoteAddress = srv.requestIP(req)?.address;
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        // Device-auth endpoints are handled at THIS tier in both modes, because this is where the
        // real browser socket terminates — so the pending device's coarse `remoteHint` reflects the
        // true browser origin, not the web→backend loopback hop. They don't use the gateway, so a
        // bare stub is enough in proxy mode (no spoofed header reaches the decision).
        if (gw || isPreAuthApiPath(url.pathname)) {
          const body = hasBody ? await requestBody(req) : undefined;
          const expectedOrigin = `http://${req.headers.get("host") ?? url.host}`;
          // In gateway mode THIS server serves /api, so the doctor backend check probes its real
          // listening port (srv.port), not a hardcoded default. Proxy-mode device routes don't use it.
          const r = await handleApi(gw ?? proxyDeviceGw, req.method, url.pathname, body, url.searchParams, undefined, undefined, undefined, { headers: req.headers, expectedOrigin, root: authRoot, remoteAddress, servicePort: srv.port });
          if (r.body instanceof Response) return r.body;
          return Response.json(r.body, { status: r.status });
        }
        // proxy mode, non-device route: forward to the backend verbatim (web-tier gate already passed)
        const body = hasBody ? await req.arrayBuffer() : undefined;
        const resp = await fetch(backendUrl + url.pathname + url.search, {
          method: req.method,
          headers: req.headers,
          body,
        }).catch(() => null);
        if (!resp) return Response.json({ error: { message: "backend unreachable" } }, { status: 502 });
        return new Response(resp.body, {
          status: resp.status,
          headers: resp.headers,
        });
      }

      const resp = await fetch(assetOrigin + url.pathname + url.search).catch(() => null);
      if (!resp) return new Response("not found", { status: 404 });
      const headers = new Headers(resp.headers);
      if (url.pathname === "/" || url.pathname.startsWith("/mesh/")) {
        headers.set("cache-control", SPA_CACHE_CONTROL);
      }
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
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
        // proxy mode: bridge the browser socket to a backend socket. Forward the device token so the
        // backend's defense-in-depth gate sees it (the web tier already enforced the authoritative gate).
        const back = new WebSocket(ws.data.token ? `${wsBackend!}?token=${encodeURIComponent(ws.data.token)}` : wsBackend!);
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
    url: `http://${hostname}:${port}`,
    mode: gw ? "gateway" : "proxy",
    backendUrl,
    stop: () => {
      server.stop(true);
      assetServer.stop(true);
    },
  };
}

async function requestBody(req: Request): Promise<any> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    const fd = await req.formData();
    return { files: fd.getAll("files").filter((f): f is File => f instanceof File) };
  }
  return req.json().catch(() => ({}));
}
