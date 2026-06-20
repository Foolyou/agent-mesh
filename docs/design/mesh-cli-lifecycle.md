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

## A. CLI → API auth design — two approaches compared (prdmgr clarification)

**Invariant for BOTH approaches** (non-negotiable): device-auth stays mandatory for every request.
Neither approach is a loopback/bind/env trust fallback — the funnel makes remote traffic look loopback,
so a socket address is never an authorization signal. The CLI's authority is *“I can read the host's
`<root>/auth/` key material”* (filesystem/root), and it must **prove** that cryptographically.

### Approach 1 — per-command CLI device token

`withEphemeralCliToken(root, port, async (token) => { … })`:
1. **Pre-flight**: `backendStatus(root, port).healthy`? If down, don't mint → print *“run `mesh up`”*,
   exit 5.
2. **Mint**: `generateToken()`; under one `updateDevices` lock write
   `f.devices["dv_cli_<uuid>"] = { label:"cli", status:"approved", tokenHash: hashToken(token), … }`;
   in the same mutator age-GC any `label:"cli"` device older than 60 s (crash leftovers).
3. **Use**: API call with `Authorization: Bearer <token>` — valid on the next request (the gate reads
   `devices.json` fresh per request; **there is no watcher/cache**, so the “watcher reload/retry”
   concern simply does not exist in this codebase).
4. **Cleanup** (`finally`): `updateDevices(root, f => delete f.devices[id])`.

Reuses the **existing** verification path (`findApprovedDeviceId`) and **existing** endpoints → zero
change to the security-critical auth code.

