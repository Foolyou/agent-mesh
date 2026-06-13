// REST command router for the WebUI. Pure: it takes the gateway + an HTTP-ish
// (method, path, body) and returns { status, body }. server.ts adapts Bun requests
// to this; tests drive it directly without a socket.
import { validateMeshConfig } from "../mesh-validate";
import type { WebGateway } from "./gateway";
import type { AgentConfig, MeshConfig, MeshEdge, PromptImageRef } from "../acp/types";
import type { StartMeshOptions } from "../mesh-manager";
import type { UploadFileLike } from "./uploads";
import { AgentFileError } from "./agent-files";
import { probeHarnesses } from "../harness-probe";
import { clearHarnessProbeCache } from "../harness-probe";
import { clearHarnessModelsCache, probeHarnessModels } from "../harness-models";
import { HARNESSES } from "../harness";
import { getHarnessInstallJob, HarnessInstallError, startHarnessInstall, type InstallEvent } from "../harness-install";
import type { RespawnMode } from "../control-plane";

export interface ApiResult {
  status: number;
  body: any;
}

type HarnessModelProbe = typeof probeHarnessModels;
type HarnessInstaller = typeof startHarnessInstall;
export interface ApiRequestContext {
  headers?: Headers;
  expectedOrigin?: string;
  clearProbeCache?: (id?: AgentConfig["harness"]) => void;
  clearModelsCache?: (id?: AgentConfig["harness"]) => void;
}

const ok = (body: any = { ok: true }): ApiResult => ({ status: 200, body });
const fail = (status: number, message: string): ApiResult => ({ status, body: { error: { message } } });

export async function handleApi(
  gw: WebGateway,
  method: string,
  path: string,
  body: any,
  query: URLSearchParams = new URLSearchParams(),
  harnessProbe = probeHarnesses,
  harnessModelProbe: HarnessModelProbe = probeHarnessModels,
  harnessInstaller: HarnessInstaller = startHarnessInstall,
  ctx: ApiRequestContext = {},
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
    if (isHarnessMutationRoute(method, p)) {
      const csrf = sameOriginCheck(ctx.headers, ctx.expectedOrigin);
      if (!csrf.ok) return { status: 403, body: { error: { message: "forbidden" } } };
    }
    if (method === "GET" && p.length === 1 && p[0] === "state") return ok(gw.snapshot());
    if (method === "GET" && p.length === 1 && p[0] === "harnesses") return ok(await harnessProbe({
      runningAgentsUsingOldVersion: (id, latest) => gw.runningAgentsUsingOldVersion(id, latest),
    }));
    if (method === "POST" && p.length === 3 && p[0] === "harnesses" && p[2] === "install") {
      const harness = str(p[1]) as AgentConfig["harness"];
      if (!Object.hasOwn(HARNESSES, harness)) return fail(400, `unknown harness: ${harness}`);
      if (harness !== "claude" && harness !== "codex") return fail(400, `harness ${harness} is not npm-installable`);
      try {
        const job = await harnessInstaller(harness, { broadcast: (event) => {
          if (event.t === "harnesses-changed") gw.broadcastHarnessesChanged(event.harnessId);
        } });
        return ok({ jobId: job.id, status: job.status === "done" ? "done" : "running", harnessId: job.harnessId, pkgSpec: job.pkgSpec });
      } catch (e: any) {
        if (e instanceof HarnessInstallError && e.code === "missing-npm") {
          return { status: 409, body: { error: "missing-npm", hint: e.message } };
        }
        return fail(e instanceof HarnessInstallError && e.code === "not-installable" ? 400 : 500, str(e?.message ?? e));
      }
    }
    if (method === "GET" && p.length === 5 && p[0] === "harnesses" && p[2] === "install" && p[4] === "stream") {
      const harness = str(p[1]) as AgentConfig["harness"];
      if (!Object.hasOwn(HARNESSES, harness)) return fail(400, `unknown harness: ${harness}`);
      const job = getHarnessInstallJob(str(p[3]));
      if (!job || job.harnessId !== harness) return fail(404, "install job not found");
      return { status: 200, body: installStreamResponse(job) };
    }
    if (method === "GET" && p.length === 3 && p[0] === "harnesses" && p[2] === "models") {
      const harness = str(p[1]) as AgentConfig["harness"];
      if (!Object.hasOwn(HARNESSES, harness)) return fail(404, `unknown harness: ${harness}`);
      try {
        return ok(await harnessModelProbe(harness, { refresh: query.get("refresh") === "1" }));
      } catch (e: any) {
        const msg = str(e?.message ?? e);
        return fail(/not installed/.test(msg) ? 409 : 400, msg);
      }
    }
    if (method === "POST" && p.length === 3 && p[0] === "harnesses" && p[2] === "reprobe") {
      const harness = str(p[1]) as AgentConfig["harness"];
      if (!Object.hasOwn(HARNESSES, harness)) return fail(400, `unknown harness: ${harness}`);
      (ctx.clearProbeCache ?? clearHarnessProbeCache)(harness);
      (ctx.clearModelsCache ?? clearHarnessModelsCache)(harness);
      const rows = await harnessProbe({ refresh: true });
      gw.broadcastHarnessesChanged(harness);
      const row = rows.find((h: any) => h.id === harness);
      return ok({ id: harness, installed: row?.installed === true, version: row?.version });
    }

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

    const assistantRoute = p[0] === "assistant" || p[0] === "master";
    if (assistantRoute && method === "POST" && p[1] === "prompt") {
      try {
        await gw.promptAssistant(str(body?.text), imagesOf(body));
        return ok();
      } catch (e: any) {
        const msg = str(e?.message ?? e);
        return fail(/not configured/.test(msg) ? 409 : 400, msg);
      }
    }
    if (assistantRoute && method === "POST" && p[1] === "interrupt") {
      gw.interruptAssistant();
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
          opencodePermission: agent?.opencodePermission === "allow" ? "allow" : agent?.opencodePermission === "ask" ? "ask" : undefined,
          mode: agent?.mode || undefined,
          model: agent?.model || undefined,
          instructions: agent?.instructions || undefined,
        }, edges);
        return ok();
      }
      // POST /api/meshes/:name/(start|stop|prompt)
      if (method === "POST" && p.length === 3) {
        if (p[2] === "start") {
          const opts: StartMeshOptions | undefined = body?.sessionStrategy === "fresh" ? { sessionStrategy: "fresh" } : undefined;
          await gw.startMesh(name, opts);
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
        if (p[4] === "stop") {
          gw.stopAgent(name, agentId);
          return ok();
        }
        if (p[4] === "session") {
          await gw.newAgentSession(name, agentId);
          return ok();
        }
        if (p[4] === "respawn") {
          const mode = str(body?.mode) as RespawnMode;
          if (mode !== "after-idle" && mode !== "force" && mode !== "cancel") return fail(400, "invalid respawn mode");
          try {
            return ok(await gw.respawnAgent(name, agentId, mode));
          } catch (e: any) {
            const msg = str(e?.message ?? e);
            return fail(/spawning|cold/.test(msg) ? 409 : 400, msg);
          }
        }
      }
      // DELETE /api/meshes/:name/agents/:id/queue/:turnId
      if (method === "DELETE" && p.length === 6 && p[2] === "agents" && p[4] === "queue") {
        gw.removeQueuedTurn(name, str(p[3]), str(p[5]));
        return ok();
      }
      // GET /api/meshes/:name/agents/:id/artifacts/:relPath
      if (method === "GET" && p.length >= 6 && p[2] === "agents" && p[4] === "artifacts") {
        try {
          return { status: 200, body: await gw.serveAgentArtifact(name, str(p[3]), p.slice(5).join("/")) };
        } catch (err: any) {
          if (err instanceof AgentFileError || typeof err?.code === "string") {
            return fail(agentFileStatus(err.code), "agent artifact not found");
          }
          throw err;
        }
      }
    }

    return fail(404, `no route: ${method} ${path}`);
  } catch (e: any) {
    return fail(400, str(e?.message ?? e));
  }
}

