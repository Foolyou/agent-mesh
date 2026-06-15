import { test, expect, afterEach } from "bun:test";
import { createMeshServicesServer, type MeshServicesServer } from "./mesh-services";

const noop = () => "";
const handlers = {
  meshStatus: noop,
  meshBriefing: noop,
  sendMail: noop,
  steerMail: noop,
  steerTargets: () => [] as string[],
  checkMail: noop,
  interrupt: noop,
  publishAttachment: noop,
  boardList: noop,
  applyBoard: noop,
};

let server: MeshServicesServer | undefined;
afterEach(() => { server?.close(); server = undefined; });

async function initialize(url: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    }),
  });
}

async function handshake(url: string): Promise<string | undefined> {
  const res = await initialize(url);
  expect(res.status).toBe(200);
  const session = res.headers.get("mcp-session-id") ?? undefined;
  await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return session;
}

async function callTool(url: string, session: string | undefined, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function listTools(url: string, session: string | undefined): Promise<string[]> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  return (body.result.tools ?? []).map((tool: { name: string }) => tool.name).sort();
}

// Root cause of toolless claude sessions (2026-06-10): claude-agent-acp makes MORE THAN
// ONE MCP initialize per spawn (an internal probe session plus the real session, ~2s apart).
// A stateful single-session transport accepts the first and rejects the rest with
// "Server already initialized", leaving the real session without mesh tools.
test("multiple MCP clients of one agent registration can all initialize and call tools", async () => {
  let calls = 0;
  server = createMeshServicesServer({
    handlers: { ...handlers, checkMail: () => `ok-${++calls}` },
    log: () => {},
  });
  await server.register("A", "member");
  const url = server.urlFor("A");

  // Client 1: e.g. the harness's internal probe session.
  const probe = await handshake(url);
  expect((await callTool(url, probe, "check_mail")).result.content[0].text).toBe("ok-1");

  // Client 2: the real agent session, seconds later, WITHOUT a re-register.
  const real = await handshake(url);
  expect((await callTool(url, real, "check_mail")).result.content[0].text).toBe("ok-2");

  // Client 3: a later reconnect (e.g. stream drop) must also survive.
  const reconnect = await handshake(url);
  expect((await callTool(url, reconnect, "check_mail")).result.content[0].text).toBe("ok-3");
});

test("mesh-services exposes collaboration tools but not mesh-control lifecycle tools", async () => {
  server = createMeshServicesServer({ handlers, log: () => {} });
  await server.register("A", "member");
  const url = server.urlFor("A");
  const session = await handshake(url);

  const tools = await listTools(url, session);
  expect(tools).toContain("send_mail");
  expect(tools).toContain("check_mail");
  expect(tools).toContain("mesh_status");
  expect(tools).not.toContain("update_mesh");
});

test("board tools: members get read + subtask/status/comment; create_task/epic/assign/priority/deps are router-only", async () => {
  server = createMeshServicesServer({ handlers, log: () => {} });
  await server.register("member-1", "member");
  await server.register("router-1", "router");

  const memberTools = await listTools(server.urlFor("member-1"), await handshake(server.urlFor("member-1")));
  for (const t of ["board_list", "board_create_subtask", "board_set_status", "board_comment"]) {
    expect(memberTools).toContain(t);
  }
  // Phase 0: creating a task (#issue) is router/operator-only — members work tasks dispatched to them.
  for (const t of ["board_create_task", "board_create_epic", "board_update_epic", "board_delete_epic", "board_assign", "board_set_priority", "board_set_deps"]) {
    expect(memberTools).not.toContain(t);
  }

  const routerTools = await listTools(server.urlFor("router-1"), await handshake(server.urlFor("router-1")));
  for (const t of ["board_create_task", "board_create_epic", "board_assign", "board_set_priority", "board_set_deps"]) {
    expect(routerTools).toContain(t);
  }
});