**Downsides (per the lead's checklist):**
- **Device-list pollution / stale leftovers**: a crash between mint and cleanup leaves an approved
  `cli` device in `devices.json` (visible in `mesh device list`). Mitigated by `finally` + 60 s age-GC,
  but the window exists; a leftover is a hash with no known preimage (not exploitable, just clutter).
- **Watcher reload/retry**: **N/A here** — fresh per-request read, no cache. (Listed for completeness;
  this downside would only apply if the gate cached the store.)
- **TTL/cleanup**: `DeviceRecord` has no `expiresAt`; hygiene relies on delete-in-`finally` + age-GC.
- **Full scope**: while alive the token is a **full** device credential (any `/api/*`), not scoped to
  lifecycle — a broader blast radius than necessary.
- **Write amplification / lock contention**: two locked `devices.json` writes per command, contending
  with real `mesh device approve`/`revoke`.

### Approach 2 — host-key-derived short-lived **scoped** bearer (HMAC) — RECOMMENDED

The key store already exists: `<root>/auth/keys.json` holds 32-byte **symmetric** AES-256 keys
(`active` kid + retained kids; `auth-codes.ts`). Possession of that key *is* host authority. So the CLI
proves possession with a **MAC** (symmetric → HMAC-SHA256, not an asymmetric signature) over short-TTL,
**scoped** claims; the backend re-derives the same MAC from its own copy of `keys.json` and verifies.
No device registration, no store writes, no cleanup, no leftovers, nothing to reload.

**Don't reuse the GCM key directly for a second primitive** — derive a distinct sub-key (cheap, clean):
```
cliKey = HKDF-SHA256(ikm = keyBytes(kid), salt = "", info = "mesh-cli-lifecycle-bearer-v1", len = 32)
```
(`crypto.hkdfSync`; `keyBytes(kid)` is the same base64-decoded 32-byte secret `auth-codes` uses.)

**Bearer format** (namespaced so it can never collide with a device token, which is bare base64url):
```
mhk1.<b64url(claims)>.<b64url(mac)>
claims = { v:1, kid, iat, exp, scope:"mesh.lifecycle", aud:"mesh-control-plane", nonce }   // epoch secs
mac    = HMAC-SHA256(cliKey, "mhk1." + b64url(claims))
```
TTL short (e.g. **exp = iat + 60 s**). The CLI calls `ensureKeys(root)` first (idempotent, locked) so a
cold store has a `k1` to sign with; the backend verifies via `loadKeys(root)`.

**Verification — the minimal secure extension to the gate** (`src/web/auth.ts`):
- Add a host-key branch to `authorizeRequest` that fires **only** when the token has the `mhk1.` prefix
  (device tokens never do). Steps, each failure collapsing to a generic deny:
  1. split into 3 parts; parse `claims`; reject unknown `v`/`aud`/`scope`.
  2. `keyBytes(claims.kid)` from `loadKeys(root)` (unknown/rotated-out kid → deny). `kid`-in-claims means
     a token signed before a key rotation still verifies while that kid is retained.
  3. derive `cliKey` (HKDF); recompute the MAC over `"mhk1." + b64url(claims)`; **`timingSafeEqual`**.
  4. `now < exp` (and `iat ≤ now + small_skew`).
- Make the gate **scope-aware**: `authorizeRequest` additionally receives `(method, path)` (server.ts
  already has them). A host-key bearer authorizes **only** the lifecycle whitelist; anything else → deny:
  | method | path | use |
  |---|---|---|
  | POST | `/api/meshes/:name/start` | start / restart |
  | POST | `/api/meshes/:name/stop` | stop / restart |
  | GET | `/api/meshes` | status / restart poll |
  - `/ws` and every other `/api/*` route reject a host-key bearer outright (only an approved **device**
    token reaches the full API + websocket). This keeps the new accept-path strictly least-privilege.
- `AuthGateResult.via` gains `"host-key"` for the secret-free `[auth]` log line.

**Replay**: the 60 s TTL bounds any replay, and the bearer is only ever sent over loopback to the very
host that holds the key (a party who can already do anything). Strict single-use is therefore optional;
if wanted, an in-memory, TTL-bounded `nonce`-seen set in the backend rejects a repeat within the window
(no persistence needed). Recommendation: **TTL-only** to start, nonce-cache as a later toggle.

### Security analysis & recommendation → **Approach 2**

| dimension | Approach 1 (device token) | Approach 2 (host-key HMAC) |
|---|---|---|
| auth-path change | **none** (reuses `findApprovedDeviceId`) | adds one verify branch + scope check (new, security-sensitive) |
| privilege | **full** `/api/*` for the token's life | **scoped** to 3 lifecycle routes only |
| store writes | 2 locked writes/command | **none** (stateless verify) |
| pollution / leftovers | possible (crash window; age-GC'd) | **none** |
| TTL | none on record (relies on cleanup) | **cryptographic**, in signed claims |
| lock contention w/ backend | yes (devices.json) | none |
| trust model | a standing (brief) credential | **proof of key possession**, no standing credential |

**Decision: Approach 2 (approved by prdmgr/user).** It is *safer* — least-privilege (a lifecycle CLI never holds a full-API
credential), stateless (no `devices.json` pollution, cleanup races, or lock contention), and a hard
cryptographic TTL — and it expresses the actual trust model (host-key possession) instead of fabricating
a transient standing credential. Its one cost, a new accept-path in the gate, is **bounded and
testable**: verification is a self-contained pure function (prefix → kid → HKDF → HMAC →
`timingSafeEqual` → exp/scope/aud), unit-testable with adversarial vectors (tampered claims, wrong/
rotated-out kid, expired, wrong scope/aud, truncated MAC, off-whitelist path), and it never weakens
device-auth — it is an **additional, narrower** path, not a bypass, with no loopback/env exception.

**Rejected alternative (Approach 1)**: the per-command device token works and is the absolute-minimal
diff (zero auth-path change), but it was rejected for the full-scope ephemeral credential + `devices.json`
store churn/pollution it entails. Recorded here only as the considered-and-dropped option.

**Schema**: Approach 2 needs **no change to `devices.json`**; it reuses `keys.json` as-is (plus the HKDF
sub-key derivation, which adds no stored field). Approach 1 also needs no schema change (see its TTL
note). So the `DeviceRecord.expiresAt` question only matters if we instead want long-lived scoped CLI
tokens — not needed by either approach here.

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

## New modules (Approach 2)

- `src/cli-host-bearer.ts` — `signHostBearer(root, {scope, ttlSeconds})` → the `mhk1.…` bearer
  (`ensureKeys` → HKDF sub-key → HMAC); plus the pure `verifyHostBearer(keys, token, {method, path,
  now})` used by the gate, so signer and verifier share one canonicalization.
- `src/web/auth.ts` (extend) — host-key branch in `authorizeRequest` + the lifecycle scope whitelist;
  `via:"host-key"`.
- `src/mesh-control-client.ts` — authenticated client to `127.0.0.1:<port>`:
  `meshControl(port, bearer, method, path, body) → {status, body}` + typed `startMesh/stopMesh/
  meshSummaries`, classifying `ECONNREFUSED`→down, `401/403`→auth, `404`→not-found.

## Implementation phases (per-commit STOP)

- **C1 — host-bearer crypto + gate verify (the security core, adversarially tested FIRST)**:
  `cli-host-bearer.ts` (sign + pure verify) and the `authorizeRequest` host-key branch + scope
  whitelist. Unit tests with adversarial vectors: valid bearer authorizes a whitelist route; tampered
  claims / wrong or rotated-out `kid` / expired / wrong `scope`/`aud` / truncated MAC / off-whitelist
  path / `/ws` → **deny**; a device token still authorizes the full API unchanged; no loopback/env
  bypass. No dispatch change yet.
- **C2 — client + dispatch**: `mesh-control-client.ts` + `main.ts` re-wire (reclaim start/stop, arity for
  restart/status, `--fresh`, backend-down/exit-code mapping) + `cli-dispatch.ts` usage. Tests:
  cli-dispatch arity/tail (`start <name> --fresh`, `restart`/`status` with & without name); client unit
  tests (request shape + bearer header; ECONNREFUSED→5, 401/403→6, 404→4) with mocked fetch.
- **C3 — lifecycle e2e + docs**: real backend in `--fake` mode under a temp root; define a mesh; drive
  `mesh start/stop/restart/status` and `start --fresh` via the CLI (signing a real host bearer against
  the temp root's `keys.json`); assert transitions via the API snapshot; assert backend-down → exit 5,
  `start`/`stop` without a name → exit 2, and that an off-whitelist route with a host bearer is rejected.
  Finalize this doc's “as-built” notes.

## Tests summary (as-built)

- **host-bearer unit** (`cli-host-bearer.test.ts`): round-trip + rotation-survives; adversarial
  rejections — tampered claims / forged mac / truncated mac / expired / wrong scope / wrong aud /
  unknown-or-rotated-out kid / future iat / malformed / absent keystore.
- **auth gate unit** (`web/auth.test.ts`): host bearer authorizes only the lifecycle whitelist; denied
  on `/ws` and every other `/api` route; expired/tampered denied; device-token path still full API + ws.
- **mesh-control-client unit**: request shape + real host-bearer header + HTTP→error classification
  (stubbed fetch).
- **mesh-cli-ops unit**: every branch + idempotent no-ops + the restart stop→poll→start sequence/timeout
  (fake client).
- **cli-dispatch unit**: arity/tail (`start <name> --fresh`, `restart`/`status` with & without a name,
  global-flag peel).
- **lifecycle e2e** (`mesh-cli-lifecycle.e2e.test.ts`): full status→start→restart→stop→start-fresh
  against a live `--fake` control plane through the real host-key auth path, plus backend-down (exit 5),
  missing-name (exit 2), missing-mesh (exit 4), and no-arg `status` staying control-plane.

## As-built (landed C1–C3)

Implemented exactly as specified above (Approach 2, approved decisions). Commits on
`task/mesh-cli-lifecycle`:

- **C1 `6989f2f`** — host-key bearer crypto + gate verify. `src/cli-host-bearer.ts`
  (`signHostBearer` / pure `verifyHostBearer`, HKDF sub-key, `mhk1.<claims>.<mac>`, 60s TTL); host-key
  branch + `isLifecycleRoute` whitelist in `src/web/auth.ts`; `route`/`method`/`path` threaded through
  `server.ts` + `api-server.ts`. Adversarial tests in `cli-host-bearer.test.ts` + `web/auth.test.ts`.
- **C2 `e9c5bef`** — `src/mesh-control-client.ts` (signed transport + error classification),
  `src/mesh-cli-ops.ts` (idempotency + restart stop→poll→start + exit-code mapping), `main.ts` dispatch
  re-wire (reclaim start/stop, restart/status arity, `--fresh`, missing-name → exit 2),
  `cli-dispatch.ts` usage. Unit tests for ops/client/dispatch.
- **C3** — `src/mesh-cli-lifecycle.e2e.test.ts`: spawns a real `mesh run --fake` control plane under a
  temp root and drives the actual binary through the real host-key auth path.

Notes / minor deviations:
- The e2e exercises `start <name> --fresh` from a STOPPED mesh: the `--fake` `startMesh` throws on an
  already-running mesh (it ignores `sessionStrategy`), so `--fresh` on a running fake mesh would surface
  the API error (exit 1). The real backend decides fresh-restart semantics; the `{sessionStrategy:
  "fresh"}` wire shape is asserted in the client unit test.
- No-arg `restart` is left to the cli-dispatch arity unit tests (running it would restart the shared
  test control plane); no-arg `status` (read-only) is exercised live in the e2e.

## Decisions (all approved — prdmgr/user)

1. **Auth**: Approach 2 — host-key HKDF→HMAC scoped bearer (`mhk1.<claims>.<mac>`, TTL 60s,
   scope=`mesh.lifecycle`, aud=`mesh-control-plane`, lifecycle-3-route whitelist; `/ws` + other API
   denied; device-auth unchanged).
2. **Idempotent no-ops → exit 0** (start-on-running / stop-on-stopped).
3. **`restart`** = CLI stop→poll→start sequence; **no new endpoint**.
4. **Replay**: TTL-only (60s); no nonce-seen cache.
5. **Exit codes**: 4 not-found, 5 control-plane-down (+`mesh up` hint), 6 auth, 2 usage, 1 other, 0 ok.
6. **No `devices.json`/`DeviceRecord` schema change** (the host-key path reuses `keys.json` only).
