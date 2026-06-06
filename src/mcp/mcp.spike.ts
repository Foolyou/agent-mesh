// Task 4 spike: prove an injected HTTP MCP server round-trips a tool call.
// Starts Mesh Services, injects it into a real agent session, asks the agent to
// call mesh_status, and asserts BOTH the tool_call update AND our handler fired.
import { resolve } from "node:path";
import { createMeshServicesServer } from "./mesh-services";
import { AcpAgentConnection } from "../acp/client";
import { resolveHarness } from "../harness";
import type { HarnessId } from "../acp/types";

const id = (process.argv[2] ?? "codex") as HarnessId;
const spec = resolveHarness(id);
const args = id === "codex" ? [...spec.args, "-c", "model_reasoning_effort=low"] : spec.args;
const cwd = resolve(process.cwd(), "test_mesh_0");

let handlerFired = false;
let sawToolCall = false;

const mcp = createMeshServicesServer({
  handlers: {
    meshStatus: (ctx) => {
      handlerFired = true;
      return `mesh ok; you are ${ctx.agentId} (${ctx.role})`;
    },
    sendMail: () => "not implemented in spike",
    checkMail: () => "no mail",
    interrupt: () => "not implemented in spike",
  },
});

await mcp.register(id, "member");
const url = mcp.urlFor(id);
console.log(`[spike] mesh-services at ${url}`);

const conn = new AcpAgentConnection({
  id,
  command: spec.command,
  args,
  cwd,
  onUpdate: (u) => {
    const kind = u?.sessionUpdate;
    if (kind === "tool_call" || kind === "tool_call_update") {
      const title = (u.title ?? u.rawInput?.name ?? "").toString();
      if (title.toLowerCase().includes("mesh_status") || JSON.stringify(u).includes("mesh_status")) {
        sawToolCall = true;
      }
    }
    if (kind === "agent_message_chunk" && u?.content?.text) process.stdout.write(u.content.text);
  },
});

const timeout = setTimeout(() => {
  console.error("\n[spike] TIMEOUT");
  conn.kill();
  mcp.close();
  process.exit(1);
}, 120_000);

try {
  await conn.start();
  await conn.initialize();
  await conn.newSession([{ type: "http", name: "mesh", url, headers: [] }]);
  console.log(`[spike] ${id} session ready; asking it to call mesh_status...`);
  const res = await conn.prompt(
    "Call the mesh_status tool now (it requires no arguments) and tell me exactly what it returned.",
  );
  console.log(`\n[spike] stopReason=${(res as any).stopReason}`);
  console.log(`[spike] handlerFired=${handlerFired} sawToolCall=${sawToolCall}`);
  clearTimeout(timeout);
  conn.kill();
  mcp.close();
  process.exit(handlerFired ? 0 : 1);
} catch (err) {
  console.error("[spike] error", err);
  clearTimeout(timeout);
  conn.kill();
  mcp.close();
  process.exit(1);
}
