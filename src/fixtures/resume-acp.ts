// Deterministic ACP adapter fixture for session-resume e2e.
// It persists a tiny "sentinel" memory by ACP sessionId so the real mesh-host
// and ControlPlane can exercise session/new, session/load, and session/prompt
// without consuming a real provider.
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

const store = process.env.FAKE_ACP_STORE;
if (!store) {
  console.error("FAKE_ACP_STORE is required");
  process.exit(2);
}

type SessionData = { sessionId: string; cwd: string; sentinel?: string };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4DwQACfsD/aDefpkAAAAASUVErkJggg==";

const enc = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");
const sessionPath = (id: string) => join(store, `${enc(id)}.json`);

async function readSession(id: string): Promise<SessionData> {
  return JSON.parse(await readFile(sessionPath(id), "utf8")) as SessionData;
}

async function writeSession(data: SessionData): Promise<void> {
  await mkdir(store!, { recursive: true });
  await writeFile(sessionPath(data.sessionId), JSON.stringify(data), "utf8");
}

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
  return prompt.map((block) => block?.text ?? "").join("\n");
}

function setup(sessionId: string): unknown {
  return {
    sessionId,
    modes: {
      currentModeId: "default",
      availableModes: [{ id: "default", name: "Default" }],
    },
  };
}

async function answer(sessionId: string, text: string): Promise<void> {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
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
        result(id, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
        });
      } else if (method === "session/new") {
        const sessionId = `fake-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await writeSession({ sessionId, cwd: String(params?.cwd ?? "") });
        result(id, setup(sessionId));
      } else if (method === "session/load") {
        const data = await readSession(String(params?.sessionId ?? ""));
        result(id, setup(data.sessionId));
        if (process.env.FAKE_ACP_REPLAY_IMAGE === "1") {
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: data.sessionId,
              update: {
                sessionUpdate: "user_message_chunk",
                content: { type: "image", data: PNG, mimeType: "image/png" },
              },
            },
          });
        }
      } else if (method === "session/prompt") {
        const sessionId = String(params?.sessionId ?? "");
        const data = await readSession(sessionId);
        const text = textOf(params?.prompt ?? []);
        const remembered = text.match(/remember sentinel ([A-Za-z0-9._-]+)/i)?.[1];
        if (remembered) {
          data.sentinel = remembered;
          await writeSession(data);
          if (process.env.FAKE_ACP_EFFECTS) {
            await appendFile(process.env.FAKE_ACP_EFFECTS, `${remembered}\n`);
          }
          await answer(sessionId, `remembered ${remembered}`);
        } else if (/what(?:'s| is) the sentinel/i.test(text)) {
          await answer(sessionId, data.sentinel ?? "UNKNOWN");
        } else {
          const concise = text.includes("fresh hello after stop") ? "fresh hello after stop" : text.slice(0, 80);
          await answer(sessionId, `echo ${concise}`);
        }
        result(id, { stopReason: "end_turn" });
      } else if (method === "session/set_mode" || method === "session/set_model") {
        result(id, {});
      } else if (method === "session/cancel") {
        result(id, {});
      } else {
        error(id, `unknown method ${method}`);
      }
    } catch (err) {
      error(id, err instanceof Error ? err.message : String(err));
    }
  }
}
