// REST command router for the WebUI. Pure: it takes the gateway + an HTTP-ish
// (method, path, body) and returns { status, body }. server.ts adapts Bun requests
// to this; tests drive it directly without a socket.
import { validateMeshConfig } from "../mesh-validate";
import { DEFAULT_BACKFILL_LIMIT, MAX_BACKFILL_LIMIT, type WebGateway } from "./gateway";
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
import {
  bearerToken,
  classifyRemoteAddress,
  coarseUserAgentClass,
  deviceBootstrap,
  deviceStart,
  deviceStatus,
  deviceVerify,
} from "./auth";
import { collectPsDetail, runDoctor } from "../diagnostics";
import { diagnosticsRunDir, doctorSources, webPsSources } from "../diagnostics-sources";
import { reapLeaks } from "../mesh-registry";

export interface ApiResult {
  status: number;
  body: any;
}

type HarnessModelProbe = typeof probeHarnessModels;
type HarnessInstaller = typeof startHarnessInstall;
export interface ApiRequestContext {
  headers?: Headers;
  expectedOrigin?: string;
  /** Resolved mesh root; the device-auth store lives under `<root>/auth/`. */
  root?: string;
  /** Control-plane port the `doctor` backend check probes. Defaults to 10010 (the prod service port). */
  servicePort?: number;
  /** SOCKET-derived remote address (Bun `server.requestIP`); only a coarse origin class is recorded. */
  remoteAddress?: string;
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
    // Device-auth endpoints (design §4.2). Pre-auth and CSRF-exempt: they carry an explicit bearer
    // token, not an ambient cookie, so the same-origin gate doesn't apply. They authenticate the
    // device itself, so they must run BEFORE any token/loopback gate added for the rest of /api/*.
    if (p[0] === "auth" && p[1] === "device" && p.length === 3) {
      if (!ctx.root) return fail(500, "auth store not configured");
      const headers = ctx.headers;
      if (method === "POST" && p[2] === "start") {
        // Coarse, non-PII origin class for `mesh device list` (loopback/remote). It is advisory only —
        // loopback is no longer a trust signal, so this never affects authorization.
        const started = await deviceStart(ctx.root, {
          existingToken: bearerToken(headers),
          userAgentClass: coarseUserAgentClass(headers),
          remoteHint: classifyRemoteAddress(ctx.remoteAddress),
        });
        // Producer (7.4-C): a new device is requesting approval — informational only; approval stays
        // host-CLI authoritative (no web approve seam). Dedup per deviceId so polling never re-nags.
        // Best-effort: a notification failure must NEVER break device enrollment.
        try {
          await gw.emitNotification?.({
            type: "device-auth", severity: "info", title: "新设备申请授权",
            body: `设备 ${started.deviceId} 待批准（宿主端：mesh device approve）`,
            source: { surface: "settings", tab: "devices" }, dedupKey: `device-auth:${started.deviceId}`,
          });
        } catch { /* notifications are best-effort */ }
        return ok(started);
      }
      if (method === "GET" && p[2] === "status") {
        return ok({ status: await deviceStatus(ctx.root, bearerToken(headers)) });
      }
      if (method === "POST" && p[2] === "verify") {
        const result = await deviceVerify(ctx.root, bearerToken(headers));
        return result.ok ? ok({ ok: true }) : fail(401, "unauthorized");
      }
      // First-device bootstrap: bearer = dormant device token, body = { bootstrapToken }. Every
      // failure mode is an undifferentiated 401 (no probing which part was wrong).
      if (method === "POST" && p[2] === "bootstrap") {
        const result = await deviceBootstrap(ctx.root, bearerToken(headers), str(body?.bootstrapToken));
        return result.ok ? ok({ ok: true }) : fail(401, "unauthorized");
      }
    }

    if (isHarnessMutationRoute(method, p)) {
      const csrf = sameOriginCheck(ctx.headers, ctx.expectedOrigin);
      if (!csrf.ok) return { status: 403, body: { error: { message: "forbidden" } } };
    }
    if (method === "GET" && p.length === 1 && p[0] === "state") return ok(gw.snapshot());
    if (method === "GET" && p.length === 1 && p[0] === "harnesses") {
      const rows = await harnessProbe({ runningAgentsUsingOldVersion: (id, latest) => gw.runningAgentsUsingOldVersion(id, latest) });
      // Producer (7.4-C): surface an outdated-harness upgrade notice. dedupKey encodes the latest
      // version, so re-detecting the same version is idempotent (never re-nags an already-read row).
      // Best-effort: a notification failure must never break the harness probe response.
      await Promise.all((rows as any[])
        .filter((r) => r.outdated && r.latest && r.version)
        .map((r) => gw.emitNotification?.({
          type: "harness-upgrade", severity: "warning", title: `${r.id} 有更新 v${r.version} → v${r.latest}`,
          body: "在 Harnesses 面板更新并重启旧版本 agent", source: { surface: "harnesses" },
          dedupKey: `harness-upgrade:${r.id}:${r.latest}`,
        }))).catch(() => {});
      return ok(rows);
    }
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

