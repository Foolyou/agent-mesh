// REST command router for the WebUI. Pure: it takes the gateway + an HTTP-ish
// (method, path, body) and returns { status, body }. server.ts adapts Bun requests
// to this; tests drive it directly without a socket.
import { validateMeshConfig } from "../mesh-validate";
import type { WebGateway } from "./gateway";
import type { AgentConfig, MeshConfig, MeshEdge, PromptImageRef } from "../acp/types";
import type { UploadFileLike } from "./uploads";
import { AgentFileError } from "./agent-files";

export interface ApiResult {
  status: number;
  body: any;
}

const ok = (body: any = { ok: true }): ApiResult => ({ status: 200, body });
const fail = (status: number, message: string): ApiResult => ({ status, body: { error: { message } } });

export async function handleApi(
  gw: WebGateway,
  method: string,
  path: string,
  body: any,
  query: URLSearchParams = new URLSearchParams(),
): Promise<ApiResult> {
  const seg = path
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
  // seg[0] === "api"
  if (seg[0] !== "api") return fail(404, `no route: ${method} ${path}`);
  const p = seg.slice(1);
  const str = (v: unknown) => (v == null ? "" : String(v));

  try {
    if (method === "GET" && p.length === 1 && p[0] === "state") return ok(gw.snapshot());

    if (p[0] === "uploads") {
      if (method === "POST" && p.length === 1) {
        const bucket = str(query.get("bucket"));
        const files = Array.isArray(body?.files) ? (body.files as UploadFileLike[]) : [];
        return ok(await gw.upload(bucket, files));
      }
      if (method === "GET" && p.length === 3) {
        return { status: 200, body: await gw.serveUpload(str(p[1]), str(p[2])) };
      }
    }

    if (p[0] === "agents" && method === "GET" && p.length >= 4 && p[2] === "files") {
      const agentName = str(p[1]);
      const relPath = p.slice(3).join("/");
      try {
        return { status: 200, body: await gw.serveAgentFile(agentName, relPath) };
      } catch (err: any) {
        if (err instanceof AgentFileError || typeof err?.code === "string") {
          return fail(agentFileStatus(err.code), "agent file not found");
        }
        throw err;
      }
    }

    if (p[0] === "master" && method === "POST" && p[1] === "prompt") {
      try {
        await gw.promptMaster(str(body?.text), imagesOf(body));
        return ok();
      } catch (e: any) {
        const msg = str(e?.message ?? e);
        return fail(/not configured/.test(msg) ? 409 : 400, msg);
      }
    }
    if (p[0] === "master" && method === "POST" && p[1] === "interrupt") {
      gw.interruptMaster();
      return ok();
    }

    if (p[0] === "meshes") {
      // GET /api/meshes
      if (method === "GET" && p.length === 1) return ok(gw.snapshot().meshes);
      // POST /api/meshes  (define)
      if (method === "POST" && p.length === 1) {
        validateMeshConfig(body as MeshConfig);
        await gw.defineMesh(body as MeshConfig);
        return ok();
      }
      // POST /api/meshes/reload
      if (method === "POST" && p.length === 2 && p[1] === "reload") {
        await gw.reload();
        return ok();
      }
      const name = p[1] ?? "";
      // DELETE /api/meshes/:name
      if (method === "DELETE" && p.length === 2) {
        await gw.deleteMesh(name);
        return ok();
      }
      // GET /api/meshes/:name/config
      if (method === "GET" && p.length === 3 && p[2] === "config") return ok(gw.configOf(name));
      // POST /api/meshes/:name/edges
      if (method === "POST" && p.length === 3 && p[2] === "edges") {
        await gw.addEdge(name, { from: str(body?.from), to: str(body?.to), steer: body?.steer === true } as MeshEdge);
        return ok();
      }
      // POST /api/meshes/:name/agents
      if (method === "POST" && p.length === 3 && p[2] === "agents") {
        const agent = body?.agent ?? body;
        const edges = Array.isArray(body?.edges)
          ? body.edges.map((edge: any) => ({ from: str(edge?.from), to: str(edge?.to), steer: edge?.steer === true } as MeshEdge))
          : [];
        await gw.addAgent(name, {
          id: str(agent?.id),
          harness: str(agent?.harness) as AgentConfig["harness"],
          project: str(agent?.project),
          role: (agent?.role === "router" ? "router" : "member") as AgentConfig["role"],
          lazy: agent?.lazy === undefined ? undefined : agent?.lazy === true,
          effort: agent?.effort || undefined,
          mode: agent?.mode || undefined,
          model: agent?.model || undefined,
          instructions: agent?.instructions || undefined,
        }, edges);
        return ok();
      }
      // POST /api/meshes/:name/(start|stop|prompt)
      if (method === "POST" && p.length === 3) {
        if (p[2] === "start") {
          await gw.startMesh(name);
          return ok();
        }
        if (p[2] === "stop") {
          await gw.stopMesh(name);
          return ok();
        }
        if (p[2] === "prompt") {
          await gw.promptRouter(name, str(body?.text), imagesOf(body));
          return ok();
        }
        if (p[2] === "session") {
          await gw.newAllSessions(name);
          return ok();
        }
      }
      // POST /api/meshes/:name/permissions/:rid/resolve
      if (method === "POST" && p.length === 5 && p[2] === "permissions" && p[4] === "resolve") {
        gw.resolvePermission(name, str(p[3]), str(body?.optionId));
        return ok();
      }
      // POST /api/meshes/:name/agents/:id/(prompt|mode|model)
      if (method === "POST" && p.length === 5 && p[2] === "agents") {
        const agentId = str(p[3]);
        if (p[4] === "prompt") {
          gw.promptAgent(name, agentId, str(body?.text), imagesOf(body));
          return ok();
        }
        if (p[4] === "steer") {
          gw.steerAgent(name, agentId, str(body?.text), imagesOf(body));
          return ok();
        }
        if (p[4] === "mode") {
          await gw.setMode(name, agentId, str(body?.modeId));
          return ok();
        }
        if (p[4] === "model") {
          await gw.setModel(name, agentId, str(body?.modelId));
          return ok();
        }
        if (p[4] === "effort") {
          await gw.setEffort(name, agentId, (body?.effort || undefined) as any);
          return ok();
        }
        if (p[4] === "interrupt") {
          gw.interruptAgent(name, agentId);
          return ok();
        }
        if (p[4] === "wake") {
          gw.wakeAgent(name, agentId);
          return ok();
        }
        if (p[4] === "session") {
          await gw.newAgentSession(name, agentId);
          return ok();
        }
      }
    }

    return fail(404, `no route: ${method} ${path}`);
  } catch (e: any) {
    return fail(400, str(e?.message ?? e));
  }
}

function agentFileStatus(code: string): number {
  if (code === "traversal" || code === "symlink") return 400;
  if (code === "toobig") return 413;
  return 404;
}

function imagesOf(body: any): PromptImageRef[] {
  return Array.isArray(body?.images)
    ? body.images
        .filter((i: any) => i && typeof i.id === "string" && typeof i.mimeType === "string" && typeof i.name === "string")
        .slice(0, 5)
        // Keep ONLY client-meaningful fields; never carry a client-supplied path/url/bucket into
        // the system — the server reconstructs those from the validated id (see gateway.withBucket).
        .map((i: any) => ({ id: i.id, mimeType: i.mimeType, name: i.name }) as PromptImageRef)
    : [];
}
