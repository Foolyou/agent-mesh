// src/mcp/mesh-control.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshManager } from "../mesh-manager";
import { createMeshControlHandlers, createMeshControlServer, type MeshControlServer } from "./mesh-control";
import { readSessionState, writeSessionState } from "../session-storage";
import type { MeshConfig } from "../acp/types";

const cfg: MeshConfig = {
  name: "echo",
  agents: [{ id: "r", harness: "claude", project: "test_mesh_0", role: "router" }],
  edges: [],
};
const FIXTURE = join(import.meta.dir, "..", "fixtures", "echo-host.ts");

let dir: string;
let mgr: MeshManager;
let server: MeshControlServer | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ctl-"));
  mgr = new MeshManager({ meshesDir: join(dir, "meshes"), runDir: join(dir, "run"), hostScript: FIXTURE });
});
afterEach(async () => { server?.close(); server = undefined; await mgr.stopAll(); await rm(dir, { recursive: true, force: true }); });

async function initialize(url: string): Promise<string | undefined> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    }),
  });
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

async function listToolSchemas(url: string, session: string | undefined): Promise<Array<{ name: string; inputSchema: any }>> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.result.tools ?? [];
}

async function listTools(url: string, session: string | undefined): Promise<string[]> {
  return (await listToolSchemas(url, session)).map((tool: { name: string }) => tool.name).sort();
}

test("create -> start -> list -> stop via handlers", async () => {
  const h = createMeshControlHandlers(mgr);
  expect(await h.createMesh(cfg)).toMatch(/created mesh "echo"/i);
  expect(await h.startMesh("echo")).toMatch(/started/i);
  expect(h.listMeshes()).toMatch(/echo.*running/i);
  expect(await h.stopMesh("echo")).toMatch(/stopped/i);
});

test("mesh-control MCP exposes update_mesh and lifecycle tools", async () => {
  server = await createMeshControlServer({ handlers: createMeshControlHandlers(mgr) });
  const session = await initialize(server.url);

  const tools = await listTools(server.url, session);
  expect(tools).toContain("create_mesh");
  expect(tools).toContain("get_mesh");
  expect(tools).toContain("update_mesh");
  expect(tools).toContain("delete_mesh");
  expect(tools).toContain("start_mesh");
  expect(tools).toContain("stop_mesh");
  expect(tools).toContain("list_meshes");
});

test("create and update mesh expose simple object-edge schemas for ACP harness compatibility", async () => {
  server = await createMeshControlServer({ handlers: createMeshControlHandlers(mgr) });
  const session = await initialize(server.url);
  const schemas = await listToolSchemas(server.url, session);

  for (const name of ["create_mesh", "update_mesh"]) {
    const tool = schemas.find((t) => t.name === name);
    expect(tool).toBeTruthy();
    const edgeItems = tool!.inputSchema.properties.edges.items;
    expect(edgeItems.type).toBe("object");
    expect(edgeItems.anyOf).toBeUndefined();
    expect(edgeItems.properties.from.type).toBe("string");
    expect(edgeItems.properties.to.type).toBe("string");
  }
});

test("create and update mesh expose optional per-agent configuration fields", async () => {
  server = await createMeshControlServer({ handlers: createMeshControlHandlers(mgr) });
  const session = await initialize(server.url);
  const schemas = await listToolSchemas(server.url, session);

  for (const name of ["create_mesh", "update_mesh"]) {
    const tool = schemas.find((t) => t.name === name);
    expect(tool).toBeTruthy();
    const agentProperties = tool!.inputSchema.properties.agents.items.properties;
    expect(agentProperties.instructions.type).toBe("string");
    expect(agentProperties.instructions.description).toContain("per-agent instructions");
    expect(agentProperties.lazy.type).toBe("boolean");
    expect(agentProperties.effort.enum).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(agentProperties.opencodePermission.enum).toEqual(["allow", "ask"]);
    expect(agentProperties.mode.type).toBe("string");
    expect(agentProperties.model.type).toBe("string");
    expect(tool!.inputSchema.properties.charter.description).toContain("distinct from per-agent instructions");
  }
});

test("startMesh can request fresh sessions via handlers", async () => {
  const h = createMeshControlHandlers(mgr);
  await h.createMesh(cfg);
  await writeSessionState(join(dir, "run"), "echo", {
    meshExpectedAlive: false,
    agents: { r: { sessionId: "old", cwd: ".", harness: "claude", mailCursor: "mail-r" } },
  });

  expect(await h.startMesh("echo", "fresh")).toMatch(/fresh sessions/i);

  const rec = (await readSessionState(join(dir, "run"), "echo")).agents.r;
  expect(rec.sessionId).toBe("");
  expect(rec.mailCursor).toBe("mail-r");
});

test("createMesh returns the validation error as text (no throw)", async () => {
  const h = createMeshControlHandlers(mgr);
  expect(await h.createMesh({ ...cfg, agents: [] })).toMatch(/error.*at least one/i);
});

test("getMesh returns config JSON; updateMesh modifies it; deleteMesh removes it", async () => {
  const h = createMeshControlHandlers(mgr);
  await h.createMesh(cfg);

  const got = h.getMesh("echo");
  expect(JSON.parse(got).agents[0].project).toBe("test_mesh_0");

  const modified: MeshConfig = {
    ...cfg,
    agents: [{ ...cfg.agents[0]!, project: "test_mesh_web" }],
    charter: "be concise",
  };
  expect(await h.updateMesh(modified)).toMatch(/updated mesh "echo"/i);
  expect(JSON.parse(h.getMesh("echo")).agents[0].project).toBe("test_mesh_web");
  expect(JSON.parse(h.getMesh("echo")).charter).toBe("be concise");

  expect(await h.deleteMesh("echo")).toMatch(/deleted mesh "echo"/i);
  expect(h.listMeshes()).toMatch(/no meshes/i);
});

test("createMesh and updateMesh persist per-agent instructions", async () => {
  const h = createMeshControlHandlers(mgr);
  await h.createMesh({
    ...cfg,
    agents: [{ ...cfg.agents[0]!, instructions: "Route requests to the right teammate." }],
  });

  expect(JSON.parse(h.getMesh("echo")).agents[0].instructions).toBe("Route requests to the right teammate.");

  await h.updateMesh({
    ...cfg,
    agents: [{ ...cfg.agents[0]!, instructions: "Keep coordination concise." }],
  });

  expect(JSON.parse(h.getMesh("echo")).agents[0].instructions).toBe("Keep coordination concise.");
});

test("updateMesh / deleteMesh refuse while running (errors returned as text)", async () => {
  const h = createMeshControlHandlers(mgr);
  await h.createMesh(cfg);
  await h.startMesh("echo");
  expect(await h.updateMesh(cfg)).toMatch(/error.*running/i);
  expect(await h.deleteMesh("echo")).toMatch(/error.*running/i);
  await h.stopMesh("echo");
});

test("updateMesh validates; getMesh on unknown mesh returns an error", async () => {
  const h = createMeshControlHandlers(mgr);
  await h.createMesh(cfg);
  expect(await h.updateMesh({ ...cfg, agents: [] })).toMatch(/error.*at least one/i);
  expect(h.getMesh("ghost")).toMatch(/error/i);
});
