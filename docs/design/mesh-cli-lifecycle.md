# mesh-cli-lifecycle — single-mesh CLI control via the running control plane

Status: **spec / checkpoint-1 (no functional code yet)** · branch `task/mesh-cli-lifecycle` · base `82253f4`

Goal: add CLI control of **one mesh** — `start` / `stop` / `restart` / `status` — routed through the
**running control-plane API**, reclaiming `mesh start` / `mesh stop` for single-mesh use while keeping
`mesh up` / `mesh down` for the control plane itself. `mesh kill <name>` stays a force-kill.

## What was read (evidence)

- `src/cli-dispatch.ts` — `KNOWN_COMMANDS` already includes `start`/`stop`/`restart`/`status`; today
  `start`/`stop` are **aliases** for `up`/`down` (comment L22). The resolver yields
  `{command, globals, commandTail}` and keeps unknown tail flags **verbatim** — so `mesh start <name>
  --fresh` arrives as `command="start"`, `commandTail=["<name>","--fresh"]` (`--fresh` is not a global,
  L95-96). No resolver change is needed for the new arity — only `main.ts` dispatch + usage text.
- `src/main.ts` — dispatch maps `up|start → service.up`, `down|stop → service.down`,
  `status → service.status`, `restart → service.restart`, `kill <name> → MeshManager.kill` (a local
  signal to the daemon, **not** via the backend). This is what we re-wire.
- `src/web/api.ts` — the endpoints we need **already exist**:
  - `POST /api/meshes/:name/start` → `gw.startMesh(name, opts)`; `body.sessionStrategy==="fresh"` →
    `{sessionStrategy:"fresh"}` (L327-330) → maps **directly** to `--fresh`.
  - `POST /api/meshes/:name/stop` → `gw.stopMesh(name)` (L332-335) — the **graceful** stop.
  - `GET /api/meshes` → `gw.snapshot().meshes` (`MeshSummary[]`, each with `status`) — for `status <name>`.
  - All non-device `/api/*` is gated (see auth below).
- `src/web/auth.ts` — `authorizeRequest()` reads `devices.json` **fresh on every request**
  (`readDevices(root)`, L107) — **no cache, no watcher**. An approved-device write is therefore visible
  to the **next** request with no reload delay. Only path to pass the gate is an **approved device
  token** (loopback is explicitly NOT trusted — funnel makes remote look loopback). Pre-auth paths:
  only `/api/auth/device/{start,status,verify,bootstrap}`.
- `src/auth-store.ts` — tokens are stored as `sha256:` **hashes only**; `DeviceRecord` =
  `{label?, status:"approved"|"revoked", tokenHash, createdAt, approvedAt?, lastSeenAt?}` — **no
  `expiresAt`, no `scope`** (only `pending`/`bootstrap` carry `expiresAt`). `updateDevices(root, mutator)`
  is a **cross-process-locked** read-modify-write. `findApprovedDeviceId` verifies via constant-time hash.
- `src/auth-codes.ts` — `generateToken()` (raw, returned once), `hashToken()` (`sha256:…`),
  `verifyTokenHash()`, `withFileLock`, `authDir`. `src/auth-cli.ts` mints/approves devices via the same
  `updateDevices` pattern (`f.devices[id] = {status:"approved", tokenHash, …}`).
- `src/service.ts` — backend lives at `127.0.0.1:<port>` (default **10010**), recorded in
  `<root>/backend.json {pid,port,startedAt}`. `healthy(port)` probes `GET /api/state` and treats any
  `<500` (incl. 401) as alive. `backendStatus(root,port)` returns `{recordPresent, pid, port, healthy}`.

### Lead's hypothesis A — verified

- **CLI cannot reuse an existing raw token** — confirmed: only hashes are persisted; no raw token is
  recoverable. The **bootstrap** token is also hash-only + single-use + printed to the host log, so the
  CLI can't reuse it either.
- **Mint-an-ephemeral-approved-token is the right approach**, and — crucially — there is **no
  watcher/reload race**: the gate reads `devices.json` fresh per request, so a freshly written approved
  device works on the very next call.
- This is **no privilege escalation**: the CLI already has filesystem/root access and can write
  `devices.json` directly (it *is* the approver). The ephemeral token is merely how it speaks HTTP to a
  backend that only accepts tokens.

## A. CLI → API auth design (recommended)

`withEphemeralCliToken(root, async (token) => { … })` — a small helper:

