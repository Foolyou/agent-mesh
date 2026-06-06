# Agent Mesh Controller PoC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a PoC Agent Mesh Controller where one global control plane (sole ACP client) orchestrates a hardwired mesh of heterogeneous real ACP agents (codex, opencode, claude), proving 6 core behaviors end-to-end, surfaced in a Bun TUI.

**Architecture:** Single control-plane process holds one `@zed-industries/agent-client-protocol` ClientSideConnection per agent. A single HTTP MCP server (Mesh Services) is injected into every agent session, giving agents `send_mail`/`check_mail` (and Router-only `interrupt`/`mesh_status`) tools whose calls flow back into the control plane. Inter-agent messaging is async via an addressed NDJSON mailbox; only the Router may interrupt (→ `session/cancel`); permission requests escalate to a human via the TUI.

**Tech Stack:** Bun + TypeScript; `@zed-industries/agent-client-protocol` v0.4.5 (client + schema); `@modelcontextprotocol/sdk` v1.29.0 (HTTP MCP server). Harnesses: `codex-acp`, `opencode acp`, `claude-agent-acp`.

**Spec:** `docs/superpowers/specs/2026-06-06-agent-mesh-poc-design.md` (read it).

**Testing reality:** ACP/agent integration is slow and non-deterministic, so pure unit-TDD only fits the deterministic modules (mailbox addressing, mesh model, harness registry, MCP tool handlers driven directly). The agent-facing paths are validated by **integration smoke scripts** that drive real agents and assert on the mailbox / event log — this is called out per task. The 6 verification points are proven by `src/e2e.ts` (Task 10).

**The 6 verification points (acceptance):**
1. Control plane spawns + manages ≥2 heterogeneous ACP agents, sees structured event streams.
2. A hardwired mesh: a Router (gateway) agent + members, roles + interaction graph registered.
3. Inter-agent mailbox: agent A `send_mail`→B, B receives & processes.
4. A member's `session/request_permission` escalates to TUI → human decision → result returned to agent.
5. Router `interrupt(member)` → control-plane `session/cancel` on that member.
6. TUI renders 1–5 live.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/acp/types.ts` | Re-export ACP schema types; define domain types (`AgentId`, `AgentRole`, `MeshConfig`, `MeshEvent`). |
| `src/acp/client.ts` | `AcpAgentConnection`: spawn a harness, wire ndJsonStream + ClientSideConnection, expose `initialize`/`newSession`/`prompt`/`cancel`, route inbound `sessionUpdate`/`requestPermission` to injected callbacks, track liveness. |
| `src/harness.ts` | `HARNESSES` registry (codex/opencode/claude → command+args); `resolveHarness(id)`. |
| `src/mailbox.ts` | (extend existing) add `to`/`mesh` addressing + `readMailFor(agentId)`; keep NDJSON + tolerant read. |
| `src/mesh.ts` | `Mesh` model: members, router designation, interaction graph (`canMail(from,to)`), liveness state. |
| `src/mcp/mesh-services.ts` | HTTP MCP server (one, shared). Tools: `send_mail`, `check_mail`, `mesh_status`, Router-only `interrupt`. Identifies caller by URL path token. Delegates to control-plane handlers. |
| `src/control-plane.ts` | `ControlPlane`: builds mesh from config, starts MCP server, spawns all agents (injecting MCP), event bus, routes user input to Router, executes `deliverMail`/`interrupt`, manages permission-decision queue. |
| `src/config.ts` | Hardwired demo `MeshConfig` (router=claude, members=codex+opencode, cwd=`test_mesh_0`). |
| `src/tui/app.ts` | Bun TUI: control-plane / mesh / agent views from event bus + pending-permission decision keys. |
| `src/main.ts` | Entrypoint: build ControlPlane from config, launch TUI. |
| `src/e2e.ts` | Headless scripted run asserting the 6 verification points. |

Existing PTY files (`src/pty-*.ts`, `mock-agent.ts`, `codex-*-test.ts`, `work-packet.ts`) are untouched legacy. `src/spike-acp.ts` is the connectivity spike; `src/acp/client.ts` generalizes it.

---

## Task 1: Harness registry

**Files:** Create `src/harness.ts`, `src/acp/types.ts`; Test `src/harness.test.ts`

- [ ] **Step 1 — failing test** (`src/harness.test.ts`):
```ts
import { expect, test } from "bun:test";
import { resolveHarness, HARNESSES } from "./harness";
test("resolves all three harnesses to a command", () => {
  expect(resolveHarness("codex").command).toBe("codex-acp");
  expect(resolveHarness("opencode").args).toEqual(["acp"]);
  expect(resolveHarness("claude").command).toBe("claude-agent-acp");
});
test("unknown harness throws", () => {
  expect(() => resolveHarness("nope" as any)).toThrow();
});
```
- [ ] **Step 2 — run, expect FAIL:** `bun test src/harness.test.ts` (module not found).
- [ ] **Step 3 — implement** `src/acp/types.ts`:
```ts
export * as schema from "@zed-industries/agent-client-protocol";
export type HarnessId = "codex" | "opencode" | "claude";
export type AgentRole = "router" | "member";
export type AgentId = string; // unique within a mesh, e.g. "codex-1"
export interface AgentConfig { id: AgentId; harness: HarnessId; project: string; role: AgentRole; }
export interface MeshConfig { name: string; agents: AgentConfig[]; edges: Array<[AgentId, AgentId]>; }
export type MeshEvent =
  | { kind: "agent_status"; agent: AgentId; status: "spawning"|"ready"|"dead"; detail?: string; ts: string }
  | { kind: "update"; agent: AgentId; update: unknown; ts: string }
  | { kind: "mail"; from: AgentId; to: AgentId; body: string; ts: string }
  | { kind: "permission"; agent: AgentId; requestId: string; question: string; options: {id:string;name:string}[]; ts: string }
  | { kind: "permission_resolved"; agent: AgentId; requestId: string; optionId: string; by: "human"|"timeout"; ts: string }
  | { kind: "interrupt"; from: AgentId; target: AgentId; ts: string }
  | { kind: "log"; text: string; ts: string };