function installStreamResponse(job: { status: string; events: InstallEvent[] }): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      while (index >= job.events.length && job.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      while (index < job.events.length) {
        controller.enqueue(encoder.encode(JSON.stringify(publicInstallEvent(job.events[index++])) + "\n"));
      }
      if (job.status !== "running" && index >= job.events.length) controller.close();
    },
  }), { headers: { "content-type": "application/x-ndjson" } });
}

function publicInstallEvent(event: InstallEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    step: event.step,
    harnessId: event.harnessId,
    pkgSpec: event.pkgSpec,
  };
  if (event.progress !== undefined) out.progress = event.progress;
  if (event.stdoutLine !== undefined) out.stdoutLine = event.stdoutLine;
  if (event.stderrLine !== undefined) out.stderrLine = event.stderrLine;
  if (event.step === "done") {
    if (event.installedVersion !== undefined) out.installedVersion = event.installedVersion;
    if (event.installedPath !== undefined) out.installedPath = event.installedPath;
  }
  if (event.step === "error") {
    if (event.code !== undefined) out.code = event.code;
    if (event.message !== undefined) out.message = event.message;
  }
  return out;
}

function isHarnessMutationRoute(method: string, p: string[]): boolean {
  if (p[0] === "harnesses") {
    if (method === "POST" && p.length === 3 && p[2] === "install") return true;
    if (method === "GET" && p.length === 5 && p[2] === "install" && p[4] === "stream") return true;
    if (method === "POST" && p.length === 3 && p[2] === "reprobe") return true;
  }
  if (p[0] === "meshes" && method === "POST" && p.length === 5 && p[2] === "agents" && p[4] === "respawn") return true;
  return false;
}

export function assertSameOrigin(headers: Headers | undefined, expectedOrigin: string | undefined): void {
  if (!sameOriginCheck(headers, expectedOrigin).ok) throw new Error("forbidden");
}

function sameOriginCheck(headers: Headers | undefined, expectedOrigin: string | undefined): { ok: boolean } {
  const site = headers?.get("sec-fetch-site")?.toLowerCase();
  if (site === "same-origin") return { ok: true };
  const origin = headers?.get("origin");
  if (origin && expectedOrigin && origin === expectedOrigin) return { ok: true };
  return { ok: false };
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