1. **Pre-flight**: `backendStatus(root, port).healthy`? If **down**, do NOT mint — print
   *“control plane not running — run `mesh up`”* and exit **5** (see §C). This avoids token churn when
   there's nothing to talk to.
2. **Mint**: `const token = generateToken()`; under one `updateDevices` lock, write
   `f.devices["dv_cli_<uuid>"] = { label:"cli", status:"approved", tokenHash: hashToken(token),
   createdAt: now, approvedAt: now }`. In the **same** mutator, **GC abandoned siblings**: delete any
   `label:"cli"` device whose `createdAt` is older than **60 s** (crash-leftovers from a previous run;
   a stale entry is a hash with **no known preimage**, so not a usable credential — just clutter).
3. **Use**: call `http://127.0.0.1:<port>/api/…` with `Authorization: Bearer <token>`. Valid
   immediately (fresh read per request) — **no retry-for-reload needed**.
4. **Cleanup** (`finally`): `updateDevices(root, f => { delete f.devices[id] })`. Always runs, even on
   throw, so the normal path leaves nothing behind.

**Schema**: **no change required**. Expiry is unnecessary because (a) the token is deleted in `finally`
and (b) abandoned siblings are age-GC'd on the next mint, and (c) the raw token dies with the process so
a leftover hash isn't exploitable. `scope` is unnecessary (CLI already has full local authority).

**Optional hardening (only if the lead wants belt-and-suspenders)** — the *smallest safe extension*:
add `expiresAt?: string` to `DeviceRecord`; have `findApprovedDeviceId`/`authorizeRequest` treat an
expired approved device as **denied** (fail-closed, mirrors `pending` GC). That gives the ephemeral
token a hard TTL even across a CLI crash. Recommendation: **defer** — delete-in-`finally` + age-GC is
enough; revisit only if we later want long-lived scoped CLI tokens.

**Race/retry**:
- `updateDevices` is cross-process locked → mint/cleanup never clobber a concurrent backend write
  (e.g. a real `mesh device approve`).
- No reload race (fresh per-request read).
- Concurrent CLI invocations each mint a **unique** id and delete only their own; the 60 s age-GC
  threshold is far longer than any single command, so it never reaps another in-flight CLI's token.
- Backend transiently unreachable mid-command → surface as backend-down (exit 5); we do not silently
  retry indefinitely.

## B. Final command table

| Command | Target | Mechanism | Notes |
|---|---|---|---|
| `mesh up` | control plane | `service.up` | unchanged (no longer also `start`) |
| `mesh down` | control plane | `service.down` | unchanged (no longer also `stop`) |
| `mesh restart` *(no name)* | control plane | `service.restart` | arity: no positional |
| `mesh status` *(no name)* | control plane | `service.status` | arity: no positional |
| `mesh run` / `logs` / `ps` / `doctor` / `channels` / `device` / `auth` | — | unchanged | |
| **`mesh start <name> [--fresh]`** | one mesh | API `POST /meshes/:name/start` | `--fresh`→`{sessionStrategy:"fresh"}`; **name required** |
| **`mesh stop <name>`** | one mesh | API `POST /meshes/:name/stop` | graceful; **name required** |
| **`mesh restart <name>`** | one mesh | API stop → start sequence | see §D |
| **`mesh status <name>`** | one mesh | API `GET /meshes` → find name | prints status + agents |
| `mesh kill <name> \| --all` | one/all meshes | `MeshManager.kill` (local signal) | **unchanged** force-kill, no API/backend |

**Reclaim**: `start`/`stop` no longer alias `up`/`down`. **Arity overload**: `restart`/`status` with a
positional name → single mesh; without → control plane. `start`/`stop` are **single-mesh only** — with
**no** name they error (exit 2) with *“use `mesh up`/`mesh down` for the control plane.”*

`kill` deliberately stays out-of-band (a force signal to the daemon pid is safe without the owner);
graceful `stop`/`start`/`restart`/`status` go **through the API** so the backend's gateway stays the
single authority and the WebUI sees the same state (per user decision 3).

## C. UX / exit codes

| Condition | Exit | Message (stderr unless noted) |
|---|---|---|
| success (incl. idempotent no-op) | **0** | e.g. `mesh "x" started` / `already running` (stdout) |
| usage error (bad/missing args) | **2** | usage line (matches existing convention) |
| mesh not found | **4** | `no such mesh "x"` |
| control plane down | **5** | `control plane not running — run \`mesh up\`` |
| auth failure (defensive; minted token rejected) | **6** | `authorization failed` |
| other API / runtime failure (5xx, network mid-call) | **1** | server message |

