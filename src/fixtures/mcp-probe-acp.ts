// Deterministic ACP adapter fixture that ACTUALLY connects to the injected
// mesh-services HTTP MCP server (via the real MCP SDK client), so it exercises
// the same initialize/tools-list handshake a real harness does. Used to prove
// that mesh tools survive every respawn path (fresh / new-session / resume /
// new-all). On each prompt it reports its live tool list and a real mesh_status
// round-trip, so the e2e can assert tools are present after a respawn.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface McpState {
  tools: string[];
  statusOk: boolean;
  statusLen: number;
  err?: string;
}

const sessions = new Map<string, McpState>();

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

// Connect a fresh MCP client to the injected http mesh server and record the
// live tool list + a mesh_status round-trip. Failures are captured, never thrown,
// so a broken handshake surfaces as PROBE_FAIL rather than killing the agent.
async function connectMcp(sessionId: string, mcpServers: any[]): Promise<void> {
  const http = (mcpServers ?? []).find((s) => s?.type === "http" && typeof s?.url === "string");
  if (!http) {
    sessions.set(sessionId, { tools: [], statusOk: false, statusLen: 0, err: "no http mcp server injected" });
    return;
  }
  try {
    const client = new Client({ name: "mcp-probe", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(http.url));
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = (listed.tools ?? []).map((t) => t.name).sort();
    let statusOk = false;
    let statusLen = 0;
    try {
      const res: any = await client.callTool({ name: "mesh_status", arguments: {} });
      const txt = res?.content?.[0]?.text;
      statusOk = typeof txt === "string" && txt.length > 0 && res?.isError !== true;
      statusLen = typeof txt === "string" ? txt.length : 0;
    } catch {
      statusOk = false;
    }
    sessions.set(sessionId, { tools, statusOk, statusLen });
    await client.close();
  } catch (e) {
    sessions.set(sessionId, { tools: [], statusOk: false, statusLen: 0, err: e instanceof Error ? e.message : String(e) });
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
        const sessionId = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await connectMcp(sessionId, params?.mcpServers ?? []);
        result(id, setup(sessionId));
      } else if (method === "session/load") {
        const sessionId = String(params?.sessionId ?? "");
        await connectMcp(sessionId, params?.mcpServers ?? []);
        result(id, setup(sessionId));
      } else if (method === "session/prompt") {
        const sessionId = String(params?.sessionId ?? "");
        const st: McpState = sessions.get(sessionId) ?? { tools: [], statusOk: false, statusLen: 0, err: "no session state" };
        const text = textOf(params?.prompt ?? []);
        // Echo the prompt's nonce so the e2e can correlate this answer with the
        // turn it just sent (transcripts reset on new-session, so we can't count).
        const nonce = text.match(/probe ([A-Za-z0-9]+)/i)?.[1] ?? "?";
        if (st.err) await answer(sessionId, `PROBE_FAIL n=${nonce} ${st.err}`);
        else await answer(sessionId, `PROBE n=${nonce} tools=[${st.tools.join(",")}] statusOk=${st.statusOk} len=${st.statusLen}`);
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