    // System diagnostics (mesh-ps-doctor). GATED: these sit BELOW the device-auth block, so the
    // server-level gate (authorizeRequest) has already required an approved device token — there is no
    // pre-auth entry here. Both routes consume the SHARED diagnostics model (no logic re-derived in the
    // web handler) and the structured results are already secret-free (the builders emit only
    // counts/booleans/redacted detail — never appSecret/token/key/hash/envelope/raw credential).
    if (p[0] === "diagnostics" && method === "GET" && p.length === 2) {
      if (!ctx.root) return fail(500, "diagnostics root not configured");
      if (p[1] === "ps") {
        // Live agent detail (activity/context) injected from the in-process gateway snapshot; degrades
        // to static config detail for any running mesh not yet in the live snapshot.
        const ps = await collectPsDetail(diagnosticsRunDir(ctx.root), webPsSources(ctx.root, safeSnapshot(gw)));
        return ok(ps);
      }
      if (p[1] === "doctor") {
        return ok(await runDoctor(doctorSources(ctx.root, ctx.servicePort ?? 10010)));
      }
    }
    // Targeted leak recovery (user-approved WebUI scope): reap stale records / orphan sockets.
    // GATED (below device-auth) + CSRF-checked. `reapLeaks` never touches a live daemon, so this
    // is safe while real meshes run. Returns the reaped names + a freshly re-collected PsDetail.
    if (p[0] === "diagnostics" && p[1] === "reap" && method === "POST" && p.length === 2) {
      if (!ctx.root) return fail(500, "diagnostics root not configured");
      const csrf = sameOriginCheck(ctx.headers, ctx.expectedOrigin);
      if (!csrf.ok) return { status: 403, body: { error: { message: "forbidden" } } };
      const names = Array.isArray(body?.names) ? (body.names as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
      const { reaped } = await reapLeaks(diagnosticsRunDir(ctx.root), names);
      const ps = await collectPsDetail(diagnosticsRunDir(ctx.root), webPsSources(ctx.root, safeSnapshot(gw)));
      return ok({ reaped, ps });
    }

    // Notification center (Step 7.4-C). GATED (sits below the device-auth block) + CSRF on POST.
    // Structured source only, no web approve/revoke seam; read state is global.
    if (p[0] === "notifications") {
      if (method === "GET" && p.length === 1) {
        const limit = Number(query.get("limit"));
        return ok(gw.listNotifications({
          unread: query.get("unread") === "1",
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
          cursor: query.get("cursor") ?? undefined,
        }));
      }
      const mut = () => sameOriginCheck(ctx.headers, ctx.expectedOrigin);
      if (method === "POST" && p.length === 2 && p[1] === "read-all") {
        if (!mut().ok) return { status: 403, body: { error: { message: "forbidden" } } };
        return ok(await gw.markAllNotificationsRead());
      }
      if (method === "POST" && p.length === 2 && p[1] === "cleanup") {
        if (!mut().ok) return { status: 403, body: { error: { message: "forbidden" } } };
        return ok(await gw.cleanupNotifications());
      }
      if (method === "POST" && p.length === 3 && p[2] === "read") {
        if (!mut().ok) return { status: 403, body: { error: { message: "forbidden" } } };
        return ok(await gw.markNotificationRead(str(p[1])));
      }
    }

    if (p[0] === "channels" && p[1] === "feishu") {
      const feishu = gw.feishuChannel();
      if (!feishu) return fail(404, "feishu channel is not available");
      if (method === "GET" && p.length === 2) return ok(feishu.status());
      if (method === "GET" && p.length === 3 && p[2] === "status") return ok(feishu.status());
      if (method === "POST" && p.length === 3 && p[2] === "reload") {
        const csrf = sameOriginCheck(ctx.headers, ctx.expectedOrigin);
        if (!csrf.ok) return { status: 403, body: { error: { message: "forbidden" } } };
        return ok(await feishu.reload());
      }
      if (method === "POST" && p.length === 3 && p[2] === "provision") {
        const csrf = sameOriginCheck(ctx.headers, ctx.expectedOrigin);
        if (!csrf.ok) return { status: 403, body: { error: { message: "forbidden" } } };
        return ok(await feishu.startProvision(body ?? {}));
      }
      if (method === "POST" && p.length === 3 && p[2] === "sync") {
        const csrf = sameOriginCheck(ctx.headers, ctx.expectedOrigin);
        if (!csrf.ok) return { status: 403, body: { error: { message: "forbidden" } } };
        return ok(await feishu.syncMeshChats());
      }
      if (method === "POST" && p.length === 5 && p[2] === "meshes" && p[4] === "group") {
        const csrf = sameOriginCheck(ctx.headers, ctx.expectedOrigin);
        if (!csrf.ok) return { status: 403, body: { error: { message: "forbidden" } } };
        return ok(await feishu.ensureMeshChat(str(p[3])));
      }
      if (method === "GET" && p.length === 4 && p[2] === "provision") {
        const job = feishu.getProvision(str(p[3]));
        return job ? ok(job) : fail(404, "feishu provision job not found");
      }
      if (method === "POST" && p.length === 5 && p[2] === "provision" && p[4] === "cancel") {
        const csrf = sameOriginCheck(ctx.headers, ctx.expectedOrigin);
        if (!csrf.ok) return { status: 403, body: { error: { message: "forbidden" } } };
        const job = feishu.cancelProvision(str(p[3]));
        return job ? ok(job) : fail(404, "feishu provision job not found");
      }
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
        const feishu = gw.feishuChannel();
        if (!feishu) return ok();
        const meshName = str((body as MeshConfig)?.name);
        try {
          return ok({ feishu: await feishu.ensureMeshChat(meshName) });
        } catch (e: any) {
          return ok({ feishu: { mesh: meshName, ok: false, error: str(e?.message ?? e) } });
        }
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
      // GET /api/meshes/:name/board — works for stopped (BoardStore) and running (live snapshot)
      if (method === "GET" && p.length === 3 && p[2] === "board") {
        return ok(await gw.getBoard(name));
      }
      // POST /api/meshes/:name/board — operator mutation; running-only; CAS → 409
      if (method === "POST" && p.length === 3 && p[2] === "board") {
        const command = body?.command;
        const expectedBoardRevision = Number(body?.expectedBoardRevision);
        if (!command || typeof command !== "object") return fail(400, "command is required");
        if (!Number.isInteger(expectedBoardRevision)) return fail(400, "expectedBoardRevision must be an integer");
        let result;
        try {
          result = await gw.applyBoard(name, command, expectedBoardRevision);
        } catch (e: any) {
          const msg = str(e?.message ?? e);
          return fail(/not running/.test(msg) ? 409 : 400, msg); // stopped meshes are read-only
        }
        if (!result.ok) {
          const status = result.code === "conflict" ? 409 : result.code === "forbidden" ? 403 : result.code === "not_found" ? 404 : 400;
          return fail(status, result.error);
        }
        return ok({ board: result.state, change: result.change });
      }
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
          // Body carries saved/applied/error so the UI can distinguish "persisted, pending
          // restart" from "live apply failed"; a live failure is never reported as plain success.
          return ok(await gw.setMode(name, agentId, str(body?.modeId)));
        }
        if (p[4] === "model") {
          return ok(await gw.setModel(name, agentId, str(body?.modelId)));
        }
        if (p[4] === "effort") {
          return ok(await gw.setEffort(name, agentId, (body?.effort || undefined) as any));
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
      // GET /api/meshes/:name/agents/:id/transcript?before=<item-id>&limit=<n>
      if (method === "GET" && p.length === 5 && p[2] === "agents" && p[4] === "transcript") {
        const rawLimit = query.get("limit");
        const limit = rawLimit == null || rawLimit === "" ? DEFAULT_BACKFILL_LIMIT : Number.parseInt(rawLimit, 10);
        if (!Number.isFinite(limit) || limit > MAX_BACKFILL_LIMIT) return fail(400, `limit must be between 1 and ${MAX_BACKFILL_LIMIT}`);
        const clamped = Math.max(1, limit);
        const result = gw.getOlderTranscriptItems(name, str(p[3]), query.get("before") ?? undefined, clamped);
        if (!result) return fail(404, "transcript not found");
        return ok(result);
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

/** The live gateway snapshot for ps-detail enrichment, or undefined if unavailable (e.g. the bare
 *  proxy-mode stub). Never throws into the request path — a missing snapshot just falls back to the
 *  static config detail in webPsSources. */
function safeSnapshot(gw: WebGateway): import("../diagnostics-sources").LiveSnapshot | undefined {
  try {
    return typeof gw?.snapshot === "function" ? (gw.snapshot() as unknown as import("../diagnostics-sources").LiveSnapshot) : undefined;
  } catch {
    return undefined;
  }
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