**Idempotency (recommended)**: `start` on an already-running mesh and `stop` on an already-stopped mesh
→ **exit 0** with an informational line (script-friendly). Only adopt a distinct “state conflict” code
if the lead prefers strictness. `start <name> --fresh` on a running mesh → defer to the API’s behavior
(today `startMesh` is the authority); the impl phase will confirm whether it restarts-fresh or no-ops
and we surface that verbatim.

## D. `restart <name>` & `status <name>` semantics

- **`restart <name>`**: **CLI-orchestrated sequence** — `POST …/stop`, then **poll** `GET /api/meshes`
  until the mesh's `status` is `stopped`/`dead` (bounded, e.g. ≤10 s), then `POST …/start`. No new
  endpoint. *Implementation gate*: verify `gw.stopMesh` settles teardown before the poll clears; if it
  returns before the daemon is fully down, fall back to a narrow `POST /api/meshes/:name/restart`
  (gateway-side stop→start with correct awaiting). Recommend the sequence; keep the endpoint as the
  documented fallback.
- **`status <name>`**: `GET /api/meshes` (lighter than full `/api/state`), `find(m => m.name===name)`.
  Absent → exit 4. Present → print `status` (`stopped|starting|running|dead`) + a compact agent roster
  (`id · harness · status`). Read-only.

## API calls / new endpoints

- **No new endpoints required** for `start` / `stop` / `status`. `restart` uses the existing two plus a
  status poll. A `POST /meshes/:name/restart` is the **only** possible addition and only if the stop/start
  sequence proves racy.

## cli-dispatch changes

- `cli-dispatch.ts`: **usage text + the `start`/`stop` comment** only (the resolver already routes these
  commands and preserves the tail; arity is decided in `main.ts`). Update `usageLines()` to document the
  single-mesh forms and the up/down-vs-start/stop split.
- `main.ts`: re-wire `start`/`stop` to single-mesh; add name-arity branching for `restart`/`status`;
  emit the backend-down hint; thread `--fresh` from the tail.

## New modules

- `src/cli-token.ts` — `withEphemeralCliToken(root, port, fn)` (mint/GC/use/cleanup, §A).
- `src/mesh-control-client.ts` — authenticated client to `127.0.0.1:<port>`:
  `meshControl(port, token, method, path, body) → {status, body}` + typed `startMesh/stopMesh/
  meshSummaries`, classifying `ECONNREFUSED`→down, `401`→auth, `404`→not-found.

## Implementation phases (per-commit STOP)

- **C1 — auth helper**: `cli-token.ts` + unit tests (mint→approved present→cleanup deletes; cleanup on
  throw; 60 s age-GC; unique-id concurrency; backend-down pre-flight skips minting). No dispatch change.
- **C2 — client + dispatch**: `mesh-control-client.ts` + `main.ts` re-wire (reclaim start/stop, arity for
  restart/status, `--fresh`, backend-down/exit-code mapping) + `cli-dispatch.ts` usage. Tests:
  cli-dispatch arity/tail (`start <name> --fresh`, `restart`/`status` with & without name); client unit
  tests (request shape + bearer header; ECONNREFUSED→5, 401→6, 404→4) with mocked fetch.
- **C3 — lifecycle e2e + docs**: real backend in `--fake` mode under a temp root; define a mesh; drive
  `mesh start/stop/restart/status` and `start --fresh` via the CLI; assert transitions via the API
  snapshot; assert backend-down path (no backend → exit 5) and `start`/`stop` without a name → exit 2.
  Finalize this doc’s “as-built” notes.

## Tests summary

- **cli-dispatch unit**: new arity/tail cases above (alongside the existing resolver tests).
- **cli-token unit**: mint/cleanup/GC/concurrency/pre-flight.
- **mesh-control-client unit**: request/headers + error classification (mocked fetch).
- **lifecycle e2e**: full start→status→stop→restart→start-fresh against a live `--fake` backend, plus
  the backend-down and missing-name failure paths.

## Open decisions for the lead

1. **Idempotent no-ops → exit 0** (recommended) vs a distinct “state conflict” code?
2. **`restart` as a CLI sequence** (recommended, no new endpoint) vs add `POST /meshes/:name/restart`?
3. **Schema**: keep `DeviceRecord` unchanged (recommended) vs add optional `expiresAt` now for a hard
   ephemeral-token TTL?
4. Exit-code numbers (4/5/6) — acceptable, or align to an existing convention you prefer?
