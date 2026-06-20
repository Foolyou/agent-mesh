# Pi Coding Agent → Agent Mesh: Feasibility Research

Status: research only (no code change). Round 1: branch `task/pi-agent-feasibility` (main `4b2affa`).
Round 2 (MCP-extension re-evaluation, §10): branch `task/pi-mcp-extension-research` (main `e229b58`).
Date: 2026-06-20. Author: team2_builder.

Evidence is tagged inline (one fixed vocabulary — use exactly these four):
- **[confirmed]** — verified against official docs / repo / our source code / a test I ran (link or path).
- **[not found]** — looked for an official source and could not find one; stated as a gap, not a fact.
- **[not verified]** — a claim I *could* have tested but did **not** in this spike (distinct from [not found]:
  the source/path is known, it just wasn't exercised). Used mainly for the §10 spike's remaining gates.
- **[inference]** — my reasoning/risk assessment, not a quoted fact.

> ## ⚠️ UPDATE — Round 2 (2026-06-20, branch `task/pi-mcp-extension-research`, main `e229b58`)
>
> Round 1's central premise was **wrong**: it assumed "Pi cannot consume MCP servers". **Pi has mature,
> MCP-*consuming* extensions**, and I **validated hands-on** that Pi calls a tool on an external
> **streamable-HTTP** MCP server (our mesh transport) headlessly. **The MCP gap is NOT a blocker.**
>
> **Revised verdict: CONDITIONAL GO** (was NO-GO). The gating risk is no longer "can Pi reach our MCP
> tools" (proven yes) but "can we wire pi-acp + the MCP extension together into a real mesh member that
> actually `send_mail`/`check_mail`s" — a spike, not a wall. **See the new §10 for the re-evaluation,
> evidence, architecture, and revised plan.** Sections 1–9 below are the round-1 record; where §1/§5 say
> "NO-GO / blocker", read them as **superseded by §10**.

---

## 1. Summary  *(round 1 — superseded by §10)*

Pi (the "Pi Coding Agent") is a **real, open-source** coding-agent CLI by Mario Zechner
(current npm `@earendil-works/pi-coding-agent`, repo `earendil-works/pi`). It has a native headless
**`pi --mode rpc`** integration mode and a **community ACP adapter (`pi-acp`)** that already works
with Zed; Pi is listed on Zed's ACP agent registry. **[confirmed]**

On the surface this is a perfect fit for our harness model: every Agent Mesh harness is just "a command
that speaks ACP/JSON-RPC over stdio" (`codex-acp`, `claude-agent-acp`, `opencode acp`, `kimi acp`), and
`pi-acp` is exactly that shape. **[confirmed]**

**The blocker is MCP.** Every mesh agent — router, member, and the Mesh Assistant — is handed the
mesh mailbox/board/control tools as an **HTTP MCP server** through ACP `session/new`
(`src/control-plane.ts:1203`: `mcpServers = [{ type: "http", name: "mesh", url: this.mcp.urlFor(a.id) }]`).
The mail-over-MCP loop *is* the mesh. The `pi-acp` adapter explicitly has **"no MCP passthrough"**, and
Pi itself does **not** consume MCP servers natively (MCP is "explicitly not built-in"). **[confirmed]**
So a Pi agent wired through today's `pi-acp` would start, stream, and run tools — but could not
`send_mail` / `check_mail` / use board tools, i.e. it cannot actually participate in a mesh.

**Recommendation: NO-GO as a production harness right now; conditional GO as a time-boxed spike.**
Adding Pi is cheap mechanically (the ~28-file "add a harness" surface is well-trodden), but it is
**not usable** until the MCP gap is closed, which means carrying/forking the third-party `pi-acp`
(an MVP at v0.0.31, "expect minor breaking changes", unofficial) **and** building a Pi-side bridge
that turns ACP-provided MCP servers into Pi tools. That is real, upstream-dependent work for a harness
that today buys us nothing the existing four don't already cover. See §5.

---

## 2. Pi surface (what we'd be integrating)

Sources: Pi repo `earendil-works/pi` / mirror `badlogic/pi-mono`, npm `@earendil-works/pi-coding-agent`,
Mario Zechner's write-up, and the ACP discussion `earendil-works/pi#4444`. **[confirmed]** unless noted.

**What Pi is**
- Open-source, MIT-style toolkit: "unified LLM API, agent loop, TUI, coding-agent CLI." Current install:
  `npm install -g @earendil-works/pi-coding-agent` (current npm `0.79.8`; the older `@mariozechner/
  pi-coding-agent` `0.73.1` is the historical package name, not the current source). **[confirmed]**
- Deliberately minimal core: built-in tools `read/write/edit/bash` (+ `grep/find/ls`); everything else
  is added via TypeScript **extensions / skills / "pi packages" / CLI-tools-with-READMEs**. **[confirmed]**
- Multi-provider (Anthropic, OpenAI, Google, xAI, Groq, …); auth via API keys **or** subscriptions
  (Claude Pro / ChatGPT Plus / GitHub Copilot). **[confirmed]**

**Integration / headless surface (the part that matters for us)**
- `pi -p` / `--print` — print response and exit. **[confirmed]**
- `--mode json` — emit all events as JSON lines. **[confirmed]**
- **`--mode rpc`** — "RPC mode for process integration", strict LF-delimited JSONL framing. This is
  Pi's *native* embedding protocol and **predates ACP**; it is **not ACP**. **[confirmed]**
- Model/effort: `--provider <name>`, `--model <pattern>`, `--thinking <off|minimal|low|medium|high|xhigh>`.
  So Pi has a real reasoning-effort ladder. **[confirmed]**
- Sessions/resume: `-c/--continue`, `-r/--resume`, `--session <path|id>`, `--fork`, `--no-session`;
  tree-structured sessions saved under `~/.pi/agent/sessions/`. **[confirmed]**
- Tools allow/deny: `-t/--tools`, `-xt/--exclude-tools`, `-nbt/--no-builtin-tools`. **[confirmed]**
- Image input: paste/drag in the TUI. Whether images pass through `--mode rpc`/`pi-acp` is
  **[not found]**. **[inference]** likely limited.
- **MCP: not built-in.** "Build CLI tools with READMEs … or build an extension that adds MCP support."
  **[confirmed]**

**ACP via the community adapter `pi-acp`** (npm `pi-acp`, repo `svkozak/pi-acp`; other forks exist:
`victor-software-house/pi-acp`, `nyanshak/pi-extensions/pi-acp`):
- Bridges **ACP JSON-RPC 2.0 over stdio ↔ spawns `pi --mode rpc`**. **[confirmed]**
- Implements core ACP: `initialize`, `session/new`, `session/prompt`, `session/update` streaming
  (`agent_message_chunk`), `tool_call` / `tool_call_update` (with file locations), session load/resume,
  slash commands, skills, structured diffs. **[confirmed]**
- Maturity: **MVP, v0.0.31 (June 2026)**, "expect some minor breaking changes", development centered on
  Zed compatibility. **[confirmed]**
- **Known limitations (adapter's own README / the ACP discussion):** *"no filesystem or terminal
  delegation, **no MCP passthrough**"*; "no separate thought stream"; client-side queue. **[confirmed]**
- ACP support in Pi is **unofficial** — community adapter only; no maintainer commitment, no MCP
  roadmap stated in `#4444`. **[confirmed]** / roadmap **[not found]**.
- Pi is listed on Zed's ACP agent registry (`zed.dev/acp/agent/pi`). **[confirmed]**

---

## 3. Agent Mesh harness contract (what a new harness must satisfy)

Derived from our source. A "harness" is a command that speaks ACP over stdio; the control-plane drives
it through `AcpAgentConnection` (`src/acp/client.ts`). To be a usable mesh agent it must satisfy:

1. **Spawn / stdio ACP.** Launchable as `{ command, args }` from the registry
   (`src/harness.ts` `HARNESSES`), speaking ACP JSON-RPC over stdio. `start()` spawns it;
   `initialize()` calls ACP `initialize`. **[confirmed: src/acp/client.ts:175,220; src/harness.ts:9]**
2. **`session/new` with injected MCP servers — the mailbox.** The control-plane passes the per-agent
   **mesh MCP** (HTTP) into every session: `mcpServers = [{ type:"http", name:"mesh", url: mcp.urlFor(id) }]`
   (`src/control-plane.ts:1203`, `:1222 newSession`, `:1213 loadSession`). The Mesh Assistant does the
   same with a `mesh-control` MCP (`src/mesh-assistant.ts:96`). **The agent MUST consume these MCP
   servers and expose their tools to the model** — that is how `send_mail`/`check_mail`/board/control
   work. **No MCP = no mail = not a mesh participant.** **[confirmed]**
3. **Streaming.** `session/update` notifications: `agent_message_chunk` (text), `tool_call` /
   `tool_call_update`. Consumed in `clientHandlers().sessionUpdate` and fanned out as `update` mesh
   events. **[confirmed: src/acp/client.ts:233; src/acp/types.ts:138]**
4. **Tool use.** Built-in coding tools (read/write/edit/bash) over the agent's `project` cwd. **[confirmed]**
5. **Approvals.** ACP `session/request_permission` → our `requestPermission` handler → `permission`
   mesh event → human/timeout decision. A harness that never asks works too (auto-approve modes), but if
   it asks, it must use the ACP permission flow. **[confirmed: src/acp/client.ts:238; types.ts:176]**
6. **Resume / crash-respawn.** `loadSession(sessionId, cwd, mcpServers)` to re-attach a persisted
   session after a respawn; gated on `agentCapabilities.loadSession`
   (`src/acp/client.ts:227,309`). Persisted in `session-storage.ts`. A harness without `loadSession`
   degrades to a fresh session on respawn (acceptable but lossy). **[confirmed]**
7. **Cancel / kill.** ACP `cancel` (mid-turn interrupt / steer) and full process-tree kill
   (`killProcessTree`) on stop/respawn. **[confirmed: src/acp/client.ts:336,57]**
8. **Auth.** Out-of-band (the agent's own credentials/CLI login); the mesh injects nothing but the MCP
   URL — "agents reach the mesh via the injected MCP URL + prompt, never via env"
   (`src/acp/client.ts:185`). **[confirmed]**
9. **Advertise: model / effort / mode / context-window.** Optional but feature-relevant:
   - models via `session/new` `configOptions[category=model]` or `models.availableModels`
     (`src/harness-models.ts:107`);
   - effort via `HARNESS_EFFORT_CAPABILITIES` + runtime ACP config option
     (`src/harness-utils.ts:10,103`);
   - context window normalized against a Zed-style model→window table because harnesses under-report
     (`src/acp/usage-compat.ts` `resolveContextWindow`, consumed in `control-plane.ts:20`); usage frames
     arrive as ACP `extNotification` (usage_update). A harness that advertises none of these still runs,
     but the model/effort pickers and the context gauge are empty/fallback. **[confirmed]**
10. **The "add a harness" code surface.** `HarnessId` (`src/acp/types.ts:6`) is a closed union threaded
    through ~28 files: registry (`harness.ts`), spawn/effort (`harness.ts spawnConfigFor`,
    `harness-utils.ts`), models (`harness-models.ts`), probe/version (`harness-probe.ts`),
    install (`harness-install-spec.ts`, `harness-install.ts`), cli-options, mesh-validate,
    session-storage, and the web client (`HarnessPanel.tsx`, `MeshBuilder.tsx`, `MeshDetail.tsx`,
    `store.ts`, `web/types.ts`). Adding a 5th id is mechanical but touches all of these. **[confirmed:
    `grep -rl HarnessId src/`]**

Reference alignment: our effort enum, context-window table, and config-option discovery were
deliberately modeled on **Zed's ACP client** behavior (see `harness-utils.ts` / `usage-compat.ts`
comments). The local `~/projects/zed` checkout contains the ACP protocol/client but **no pi-specific
code** (`grep pi-acp ~/projects/zed` → none); Pi's Zed presence is via the external ACP registry
(`zed.dev/acp/agent/pi`), not the Zed repo. **[confirmed]**

---

## 4. Mapping Pi → the contract

| Contract requirement | Pi via `pi-acp` today | Verdict |
|---|---|---|
| 1. stdio ACP spawn | `pi-acp` spawns `pi --mode rpc`, speaks ACP/JSON-RPC | ✅ **[confirmed]** |
| 2. **consume injected mesh MCP (mailbox)** | **`pi-acp` has no MCP passthrough; Pi has no native MCP** | ❌ **BLOCKER [confirmed]** |
| 3. streaming chunks / tool_call updates | implemented by `pi-acp` | ✅ **[confirmed]** |
| 4. tool use (read/write/edit/bash) | Pi's built-in tools | ✅ **[confirmed]** |
| 5. approvals (request_permission) | not stated by `pi-acp` README | ⚠️ **[not found]** (likely auto-run; risk) |
| 6. resume (loadSession) | Pi has sessions; `pi-acp` "session load/resume" | 🟡 partial **[confirmed adapter claims it; not verified against our `loadSession` capability flag]** |
| 7. cancel / kill | ACP cancel via adapter; process kill is ours | ✅ likely **[inference]** |
| 8. auth (out-of-band) | Pi's own provider auth | ✅ **[confirmed]** |
| 9. advertise model/effort/mode/window | Pi has `--model`/`--thinking`; whether `pi-acp` advertises them as ACP `configOptions` is unknown | ⚠️ **[not found]** (likely empty → degraded pickers/gauge) |
| 10. add-a-harness code surface | ~28 files, mechanical | ✅ feasible **[confirmed]** |

**Can Pi be added natively (ACP direct)?** **No.** Pi speaks its own `--mode rpc`, not ACP. **[confirmed]**

**Can Pi be added via a thin CLI/stdio ACP adapter?** **Mechanically yes** — `pi-acp` *is* that adapter,
and our harness model is built for exactly this. **But it is not functionally usable in a mesh** until
the MCP-passthrough gap (contract #2) is solved, because mail-over-MCP is the entire coordination
mechanism. **[confirmed + inference]**

**Is it unconditionally feasible?** **No.** It is feasible *conditional on* solving MCP for Pi.

---

## 5. Recommendation

**NO-GO as a production harness now. Conditional GO only as a time-boxed spike, behind a flag, not
shipped, gated on first solving the MCP bridge.**

Rationale:
- The mailbox-over-MCP contract (#2) is non-negotiable for a mesh participant, and neither `pi-acp` nor
  Pi satisfies it today. **[confirmed]**
- `pi-acp` is an **unofficial, MVP (v0.0.31), breaking-change-prone** third-party adapter; depending on
  it for a production harness means owning/forking it and tracking upstream churn. **[confirmed]**
- Pi adds **no capability the current four harnesses lack** for mesh work (codex/claude/opencode/kimi
  already cover the ACP+MCP contract). There is no concrete user need on record that only Pi fills.
  **[inference]** — flagged as Open Question 8.1.
- Pi's genuine strengths (minimal context budget, multi-provider/subscription auth, tree sessions) are
  real but don't change the blocker. **[confirmed strengths; inference on relevance]**

**Two ways the MCP gap could be closed (both are real work, listed for the phased plan):**
- **(A) Pi-side MCP bridge.** Write a Pi extension that takes ACP-provided `mcpServers` and exposes their
  tools to Pi's agent loop, and extend/fork `pi-acp` to forward `session/new.mcpServers` into it. This is
  the "correct" path but depends on Pi's extension API and adapter internals. **[inference]**
- **(B) Mesh-tools-as-CLI/skills.** Bypass MCP: expose the mailbox/board/control tools to Pi as
  bash-callable CLI tools or Pi "skills" (Pi's native extension story), pointed at the same per-agent
  endpoint. Avoids MCP entirely but creates a **Pi-specific tool surface** the mesh must maintain in
  parallel to the MCP one. **[inference]**

If the user/prdmgr wants Pi specifically (Open Q 8.1), the spike below de-risks it cheaply before any
production commitment.

---

## 6. Phased plan (only if "go" on the spike)

Throwaway / flagged; not merged to a release. Roughly per-commit, hours not days.

1. **Spike harness, no MCP.** Vendor/pin `pi-acp`; add a `pi` id to the registry + minimal
   effort/install/probe entries (or keep it spike-local). Stand up one Pi agent in a throwaway mesh;
   confirm spawn → `initialize` → `session/new` → streamed prompt round-trip and tool use. Expect: works
   for solo coding, **cannot mail**. (Validates contract 1,3,4,7,8.)
2. **MCP bridge PoC (the crux).** Prototype path (A) or (B): get the mesh `send_mail`/`check_mail` tools
   callable from inside Pi against the injected per-agent endpoint. Validate a real mail round-trip
   (Pi member ↔ another agent). **This is the go/no-go gate** — if it can't be made reliable, stop.
3. **Resume + respawn.** Verify `loadSession` re-attach after a kill, or accept fresh-session degrade;
   confirm process-tree kill leaves no orphan (cf. our codex-acp orphan work).
4. **Advertise + UX.** Map `--model`/`--thinking` to ACP `configOptions` (in the adapter) so model/effort
   pickers + context gauge populate; add Pi to the context-window table; web client harness id plumbing.
5. **Productionize decision.** Only if 1–4 are clean: full ~28-file `HarnessId` addition, install spec
   (`@earendil-works/pi-coding-agent` self-install + the vendored `pi-acp`), docs, tests; decide whether we
   own a fork of `pi-acp` or upstream the MCP bridge.

Realistic estimate: steps 1–2 are the bulk (the MCP bridge is unbounded until prototyped); 3–5 are
mechanical once 2 works. **[inference]**

---

## 7. Risks / gaps

- **MCP passthrough is the hard blocker** (contract #2). Everything else is secondary. **[confirmed]**
- **Third-party-adapter dependency:** `pi-acp` is MVP/unofficial/breaking-prone; multiple competing forks
  (`svkozak`, `victor-software-house`, `nyanshak`) → fragmentation risk and maintenance burden.
  **[confirmed]**
- **No official ACP/MCP commitment from Pi** upstream; the "native" path is `--mode rpc`, which is *not*
  ACP and would mean us writing our own adapter if we don't use `pi-acp`. **[confirmed]**
- **Approvals unverified:** if `pi-acp` doesn't surface `request_permission`, Pi may auto-run bash with
  no human gate — a safety concern for mesh members. **[not found → risk]**
- **Advertise gap:** likely empty model/effort/mode pickers and a fallback context gauge until the
  adapter advertises ACP `configOptions`. Degraded UX, not a blocker. **[inference]**
- **Image input** through `--mode rpc`/`pi-acp` unverified. **[not found]**
- **R2.5 precedent:** mesh-managed binary download for self-install harnesses was rejected
  (`project-r25-binary-registry-rejected`); Pi would be **manual self-install** (`npm i -g
  @earendil-works/pi-coding-agent` + the adapter), consistent with opencode/kimi. **[confirmed, internal]**

---

## 8. Open questions (with recommended answers)

1. **Is there a concrete need only Pi fills?** No need is on record; the four existing harnesses cover the
   contract. *Recommend: do not add Pi until a specific need (a provider/feature/cost angle Pi uniquely
   offers) is named.* **[needs prdmgr/user]**
2. **MCP bridge: path (A) Pi extension vs (B) CLI/skills tool surface?** *Recommend (A)* if we go, because
   it keeps one tool-delivery mechanism (MCP) across all harnesses; *(B)* only if (A) proves infeasible
   against Pi's extension API. **[needs prdmgr]**
3. **Own/fork `pi-acp`, or upstream the MCP bridge?** Forking is faster but a maintenance tax; upstreaming
   depends on the Pi maintainer's stance (no commitment found). *Recommend: spike against a pinned vendor
   copy; decide ownership only at step 5.* **[needs prdmgr]**
4. **Approval policy for a Pi member** (auto-run vs require ACP permission)? Must be settled before any
   non-spike use, given the bash tool. *Recommend: require the ACP permission flow; if `pi-acp` can't, no
   production Pi.* **[needs prdmgr/user]**
5. **Is a time-boxed spike worth it at all right now**, given (1)? *Recommend: defer unless (1) is
   answered yes.* **[needs prdmgr/user]**

---

## 10. Round-2 re-evaluation: Pi's MCP extension (blocker refuted — hands-on validated)

Round 1 concluded NO-GO on one premise: *"`pi-acp` has no MCP passthrough and Pi has no native MCP, so
a Pi agent can't reach the mesh mailbox tools."* The user corrected this. **Both halves of that premise
are wrong in the way that matters: Pi has mature, MCP-consuming extensions, and they speak our exact
transport.** This section supersedes the §1/§5 verdict.

### 10.1 Pi *can* consume MCP servers — via an extension (confirmed + validated)

Pi's minimal core deliberately omits MCP, but its extension system fills it. Multiple community
extensions make Pi an **MCP client** (consume external servers' tools — exactly what we need), not an
MCP server:
- **`pi-mcp-adapter`** (npm `pi-mcp-adapter`, repo `nicobailon/pi-mcp-adapter`) — **v2.10.0, 34 releases,
  ~900★, "mature"**. Transports: **stdio + HTTP (StreamableHTTP with SSE fallback)** + Bearer/OAuth.
  Config precedence includes `~/.config/mcp/mcp.json`, `<pi-agent-dir>/mcp.json`, project `.mcp.json`,
  and `.pi/mcp.json`; standard `mcpServers` shape with a `url` for remote. **Works headless.** Exposes a
  single token-efficient proxy tool `mcp` (the model calls `mcp({server,tool,…})`). **[confirmed: README]**
- **`tickernelz/pi-mcp-tools`** (`pi install npm:@zhafron/pi-mcp-tools`) — auto-detects WebSocket /
  **StreamableHTTP ("newest standard")** / SSE; remote `"type":"remote"` + `url`; has a **direct vs proxy**
  tool-exposure toggle (direct → tools appear as `mcp_<server>_<tool>`). **[confirmed: README]**
- An official MCP-extension example is tracked in the Pi repo (`earendil-works/pi#563`). **[confirmed]**

The MCP a **member** Pi agent must consume is the per-agent **mesh-services** mailbox/board MCP —
`src/mcp/mesh-services.ts` (the `this.mcp` injected at `control-plane.ts:1203`): **Streamable HTTP**
(`WebStandardStreamableHTTPServerTransport`), per-agent URL `**/{agentId}/mcp**`, tools
`send_mail`/`check_mail`/`board_*` (`mesh-services.ts:7,415,54`). It is **stateless, fresh-transport
per request** by design (`mesh-services.ts:405` "must be stateless: a single stateful transport rejects
every initialize after the [first]"). That is exactly the transport `pi-mcp-adapter` supports.
(`src/mcp/mesh-control.ts` is a *separate*, single control MCP for the Mesh **Assistant** lifecycle —
not the member mailbox.) **[confirmed]**

### 10.2 Hands-on validation (done — evidence below)

Goal per dispatch: prove "Pi can consume an MCP server's tool" with a low-risk local test. **Result:
PASS — end-to-end, with a real model turn.**

Setup (fully isolated in a temp `HOME`, real `~/.pi` untouched, all artifacts deleted after):
1. Installed Pi: `npm i -g --prefix <tmp> @earendil-works/pi-coding-agent` → **`pi 0.79.8`** runs. **[confirmed]**
2. Installed the MCP extension: `pi install npm:pi-mcp-adapter` → **`pi-mcp-adapter 2.10.0`** (`pi list`
   shows it). **[confirmed]**
3. Stood up a **minimal Streamable-HTTP MCP server** (same SDK + transport class as the real
   `mesh-services.ts` — and, like it, **fresh transport per request**) exposing one tool `mesh_ping`
   → returns the marker `PONG-MESH-7f3a9`.
   `POST /mcp initialize` → **HTTP 200**. **[confirmed]**
4. Configured `~/.config/mcp/mcp.json` = `{ "mcpServers": { "mesh": { "url": "http://127.0.0.1:<port>/mcp" } } }`.
5. Pi noticed it had a `DEEPSEEK_API_KEY` and Pi lists DeepSeek models, so I ran a **real headless turn**
   (`pi -p --provider deepseek --model deepseek-v4-flash "…call its mesh_ping tool … reply with EXACTLY
   the text the tool returned …"`).

**Evidence:** the turn's entire stdout was **`PONG-MESH-7f3a9`** (exit 0). That marker is unguessable and
exists nowhere but the tool's return value, so DeepSeek (driven by Pi, headless) **must have called the
MCP `mesh_ping` tool over streamable-HTTP and fed its result back into the answer.** A first attempt
**failed at the MCP handshake (HTTP 500)** — but the 500 was *my toy server* reusing a stateless
transport (an SDK constraint), **not** a Pi limitation; even then, Pi's adapter had clearly *reached and
spoken MCP-over-HTTP* to the endpoint. After fixing the server to a per-request transport, the call
succeeded. **[confirmed — I ran this]**

This directly refutes the round-1 blocker: **Pi reaches and uses tools on a streamable-HTTP MCP server
(our exact transport), headless.**

### 10.3 Integration architecture (the key insight)

The ACP adapter's "no MCP passthrough" **doesn't matter**, because **we don't need MCP to flow through
ACP.** Pi loads its MCP extension and reads its *own* `mcp.json`. So:

```
control-plane spawns  pi-acp  (ACP/stdio bridge — start/initialize/session/prompt/stream/cancel)
   └─ pi-acp spawns  pi --mode rpc   (with the pi-mcp-adapter extension installed in pi's config)
        └─ pi-mcp-adapter reads <agent-cwd>/.pi/mcp.json  →  connects to the mesh MCP over HTTP
             └─ mesh tools (send_mail / check_mail / board / control) available to the Pi model
```

The mesh already knows each agent's per-agent MCP URL (`this.mcp.urlFor(a.id)`); instead of relying on
`session/new.mcpServers` (which `pi-acp` ignores), **the mesh writes `<agent-cwd>/.pi/mcp.json` with that
URL** before spawn. Clean, native to Pi, no adapter fork required for the MCP half. **[inference, but
each leg is individually confirmed]**

Two residual wiring nuances (spike-level, not blockers):
- **Proxy vs direct tools.** `pi-mcp-adapter` exposes one `mcp` proxy tool; our mesh briefing tells agents
  to call `send_mail` etc. *directly*. Either (a) adjust the Pi member's briefing to use the `mcp({…})`
  proxy (works — that's literally what my test did), or (b) use `tickernelz/pi-mcp-tools` **direct mode**
  so tools surface as `mcp_mesh_send_mail`. *Recommend deciding in the spike.* **[inference]**
- **Two pi wrappers at once.** `pi-acp` (ACP bridge) and `pi-mcp-adapter` (MCP tools) must coexist inside
  one `pi --mode rpc` process. Plausible (both are standard pi extensions/wrappers) but **not yet
  verified together** — my test drove `pi` directly in print mode, not through `pi-acp`. **[not verified]**

### 10.4 Revised verdict, gate, plan

**CONDITIONAL GO** (revises §5's NO-GO). The MCP question is answered (validated). Remaining risk is
integration wiring + maintenance, which a focused spike resolves.

**First implementation gate (must pass before any productionization):** a real **Pi *member* in a live
mesh** can `send_mail` and `check_mail` through its mesh MCP — i.e. reproduce §10.2 but with (i) the real
**`mesh-services` mailbox MCP URL** (`/{agentId}/mcp`), (ii) driven through `pi-acp` over ACP (not bare
print mode), in a
throwaway 2-agent mesh (Pi member ↔ one existing-harness agent). If that round-trips, the rest is the
mechanical ~28-file harness add.

**Revised phases (spike-first; hours, throwaway/flagged):**
1. **Coexistence + ACP smoke.** Vendor/pin `pi-acp` + `pi-mcp-adapter`; confirm `pi-acp`-spawned
   `pi --mode rpc` loads the MCP extension and a streamed ACP prompt round-trips. (Validates the two
   wrappers coexist — §10.3 residual.)
2. **GATE — mail round-trip.** Mesh writes `<cwd>/.pi/mcp.json` → real mesh MCP; Pi member sends/reads
   mail with another agent. Decide proxy-vs-direct tool surface + the Pi member briefing here. **Go/no-go.**
3. **Resume / respawn / kill / orphans** (cf. codex-acp orphan work); approvals policy (does `pi-acp`
   surface ACP `request_permission`, or does Pi auto-run bash? — round-1 Open Q 8.4 still open).
4. **Advertise + UX:** map `--model`/`--thinking` to ACP `configOptions` (likely an adapter change), add
   Pi to the context-window table, web client harness-id plumbing.
5. **Productionize:** full `HarnessId` addition (~28 files), install spec
   (`@earendil-works/pi-coding-agent` + pinned `pi-acp` + `pi-mcp-adapter`), tests; decide fork/upstream.

**Maintenance burden (real):** we'd pin/track **two** third-party packages — `pi-acp` (still an unofficial
MVP, breaking-change-prone) **and** `pi-mcp-adapter` (mature but third-party). The MCP half is now low-risk
(mature extension, our transport); the ACP-bridge half (`pi-acp`) is the fragile dependency. **[inference]**

### 10.5 What is now confirmed vs still open (round 2)

- **[confirmed, validated]** Pi consumes a streamable-HTTP MCP server's tool, headless (real DeepSeek turn
  returned the tool marker).
- **[confirmed]** Mature MCP-consuming extension exists (`pi-mcp-adapter` v2.10.0) supporting our transport
  and project-local `.pi/mcp.json`; our mesh MCP is streamable-HTTP.
- **[not verified]** `pi-acp` + `pi-mcp-adapter` coexisting in one process; the full ACP-driven path; the
  real `mesh-services` mailbox MCP (vs my toy server); approvals via ACP; model/effort/window advertise through
  `pi-acp`. These are the spike's job (gate = §10.4).
- **[inference]** Net effort is a spike (steps 1–2) then the mechanical harness add; the dependency risk
  shifts from "MCP" (solved) to "owning the `pi-acp` ACP bridge".

---

## 9. Sources

External (web):
- Pi repo: https://github.com/earendil-works/pi (mirror https://github.com/badlogic/pi-mono)
- Pi coding-agent README: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md
- Pi usage docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md
- npm `@earendil-works/pi-coding-agent` (current): https://www.npmjs.com/package/@earendil-works/pi-coding-agent
- npm `@mariozechner/pi-coding-agent` (older/historical name only): https://www.npmjs.com/package/@mariozechner/pi-coding-agent
- Mario Zechner write-up: https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
- ACP-in-Pi discussion: https://github.com/earendil-works/pi/discussions/4444
- `pi-acp` adapter (npm): https://www.npmjs.com/package/pi-acp
- `pi-acp` repo (svkozak): https://github.com/svkozak/pi-acp
- `pi-acp` fork docs (nyanshak): https://github.com/nyanshak/pi-extensions/blob/main/pi-acp/README.md
- Pi on Zed's ACP registry: https://zed.dev/acp/agent/pi
- ACP overview (LangChain docs): https://docs.langchain.com/oss/python/deepagents/acp

Round-2 (MCP extension) external:
- `pi-mcp-adapter` repo (nicobailon): https://github.com/nicobailon/pi-mcp-adapter — npm https://www.npmjs.com/package/pi-mcp-adapter
- `pi-mcp-tools` repo (tickernelz): https://github.com/tickernelz/pi-mcp-tools
- Pi official MCP-extension example issue: https://github.com/earendil-works/pi/issues/563
- `@spences10/pi-mcp` (composable pi+MCP): https://github.com/spences10/my-pi
- `pi-shell-acp` (ACP bridge w/ MCP config): https://github.com/junghan0611/pi-shell-acp

Round-2 hands-on validation (ran locally, isolated temp HOME, artifacts deleted):
- Installed `@earendil-works/pi-coding-agent@0.79.8` + `pi-mcp-adapter@2.10.0`; stood up a minimal
  streamable-HTTP MCP server (`@modelcontextprotocol/sdk` `WebStandardStreamableHTTPServerTransport`,
  per-request transport) exposing `mesh_ping`; configured `~/.config/mcp/mcp.json` with its `url`; ran
  `pi -p --provider deepseek --model deepseek-v4-flash` → output was exactly the tool marker
  `PONG-MESH-7f3a9` (exit 0). Confirms Pi calls a streamable-HTTP MCP tool headlessly.

Round-2 internal:
- `src/mcp/mesh-services.ts:7,405,415,54` (member mailbox/board MCP = stateless per-request
  `WebStandardStreamableHTTPServerTransport`, per-agent `/{agentId}/mcp`, `send_mail`/`check_mail`/`board_*`, `urlFor`)
- `src/control-plane.ts:207,1061,1203` (`this.mcp` = `MeshServicesServer`; injected URL `this.mcp.urlFor(a.id)`)
- `src/mcp/mesh-control.ts` (separate Mesh **Assistant** control MCP — not the member mailbox)

Internal (code paths read):
- `src/harness.ts` (registry + `spawnConfigFor`)
- `src/acp/types.ts` (`HarnessId`, `MeshEvent`, capabilities)
- `src/acp/client.ts` (`start/initialize/newSession/loadSession/prompt/cancel/kill`, clientHandlers:
  sessionUpdate/requestPermission/read+writeTextFile/extNotification)
- `src/control-plane.ts:1203,1213,1222` (injected mesh MCP per agent; newSession/loadSession)
- `src/mesh-assistant.ts:96` (mesh-control MCP injected at session/new)
- `src/harness-utils.ts` (`HARNESS_EFFORT_CAPABILITIES`, runtime effort discovery)
- `src/harness-models.ts` (model probe via session `configOptions`/`availableModels`)
- `src/harness-install-spec.ts` (npm + self-install specs)
- `src/acp/usage-compat.ts` (referenced: `resolveContextWindow` window-table normalization)
- `~/projects/zed` (ACP client reference; no pi-specific code present)