```
  and `src/harness.ts`:
```ts
import type { HarnessId } from "./acp/types";
export const HARNESSES: Record<HarnessId, {command:string; args:string[]}> = {
  codex:    { command: "codex-acp", args: [] },
  opencode: { command: "opencode", args: ["acp"] },
  claude:   { command: "claude-agent-acp", args: [] },
};
export function resolveHarness(id: HarnessId) {
  const h = HARNESSES[id];
  if (!h) throw new Error(`unknown harness: ${id}`);
  return h;
}
```
- [ ] **Step 4 — run, expect PASS:** `bun test src/harness.test.ts`.
- [ ] **Step 5 — commit:** `git add src/harness.ts src/acp/types.ts src/harness.test.ts && git commit -m "feat: harness registry + core types"`

---

## Task 2: Addressed mailbox

**Files:** Modify `src/mailbox.ts`; Test `src/mailbox.test.ts`

- [ ] **Step 1 — failing test** (`src/mailbox.test.ts`): write to a temp mailbox path, send two addressed events, assert `readMailFor("b")` returns only mail addressed to `b` and after marking read returns none.
```ts
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendMail, readMailFor } from "./mailbox";
test("readMailFor returns only undelivered mail for the agent", async () => {
  const p = join(tmpdir(), `mbx-${crypto.randomUUID()}.ndjson`);
  await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "b", body: "hi-b" });
  await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "c", body: "hi-c" });
  const forB = await readMailFor("b", { mailboxPath: p });
  expect(forB.map(m => m.body)).toEqual(["hi-b"]);
});
```
- [ ] **Step 2 — run, expect FAIL** (`sendMail`/`readMailFor` not exported).
- [ ] **Step 3 — implement:** extend `MailboxEvent` with `to?: string`, `mesh?: string`, `deliveredTo?: boolean` is NOT used (delivery tracked by control plane in-memory cursor for PoC). Add:
```ts
export async function sendMail(i:{mailboxPath?:string;mesh:string;from:string;to:string;body:string}) {
  return sendMailboxEvent({ mailboxPath:i.mailboxPath, from:i.from, type:"handoff", body:i.body,
    meta:{ to:i.to, mesh:i.mesh } });
}
export async function readMailFor(agent:string, o:{mailboxPath?:string; sinceId?:string}={}) {
  const all = await readMailboxEvents(o.mailboxPath);
  let evs = all.filter(e => (e.meta as any)?.to === agent);
  if (o.sinceId) { const i = evs.findIndex(e=>e.id===o.sinceId); if (i>=0) evs = evs.slice(i+1); }
  return evs;
}
```
  (Keep existing `sendMailboxEvent`/`readMailboxEvents`; `readMailFor` filters by `meta.to`. The control plane tracks a per-recipient cursor in memory.)
- [ ] **Step 4 — run, expect PASS:** `bun test src/mailbox.test.ts`.
- [ ] **Step 5 — commit.**

---

## Task 3: AcpAgentConnection (generalize the spike)

**Files:** Create `src/acp/client.ts`; Smoke `src/acp/client.smoke.ts`

- [ ] **Step 1 — implement `AcpAgentConnection`** wrapping the proven spike flow:
  - ctor takes `{ id, command, args, cwd, onUpdate(update), onPermission(req)=>Promise<optionId|"cancel">, onExit() }`.
  - `start()`: `Bun.spawn` (stdin/stdout pipe, stderr inherit), build `output` WritableStream + `ndJsonStream(output, child.stdout)`, `new ClientSideConnection(()=>({sessionUpdate, requestPermission}), stream)`.
    - `sessionUpdate(p)` → `onUpdate(p.update)`.
    - `requestPermission(p)` → call `onPermission`; map result to `{outcome:{outcome:"selected",optionId}}` or `{outcome:{outcome:"cancelled"}}`.
  - `initialize()` → `conn.initialize({protocolVersion: schema.PROTOCOL_VERSION, clientCapabilities:{fs:{readTextFile:true,writeTextFile:true}, terminal:true}})`.
  - `newSession(mcpServers)` → `conn.newSession({cwd, mcpServers})`, store `sessionId`.
  - `prompt(text)` → `conn.prompt({sessionId, prompt:[{type:"text", text}]})`.
  - `cancel()` → `conn.cancel({sessionId})`. (Verify method name on `Agent`: it is `cancel`.)
  - track `child.exited.then(()=>onExit())` for liveness.
- [ ] **Step 2 — smoke** (`src/acp/client.smoke.ts`): spawn codex, init, session (mcpServers=[]), prompt "Say hi", collect updates, assert at least one `agent_message_chunk` arrived; print and exit 0/1.
- [ ] **Step 3 — run smoke:** `bun run src/acp/client.smoke.ts codex` → expect a message chunk + exit 0. (codex `xhigh` is slow; allow ~90s. Optionally pass `-c model_reasoning_effort=low` via harness args during dev.)
- [ ] **Step 4 — commit.**

---

## Task 4: Mesh Services MCP — tool round-trip spike (CRITICAL de-risk)

**Files:** Create `src/mcp/mesh-services.ts`; Spike `src/mcp/mcp.spike.ts`

This proves an agent actually **connects to our injected HTTP MCP server and calls a tool** — the foundation for mailbox + interrupt. Do this before the control plane.

- [ ] **Step 1 — implement minimal MCP server** using `@modelcontextprotocol/sdk`:
  - `createMeshServicesServer({ onToolCall(agentId, tool, args) })` returns `{ urlFor(agentId), close() }`.
  - Use `McpServer` + `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/{mcp,streamableHttp}.js`, served by `Bun.serve`. Route by URL path `/{agentId}/mcp` so the caller's identity = path segment.
  - Register one tool for the spike: `mesh_status` (no args) returning text `"mesh ok; you are <agentId>"` and invoking `onToolCall`.
  - **Note:** Streamable HTTP transport details (Accept: application/json+text/event-stream, optional `mcp-session-id`) are handled by the SDK transport; confirm Bun.serve passes a Node-compatible req/res or use the transport's `handleRequest(nodeReq,nodeRes,body)` — adapt with a small shim if Bun's `Request` is used. If the SDK transport cannot run under Bun.serve, fall back to running the MCP server on Node's `http` module inside the same process.
- [ ] **Step 2 — spike** (`src/mcp/mcp.spike.ts`): start server, get `urlFor("codex-1")`, spawn codex via `AcpAgentConnection`, `newSession([{type:"http", name:"mesh", url, headers:[]}])`, prompt: *"Call the mesh_status tool now and report what it returns."*, watch for a `tool_call` update naming `mesh_status` AND `onToolCall` firing. Assert both; exit 0/1.
- [ ] **Step 3 — run spike:** `bun run src/mcp/mcp.spike.ts` → expect `onToolCall("codex-1","mesh_status",…)` to fire and a `tool_call` update observed.
  - **If it fails** (transport/interop): try opencode (`mcpCapabilities.http+sse`), inspect agent stderr, and if HTTP MCP truly can't round-trip, switch to **stdio MCP** (`type:"stdio"`, our server as a child process per session) — the SDK has `StdioServerTransport`. Document the switch in the spec.
- [ ] **Step 4 — commit** (server + spike, regardless of http-vs-stdio outcome, with a note recording which transport works).

---

## Task 5: Mesh model + ControlPlane core (spawn from config)

**Files:** Create `src/mesh.ts`, `src/control-plane.ts`, `src/config.ts`; Test `src/mesh.test.ts`

- [ ] **Step 1 — failing test** (`src/mesh.test.ts`): build a `Mesh` from a config with edges `[["a","b"]]`; assert `mesh.router` is the role==="router" agent, `canMail("a","b")===true`, `canMail("b","a")===false`, `canMail("a","z")===false`.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement `Mesh`** (pure model: members map, `router` getter, `canMail`, liveness setters) and `src/config.ts`:
```ts
import type { MeshConfig } from "./acp/types";
export const DEMO_MESH: MeshConfig = {
  name: "demo",
  agents: [
    { id: "router",   harness: "claude",   project: "test_mesh_0", role: "router" },
    { id: "codex-1",  harness: "codex",    project: "test_mesh_0", role: "member" },
    { id: "opencode-1", harness: "opencode", project: "test_mesh_0", role: "member" },
  ],
  edges: [["codex-1","opencode-1"], ["opencode-1","codex-1"], ["router","codex-1"], ["router","opencode-1"]],
};
```
- [ ] **Step 4 — implement `ControlPlane`** (no agent calls yet beyond spawn): `start()` → start MCP server, for each agent create `AcpAgentConnection` (mcpServers=[ mesh url for that agent ]), `initialize()`+`newSession()`, emit `agent_status`. Provide `on(listener)` event bus, `emit(ev)`. `stop()` kills all.
- [ ] **Step 5 — run mesh.test PASS** and a manual `bun run src/main.ts` boot (Task 9 adds TUI; here just log events) showing all 3 agents reach `ready`. **(verification points 1, 2)**
- [ ] **Step 6 — commit.**

---

## Task 6: Mailbox tools + delivery (A→B)

**Files:** Modify `src/mcp/mesh-services.ts`, `src/control-plane.ts`; Smoke `src/flows/mail.smoke.ts`

- [ ] **Step 1 — add tools** `send_mail({to, body})` and `check_mail()` to the MCP server; both call control-plane handlers with the caller `agentId` (from path).
  - `send_mail`: control plane validates `mesh.canMail(from,to)`, writes `sendMail(...)`, emits `mail` event, then **wakes** the recipient: `conn(to).prompt("[MAIL from <from>]: <body>\n\nReply by calling send_mail back if appropriate.")`. Return `"delivered"`.
  - `check_mail`: returns undelivered mail for caller via `readMailFor` + advances that recipient's in-memory cursor.
- [ ] **Step 2 — smoke** (`src/flows/mail.smoke.ts`): boot control plane; prompt `codex-1`: *"Use send_mail to send 'ping from codex' to opencode-1."*; wait until a `mail` event `from=codex-1,to=opencode-1` appears AND `opencode-1` produces a subsequent `agent_message_chunk` (proving it was woken & processed). Assert both within timeout; exit 0/1.
- [ ] **Step 3 — run smoke** → expect mail event + recipient activity. **(verification point 3)**
- [ ] **Step 4 — commit.**

---

## Task 7: Permission escalation → human decision

**Files:** Modify `src/control-plane.ts`; Smoke `src/flows/permission.smoke.ts`

- [ ] **Step 1 — implement** `onPermission(agentId, req)` in the connection wiring: control plane pushes a `permission` event with a generated `requestId` and the option list; returns a Promise parked in a `pendingDecisions` map. `resolveDecision(requestId, optionId, by)` settles it and emits `permission_resolved`. Add a **timeout** (PoC: 60s → auto reject_once, `by:"timeout"`).
- [ ] **Step 2 — smoke** (`src/flows/permission.smoke.ts`): use a harness that asks permission for a file write. Set `claude` router session mode `default` (prompts) OR prompt `codex-1` (mode `auto`) to do a network/edit op requiring approval, e.g. *"Create a file ./perm-probe.txt with text 'ok' — you will need to request permission."* Register a listener that auto-resolves the first `permission` event by selecting an `allow_once` option after a short delay (simulating the human keypress). Assert a `permission` event was emitted AND a `permission_resolved{by:"human"}` followed AND the file `test_mesh_0/perm-probe.txt` exists. exit 0/1.
- [ ] **Step 3 — run smoke** → expect permission round-trip + side effect. **(verification point 4)**
- [ ] **Step 4 — commit.**

---

## Task 8: Router interrupt → session/cancel

**Files:** Modify `src/mcp/mesh-services.ts`, `src/control-plane.ts`; Smoke `src/flows/interrupt.smoke.ts`

- [ ] **Step 1 — add Router-only tool** `interrupt({target, reason})`: the MCP server exposes it ONLY on the router's URL (or control plane rejects if caller role!=="router"). Handler: emit `interrupt` event, call `conn(target).cancel()`.
- [ ] **Step 2 — smoke** (`src/flows/interrupt.smoke.ts`): start a long task on `codex-1` (*"Count slowly from 1 to 100, printing your reasoning; take your time."*) without awaiting; once it's streaming, drive the router: *"Call interrupt with target 'codex-1' and reason 'stop'."*; assert an `interrupt` event fired and `codex-1`'s in-flight `prompt` promise settles with a cancelled/`stopReason` shortly after. exit 0/1.
- [ ] **Step 3 — run smoke** → expect interrupt + prompt resolution. **(verification point 5)**
- [ ] **Step 4 — commit.**

---

## Task 9: Bun TUI

**Files:** Create `src/tui/app.ts`; Modify `src/main.ts`

- [ ] **Step 1 — implement TUI** (raw-mode stdin, ANSI redraw; no extra deps). Subscribe to the control-plane event bus and render three panes:
  - **Control plane**: mesh name, MCP server URL, agent count, pending-decision count.
  - **Mesh**: per-agent row — id, harness, role, status (color), last update summary, mail counters.
  - **Agent detail**: last N events for the selected agent (Tab cycles selection).
  - **Permission prompt**: when a `permission` event is pending, show the question + options; keys `1..9` select an option → `resolveDecision(requestId, optionId, "human")`; `Tab` switch agent; `q` quit.
- [ ] **Step 2 — wire `src/main.ts`:** build ControlPlane(DEMO_MESH), start TUI, on quit `stop()`.
- [ ] **Step 3 — manual run:** `bun run src/main.ts` → see all agents go ready, drive a mail/permission/interrupt by typing scripted prompts (temporary keybindings or via e2e in Task 10) and watch them render. **(verification point 6)**
- [ ] **Step 4 — commit.**

---

## Task 10: End-to-end verification script

**Files:** Create `src/e2e.ts`; add `package.json` scripts

- [ ] **Step 1 — implement `src/e2e.ts`** (headless, no TUI; auto-resolves permissions): boots ControlPlane(DEMO_MESH), then sequentially asserts:
  1. all 3 agents reach `ready` (point 1, 2);
  2. driving `codex-1` send_mail→`opencode-1` yields a `mail` event + recipient activity (point 3);
  3. a permission request is emitted and auto-resolved `by:"human"` with the file side effect (point 4);
  4. router `interrupt(codex-1)` emits `interrupt` and settles the in-flight prompt (point 5).
  Print a ✅/❌ table; exit non-zero on any failure.
- [ ] **Step 2 — add scripts** to `package.json`: `"mesh": "bun run src/main.ts"`, `"e2e": "bun run src/e2e.ts"`, `"test": "bun test"`.
- [ ] **Step 3 — run:** `bun run e2e` → expect all ✅, exit 0.
- [ ] **Step 4 — update README** with PoC run instructions (`bun run mesh`, `bun run e2e`) and a one-paragraph architecture summary; **commit.**

---

## Self-Review

- **Spec coverage:** Topology/control-plane (Task 5), three-layer Project×Harness×Instance (harness Task 1 + config Task 5), Router gateway+interrupt (Task 8), mailbox (Tasks 2, 6), permission escalation (Task 7), MCP injection (Task 4), TUI (Task 9), all-6 acceptance (Task 10). Master agent / dynamic mesh / manual-send are out of scope per spec.
- **Risk ordering:** the only unproven mechanism (HTTP MCP tool round-trip) is Task 4, before anything depends on it, with a stdio-MCP fallback.
- **Type consistency:** `MeshEvent`, `AgentId`, `MeshConfig` defined once in `src/acp/types.ts` and used throughout; `sendMail`/`readMailFor` names match Tasks 2/6; `cancel()` used in Tasks 3/8.
- **Known limitation carried from spec:** Zed client lib drops vendor `usage_update` notifications (non-fatal); not required for any verification point.
