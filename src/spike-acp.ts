// Spike: prove basic ACP connectivity + streaming against a real harness.
// Usage: bun run src/spike-acp.ts [codex|opencode|claude]
import { resolve } from "node:path";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@zed-industries/agent-client-protocol";

const harness = (process.argv[2] ?? "codex") as "codex" | "opencode" | "claude";
const HARNESS: Record<string, { command: string; args: string[] }> = {
  codex: { command: "codex-acp", args: [] },
  opencode: { command: "opencode", args: ["acp"] },
  claude: { command: "claude-agent-acp", args: [] },
};
const spec = HARNESS[harness];
const cwd = resolve(process.cwd(), "test_mesh_0");

console.log(`[spike] harness=${harness} command="${spec.command} ${spec.args.join(" ")}" cwd=${cwd}`);

const child = Bun.spawn([spec.command, ...spec.args], {
  cwd,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
  env: { ...process.env },
});

const output = new WritableStream<Uint8Array>({
  write(chunk) {
    child.stdin.write(chunk);
    child.stdin.flush();
  },
  close() {
    child.stdin.end();
  },
});

const stream = ndJsonStream(output, child.stdout as ReadableStream<Uint8Array>);

const conn = new ClientSideConnection(
  () => ({
    async sessionUpdate(params: any) {
      const u = params.update;
      console.log(`[update:${u.sessionUpdate ?? u.type ?? "?"}]`, JSON.stringify(u).slice(0, 300));
    },
    async requestPermission(params: any) {
      console.log("[permission-request]", JSON.stringify(params).slice(0, 400));
      const opt =
        params.options?.find((o: any) => o.kind === "allow_once") ?? params.options?.[0];
      console.log("[permission-auto-allow]", opt?.optionId);
      return { outcome: { outcome: "selected", optionId: opt.optionId } };
    },
  }),
  stream,
);

try {
  const init = await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  });
  console.log("[initialize]", JSON.stringify(init));

  const session = await conn.newSession({ cwd, mcpServers: [] });
  console.log("[newSession]", JSON.stringify(session));

  const res = await conn.prompt({
    sessionId: session.sessionId,
    prompt: [
      {
        type: "text",
        text: "Reply with a single short sentence confirming you are running. Do not use any tools.",
      },
    ],
  });
  console.log("[prompt-result]", JSON.stringify(res));
} catch (err) {
  console.error("[spike-error]", err);
} finally {
  child.kill();
  process.exit(0);
}
