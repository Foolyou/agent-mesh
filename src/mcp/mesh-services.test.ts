import { test, expect, afterEach } from "bun:test";
import { createMeshServicesServer, type MeshServicesServer } from "./mesh-services";

const noop = () => "";
const handlers = {
  meshStatus: noop,
  sendMail: noop,
  steerMail: noop,
  steerTargets: () => [] as string[],
  checkMail: noop,
  interrupt: noop,
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

test("re-registering an agent rebuilds its transport so a fresh MCP initialize succeeds (not 'Server already initialized')", async () => {
  server = createMeshServicesServer({ handlers });
  await server.register("A", "member");
  const url = server.urlFor("A");

  // First agent process handshakes successfully and binds the transport's session.
  const first = await initialize(url);
  expect(first.status).toBe(200);
  expect(first.headers.get("mcp-session-id")).toBeTruthy();

  // Simulate a respawn: a SECOND initialize against the SAME (un-rebuilt) transport is
  // rejected by the MCP SDK, which is the root cause of agents losing mesh tools.
  const stale = await initialize(url);
  expect(stale.status).toBe(400);

  // Re-registering (what every respawn now does) rebuilds the transport; the new
  // agent process can handshake again.
  await server.register("A", "member");
  const afterReRegister = await initialize(url);
  expect(afterReRegister.status).toBe(200);
  expect(afterReRegister.headers.get("mcp-session-id")).toBeTruthy();
});