test("board_set_status forwards a typed command + CAS tokens to applyBoard", async () => {
  const calls: Array<{ command: any; ebr: number }> = [];
  server = createMeshServicesServer({
    handlers: { ...handlers, applyBoard: (_ctx, command, ebr) => { calls.push({ command, ebr }); return "ok"; } },
    log: () => {},
  });
  await server.register("A", "member");
  const url = server.urlFor("A");
  const session = await handshake(url);

  // target a subtask → set_subtask_status command shape
  const res = await callTool(url, session, "board_set_status", { taskId: 5, subtaskId: "5.1", status: "in_review", expectedRevision: 2, expectedBoardRevision: 7 });
  expect(res.result.content[0].text).toBe("ok");
  expect(calls).toHaveLength(1);
  expect(calls[0].ebr).toBe(7);
  expect(calls[0].command).toEqual({ type: "set_subtask_status", taskId: 5, subtaskId: "5.1", expectedRevision: 2, status: "in_review" });
});

test("tool calls produce structured start/end logs with agent, tool, request id, and duration", async () => {
  const logs: any[] = [];
  server = createMeshServicesServer({
    handlers: { ...handlers, checkMail: () => "no new mail" },
    log: (entry) => logs.push(entry),
  });
  await server.register("A", "member");
  const url = server.urlFor("A");
  const session = await handshake(url);

  const res = await callTool(url, session, "check_mail");
  expect(res.result.content[0].text).toBe("no new mail");

  const start = logs.find((l) => l.event === "tool_start");
  const end = logs.find((l) => l.event === "tool_end");
  expect(start).toMatchObject({ agent: "A", tool: "check_mail" });
  expect(start.requestId).toBeString();
  expect(end).toMatchObject({ agent: "A", tool: "check_mail", requestId: start.requestId, ok: true });
  expect(end.durationMs).toBeNumber();
});

test("a hung tool handler times out with an explicit error instead of pending forever", async () => {
  const logs: any[] = [];
  server = createMeshServicesServer({
    handlers: { ...handlers, checkMail: () => new Promise<string>(() => {}) },
    log: (entry) => logs.push(entry),
    toolTimeoutMs: 50,
  });
  await server.register("A", "member");
  const url = server.urlFor("A");
  const session = await handshake(url);

  const res = await callTool(url, session, "check_mail");
  expect(res.result.content[0].text).toContain("timed out after 50ms");

  const end = logs.find((l) => l.event === "tool_end");
  expect(end).toMatchObject({ agent: "A", tool: "check_mail", ok: false });
  expect(end.error).toContain("timed out");
});

test("mesh_publish_attachment is exposed and forwards only path/caption/name, never caller-supplied owner", async () => {
  const calls: Array<{ ctx: any; path: string; opts: any }> = [];
  server = createMeshServicesServer({
    handlers: {
      ...handlers,
      publishAttachment: (ctx, path, opts) => {
        calls.push({ ctx, path, opts });
        return `published ${path}`;
      },
    },
    log: () => {},
  });
  await server.register("A", "member");
  const url = server.urlFor("A");
  const session = await handshake(url);

  expect(await listTools(url, session)).toContain("mesh_publish_attachment");

  // Caller tacks on impostor ownership fields; they must be structurally dropped so the
  // handler only ever sees path/caption/name and derives the owner from its own ctx.
  const res = await callTool(url, session, "mesh_publish_attachment", {
    path: "report.md",
    caption: "hi",
    name: "Report",
    owner: "victim",
    agent: "victim",
    mesh: "other",
  });
  expect(res.result.content[0].text).toBe("published report.md");

  expect(calls.length).toBe(1);
  expect(calls[0].path).toBe("report.md");
  expect(calls[0].ctx).toMatchObject({ agentId: "A", role: "member" });
  expect(calls[0].opts).toEqual({ caption: "hi", name: "Report" });
  // The impostor fields never reach the handler at all.
  expect(JSON.stringify(calls[0])).not.toContain("victim");
});

test("initialize always succeeds across respawns, with or without an intervening re-register", async () => {
  server = createMeshServicesServer({ handlers, log: () => {} });
  await server.register("A", "member");
  const url = server.urlFor("A");

  // First agent process handshakes successfully.
  const first = await initialize(url);
  expect(first.status).toBe(200);

  // A second initialize WITHOUT a re-register (in-process probe session, reconnect,
  // or a respawn we failed to notice) must also succeed — historically this was the
  // "Server already initialized" 400 that silently stripped mesh tools.
  const second = await initialize(url);
  expect(second.status).toBe(200);

  // And re-registering (every respawn does, to refresh steer targets) keeps working.
  await server.register("A", "member");
  const afterReRegister = await initialize(url);
  expect(afterReRegister.status).toBe(200);
});
