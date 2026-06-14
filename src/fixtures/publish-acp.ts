// Deterministic ACP adapter fixture that drives the mesh_publish_attachment tool over a
// real MCP client connection to the injected mesh-services server. Used by the
// artifact-publish e2e: on each prompt it interprets a "publish-*" command, (optionally)
// writes a file into $AGENT_MESH_ARTIFACTS, then calls the tool and echoes its result so
// the e2e can assert both the tool reply and the resulting attachment card.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// A valid 1x1 PNG so the artifact image-magic guard accepts published images.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4DwQACfsD/aDefpkAAAAASUVErkJggg==",
  "base64",
);

const artifactsDir = process.env.AGENT_MESH_ARTIFACTS ?? "";
const clients = new Map<string, Client>();

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function result(id: unknown, value: unknown): void {
  send({ jsonrpc: "2.0", id, result: value });
}
function error(id: unknown, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code: -32004, message } });
}
function textOf(prompt: any[]): string {
  return (prompt ?? []).map((b) => b?.text ?? "").join("\n");
}
function setup(sessionId: string): unknown {
  return { sessionId, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } };
}
async function answer(sessionId: string, text: string): Promise<void> {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });
}

async function connectMcp(sessionId: string, mcpServers: any[]): Promise<void> {
  const http = (mcpServers ?? []).find((s) => s?.type === "http" && typeof s?.url === "string");
  if (!http) return;
  const client = new Client({ name: "publish-fixture", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
  clients.set(sessionId, client);
}

async function writeArtifact(relPath: string, bytes: Uint8Array | string): Promise<void> {
  const full = join(artifactsDir, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, bytes);
}

// Command grammar (one per prompt):
//   publish-image <name>        write a valid PNG then publish it (caption "the chart")
//   publish-doc <name>          write markdown then publish it (name "Weekly report")
//   publish-svg <name>          write an SVG then try to publish it (must be rejected)
//   publish-missing <path>      publish a path with no file written (rejected)
async function handlePrompt(sessionId: string, text: string): Promise<string> {
  const client = clients.get(sessionId);
  if (!client) return "PUBLISH_FAIL no mcp client";
  const m = text.match(/(publish-image|publish-doc|publish-svg|publish-missing)\s+(\S+)/);
  if (!m) return "no publish command";
  const [, cmd, name] = m;
  try {
    let args: Record<string, unknown> = { path: name };
    if (cmd === "publish-image") {
      await writeArtifact(name, PNG);
      args = { path: name, caption: "the chart" };
    } else if (cmd === "publish-doc") {
      await writeArtifact(name, "# Weekly report\n\nbody\n");
      args = { path: name, name: "Weekly report" };
    } else if (cmd === "publish-svg") {
      await writeArtifact(name, "<svg onload=alert(1)></svg>");
    }
    const res: any = await client.callTool({ name: "mesh_publish_attachment", arguments: args });
    const txt = res?.content?.[0]?.text ?? "";
    return `PUBLISH_RESULT ${txt}`;
  } catch (e) {
    return `PUBLISH_FAIL ${e instanceof Error ? e.message : String(e)}`;
  }
}

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const { id, method, params } = msg;
    try {
      if (method === "initialize") {
        result(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false } } });
      } else if (method === "session/new") {
        const sessionId = `pub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await connectMcp(sessionId, params?.mcpServers ?? []);
        result(id, setup(sessionId));
      } else if (method === "session/load") {
        const sessionId = String(params?.sessionId ?? "");
        await connectMcp(sessionId, params?.mcpServers ?? []);
        result(id, setup(sessionId));
      } else if (method === "session/prompt") {
        const sessionId = String(params?.sessionId ?? "");
        const reply = await handlePrompt(sessionId, textOf(params?.prompt ?? []));
        await answer(sessionId, reply);
        result(id, { stopReason: "end_turn" });
      } else if (method === "session/set_mode" || method === "session/set_model" || method === "session/cancel") {
        result(id, {});
      } else {
        error(id, `unknown method ${method}`);
      }
    } catch (err) {
      error(id, err instanceof Error ? err.message : String(err));
    }
  }
}
