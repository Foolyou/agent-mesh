# Device / Account Authorization — Design

Status: design only (no implementation in this change). Branch `task/device-auth-design`.
Scope: WebUI device authorization, Feishu dynamic per-`(channel, open_id)` authorization, and
forwarding authorized Feishu **p2p** private chats to the central **Mesh Assistant**.

This document is the spec the implementation tasks will follow. Where a tradeoff is genuinely open
it is listed under **Open questions** with a recommended option rather than silently decided.

> **⚠️ Phase 6 supersession (2026-06-20).** Open Q 6A (below) was validated in production and
> answered **yes**: with the Tailscale funnel, *all* remote traffic reaches the WSL service as a
> **loopback** socket, so loopback is **not** a trustworthy origin. Phase 6 therefore **removed
> loopback trust entirely**. The mandatory behavior is now:
> - An **approved device token is the only allow path** for every gated `/api/*` request and the
>   `/ws` upgrade — including local development on the host (no loopback shortcut).
> - The socket remote address is **diagnostic only** (gate logs / coarse origin class); it never
>   grants access.
> - There is **no env var or flag** that re-enables loopback trust or otherwise bypasses the token.
>
> Wherever the sections below describe "loopback is implicitly trusted" / "the gate is skipped for
> `127.0.0.1`/`::1`", read that as **historical design intent, superseded by Phase 6**. The current
> operator runbook is [`docs/device-auth-operations.md`](../device-auth-operations.md).

---

## 0. Goals & pinned decisions

Three features:

- **A. WebUI device authorization.** Opening the web app verifies the device. An unauthorized device
  shows a **device code** and polls; the host operator authorizes it from the host CLI; afterwards the
  device's token lets it straight into the app.
- **B. Feishu dynamic authorization.** An unauthorized Feishu user gets a bot reply containing an
  **authorization code** that encodes `(channel, open_id, appId)`, anti-forgery. The host operator
  decodes "who, from which channel" and approves on the host CLI. This replaces today's **static**
  `allowSenders` whitelist with a **dynamic registry** at `(channel, open_id)` granularity.
- **C. p2p forwarding.** An authorized user's Feishu **p2p** message is forwarded to the central
  **Mesh Assistant** (`src/mesh-assistant.ts`, the create/manage-meshes controller). **Group** messages
  keep their current `chatId → mesh` binding behavior unchanged.

Pinned decisions (must hold):

1. "Console / backend" = the mesh **host CLI**. New commands look like
   `mesh device approve <code>` / `mesh channels feishu approve <code>`.
2. WebUI device identity: the **server issues a device token** stored in the browser locally; an
   unauthorized device only shows a device code + polls; after CLI approval the token enters the
   allowlist.
3. There **must** be a bootstrap / first-device path so a cold start can never lock everyone out.

### Trust model (the anchor for every decision below)

The host operator is the root of trust: anyone who can run `mesh …` on the host already controls the
backend (it spawns agents, reads `channels/feishu.json`, etc.). Today the web server binds loopback
(`127.0.0.1`) by default and only does a CSRF same-origin check (`src/web/api.ts` `sameOriginCheck`,
~L418); there is **no** authentication. Device auth becomes meaningful precisely when the operator
exposes the server beyond loopback (Tailscale funnel, `--host`, etc. — see
[[reference-prod-tailscale-topology]]). So:

- **Loopback requests are implicitly trusted** (the operator's own machine). This is the existing
  model and the bootstrap anchor (§6).
- **Non-loopback requests require an approved device token.**

> **Superseded by Phase 6:** loopback is no longer trusted. Funnel traffic appears as loopback, so
> the only allow path is an approved device token — for *every* request, loopback included. The
> remote address is diagnostic only. See the Phase 6 banner at the top.

---

## 1. Authorization state: storage & schema

### 1.1 Where it lives

A single new store directory `<root>/auth/` (root resolved by `src/root.ts` `resolveRoot()`), alongside
`channels/`, `boards/`, `run/`, `uploads/`. Two files, both user-owned `0600`, dir `0700` (mirrors
`board-store.ts` L89–92 / `session-storage.ts`):

- `<root>/auth/devices.json` — WebUI device tokens (allowlist + pending).
- `<root>/auth/feishu.json` — Feishu `(channel, open_id)` allowlist + pending registrations.

A third file holds the auth-code encryption key (§2): `<root>/auth/keys.json` (`0600`).

Rationale for **file-backed** (not in-memory only): it matches the existing `channels/feishu.json`
hot-reload pattern and the boards/sessions persistence, and — critically — it lets the **CLI process**
(separate from the running backend) and the **backend** share state without a new IPC channel (§3.1).

### 1.2 Schemas

`devices.json`:

```jsonc
{
  "version": 1,
  "devices": {
    // keyed by deviceId (server-generated, opaque)
    "dv_8f3…": {
      "label": "chrome-macbook",       // optional, operator-set on approve or client-hinted
      "status": "approved",            // "approved" | "revoked"
      "tokenHash": "sha256:…",         // hash of the bearer token; raw token never stored
      "createdAt": "2026-…Z",
      "approvedAt": "2026-…Z",
      "lastSeenAt": "2026-…Z"
    }
  },
  "pending": {
    // keyed by the short device CODE shown in the UI (e.g. "K7Q-3F9")
    "K7Q-3F9": {
      "deviceId": "dv_8f3…",
      "tokenHash": "sha256:…",         // token already issued, dormant until approved
      "userAgentClass": "desktop",     // coarse, non-PII hint for the operator; never raw UA
      "remoteHint": "tailscale",       // coarse origin class for the operator
      "createdAt": "2026-…Z",
      "expiresAt": "2026-…Z"           // pending codes expire (e.g. 10 min)
    }
  }
}
```

`feishu.json` (auth registry — distinct from `channels/feishu.json` config):

```jsonc
{
  "version": 1,
  "allow": {
    // key = base64url(JSON.stringify([channelKey, openId])) -- text-safe (no raw delimiter)
    "<b64url([channelKey, openId])>": {
      "channelKey": "feishu:cli_abc",  // see §1.4 for what channelKey is
      "openId": "ou_123",
      "status": "approved",            // "approved" | "revoked"
      "approvedAt": "2026-…Z",
      "note": "operator note"          // optional
    }
  },
  "pending": {
    // keyed by the short auth-code id shown to the user (see §2.1/§2.3)
    "<authCodeId>": {
      "encryptedToken": "<base64url envelope>",  // the full AES-256-GCM token (§2.1) — the source of truth
      "channelKey": "feishu:cli_abc",            // decoded copy, for `mesh channels feishu list` display only
      "openId": "ou_123",                        //   (advisory; never trusted over the decrypted token)
      "appId": "cli_abc",
      "firstSeenAt": "2026-…Z",
      "expiresAt": "2026-…Z"
    }
  }
}
```

Notes:

- **Short-id flow (recommended, §2.1 Open Q 2A):** the bot DMs a short id; this `pending` entry stores
  the **full `encryptedToken`** under it. `mesh channels feishu approve <id>` looks the id up, decrypts the stored
  token, and trusts the decrypted `(channelKey, openId, appId)` — the plaintext `channelKey/openId/appId`
  fields here are only a convenience for `mesh channels feishu list` and are never authoritative.
- **Full-token flow (stateless alternative):** the bot DMs the whole `encryptedToken`; the host decrypts
  it directly, so a `pending` entry is **optional/advisory** (index for `list` only).

- We store **token hashes**, never raw bearer tokens (so a leaked file can't impersonate). Verify by
  hashing the presented token and comparing (constant-time, `crypto.timingSafeEqual`).
- `pending` entries are GC'd on read when `expiresAt` has passed (defensive sanitize on load, like
  `session-storage.ts` L30–68).

### 1.3 Concurrency-safe writes (reuse the existing pattern)

Two writers exist: the **backend** (rare — only `lastSeenAt` touch / GC; see Open Q) and the **CLI**
(approve/revoke). Reuse the proven primitives rather than inventing CAS:

- **Atomic write**: tmp file `${path}.${pid}.${Date.now()}.${randomUUID()}.tmp` → `chmod 0600` →
  `rename` (exactly `session-storage.ts` writeSessionState L78–88; `board-store.ts` L86–97).
- **In-process serialization**: a per-path promise-chain lock (`board-store.ts` `withBoardLock` L50–65)
  so concurrent backend writes don't interleave.
- **Cross-process** (CLI vs backend): read-modify-write under a short-lived **lockfile**
  (`<root>/auth/.<file>.lock` via `open` with `wx`, retry-with-backoff, stale-lock breaking by mtime),
  since two OS processes can't share the in-process lock. The window is tiny (approve is rare) so a
  simple advisory lockfile suffices.
- **Backend picks up CLI changes** by watching `<root>/auth/*.json` with `fs.watch` and reloading —
  exactly how `FeishuChannelController` already watches `channels/feishu.json`
  (`src/channels/controller.ts`). A debounced reload (~200ms) absorbs the rename event.

> Recommendation: keep the backend a **reader** of the auth store (plus an optional throttled
> `lastSeenAt` writer) and make the **CLI the only mutator** for approve/revoke/issue-pending. That
> removes most cross-process contention; the lockfile is just belt-and-suspenders.

### 1.4 `channelKey` — making `(channel, …)` precise

"Channel" must be unambiguous across multiple Feishu apps/tenants. Define
`channelKey = "feishu:" + appId` (the bot credential set; `appId` is in `channels/feishu.json`). This
is stable, lets the operator see which bot the request came through, and generalizes to future channels
(`"slack:…"`). The Feishu auth unit is therefore `(channelKey, openId)`.

(Note: today's `allowSenders` is effectively per-binding/per-config, i.e. per app already; `channelKey`
formalizes it.)

---

## 2. Authorization-code cryptography (Feishu)

The Feishu auth code must (a) be unforgeable (tamper-evident), (b) let the host CLI/operator recover
`(channelKey, openId, appId)` without a server round-trip, (c) expire. Per the dispatch this is an
**encryption** scheme (the code is opaque to the user; only the host holds the key and can decrypt it).

### 2.1 Algorithm — AES-256-GCM (AEAD: encryption + integrity)

Use Node stdlib **AES-256-GCM** (`node:crypto`), an AEAD that gives confidentiality **and** anti-forgery
in one primitive — the 128-bit GCM auth tag detects any tampering, so no separate signature is needed:

```
plaintext = JSON.stringify({ v:1, ck: channelKey, oid: openId, app: appId, iat, exp, n: nonce })
iv        = randomBytes(12)                                  // 96-bit GCM IV, fresh per code
cipher    = createCipheriv("aes-256-gcm", key /*32B, by kid*/, iv)
ct        = cipher.update(plaintext) ++ cipher.final()
tag       = cipher.getAuthTag()                              // 16B GCM auth tag
// Envelope: a self-describing JSON token. kid is the string key id from keys.json (e.g. "k1");
// iv / tag / ct are base64url. The whole envelope is base64url'd into one opaque code.
authCode  = base64url(JSON.stringify({
  v:   1,
  kid: "k1",                                                 // string key id — matches keys.json (§2.2)
  iv:  base64url(iv),
  tag: base64url(tag),
  ct:  base64url(ct),
}))
```

- **Encryption + anti-forgery**: the payload is ciphertext (the user can't read or fabricate it); GCM's
  auth tag makes any bit-flip fail `decipher.final()`. A user cannot mint a valid code for another
  `(channel, open_id)` without the host key.
- **Decode on the host** — `mesh channels feishu approve <code>`: base64url-decode the envelope, `JSON.parse` it,
  read the `kid` field → select that key from `keys.json`, `createDecipheriv("aes-256-gcm", key, iv)`,
  `setAuthTag(tag)`, decrypt `ct`, `JSON.parse` the plaintext. Recovers `(channelKey, openId, appId)`
  plus `iat/exp/nonce` with **no server round-trip and no DB lookup** — the token is self-describing
  once decrypted. (Document favors a clear envelope over a maximally-short packed byte layout;
  base64url keeps the code text-safe for a chat message.)
- **Validation order**: GCM tag (via `final()`) → `exp` not passed → `v` known → `nonce` not already
  consumed (replay guard; consumed nonces tracked in `feishu.json.pending`/a small seen-set with TTL).
- **Failure behavior**:
  - tamper / wrong key / truncation → `decipher.final()` throws `unable to authenticate data` → CLI
    prints a generic `invalid or unrecognized authorization code` (never the raw crypto error, never the
    key), exit non-zero, no state change.
  - expired (`exp` past) → `authorization code expired`, no state change.
  - unknown `kid` → treated as invalid (same generic message).
- This is the repo's first `node:crypto` cipher use (today only `randomUUID`); `createCipheriv` is
  stdlib, no dependency.

> Open Q (2A): readability/length. The base64url envelope (JSON wrapping kid + 12B iv + 16B tag + ct,
> ≈ 150–220 chars) is long for a chat message. **Recommended**: the bot DMs a **short opaque id** (e.g.
> 8 base32 chars) recorded in `feishu.json.pending`, whose `encryptedToken` field holds the full envelope;
> the operator types the short id and `mesh channels feishu approve <id>` looks up + decrypts the stored token.
> (Pending entry is then required — see §3.2 / §1.2; the encrypted token, not the short id, is the source
> of truth.) **Alternative**: DM the full envelope (stateless — the host can decrypt it without any
> pending entry) and accept the length. Both are secure; pick per UX. (The §1.2 `pending` index supports
> the short-id option; with the full-token option it's optional/advisory.)

### 2.2 Key source, storage, rotation

- **Key**: 32 random bytes (`crypto.randomBytes(32)`) = the AES-256 key, generated lazily on first need,
  stored as `<root>/auth/keys.json` `{ version, active: "k1", keys: { k1: { secret: base64, createdAt } } }`,
  `0600`. The envelope's `kid` field (the string key id, e.g. `"k1"`) selects which key to decrypt with.
- **IV/nonce**: a fresh 96-bit (12-byte) random IV per code (GCM's recommended IV size); the in-payload
  `nonce` is an independent replay-guard id. Never reuse an IV with the same key.
- **Why not derive from `appSecret`**: keep the auth key independent of the Feishu credential so rotating
  one doesn't invalidate the other, and so the key never leaves the host.
- **Rotation**: `mesh auth rotate-key` adds `k2`, marks it active for new codes, keeps `k1` available for
  **decrypting** outstanding codes until their `exp`, then drops it. The envelope `kid` field makes decrypt
  pick the right key across the overlap window.
- **Alternative considered (not chosen):** an HMAC-SHA256 *signed* (cleartext) token would also be
  unforgeable and is simpler, but the payload would be operator-readable in transit and the dispatch
  asked specifically for an encryption scheme; AES-256-GCM satisfies both confidentiality and integrity.

### 2.3 Web device token (separate mechanism)

Device tokens are **bearer** credentials, not self-describing codes. Generate `crypto.randomBytes(32)`
→ base64url as the token; store only `sha256(token)` (§1.2). No HMAC needed — the token is a random
secret presented over (operator-provided) TLS. (A signed token is an option if we want stateless verify
without the devices file, but the allowlist file is needed anyway for revoke, so a hashed random token
is simpler.)

---

## 3. Host CLI commands

All under the existing `src/main.ts` subcommand dispatcher (the `mesh ps`/`mesh kill` block, ~L125–143),
which already constructs a `MeshManager({ root })` in-process and reads `<root>` state directly.

### 3.1 How the CLI reaches live state

The auth store is **file-backed** (§1.1), so the CLI mutates `<root>/auth/*.json` directly (atomic
write + lockfile) and the running backend **file-watches and reloads** (§1.3). This needs **no IPC** and
mirrors how config changes already propagate. (Alternative: CLI → `POST /api/auth/approve` on the
running backend — rejected as primary because it requires the backend to be up and reachable and adds an
auth-bootstrapping chicken-and-egg; file-backed works even if the backend is restarting.)

### 3.2 Commands

Device (WebUI):

- `mesh device list` — print pending device codes (code, age, coarse origin/UA class) and approved
  devices (id, label, lastSeen).
- `mesh device approve <code> [--label <name>]` — move `pending[code]` → `devices[deviceId]`
  status `approved`; the dormant token activates. Prints the device id.
- `mesh device revoke <deviceId|label>` — set `status:"revoked"` (kept for audit; verify rejects).

Feishu:

- `mesh channels feishu list` — print pending registrations: decoded `(channelKey, openId, appId)`, first-seen,
  expiry; and approved `(channel, open_id)` entries.
- `mesh channels feishu approve <code>` — decrypt the code (AES-256-GCM, §2.1), upsert `allow[(channelKey,openId)]`
  `approved`, drop the pending entry. Prints "approved ou_… on feishu:cli_… (appId …)".
- `mesh channels feishu revoke <channelKey> <openId>` — set `revoked`.

Optional umbrella: `mesh auth list|rotate-key` for the auth-code **encryption key** (§2.2).

Each command: load store → mutate → atomic write under lockfile → print result. No backend needed.

---

## 4. WebUI unauthorized page + device-code polling protocol

### 4.1 Token lifecycle in the browser

- Storage: `localStorage["mesh.deviceToken"]` (the client already uses `localStorage` for theme/i18n;
  no auth there today — `src/web/client/store.ts`). A device token is not a session cookie, so
  `localStorage` is acceptable and survives reloads.
- On boot, before opening the WS / loading the app, the client calls **verify**; on success it proceeds,
  on failure it shows the unauthorized page.

### 4.2 Endpoints (added to `src/web/api.ts` `handleApi`, the `/api/*` router)

All return JSON. Device endpoints are exempt from the CSRF same-origin gate (they're pre-auth and the
device presents a bearer token, not an ambient cookie). **Phase 6:** the `/api/auth/device/*` and
bootstrap endpoints are the *only* pre-auth opening — every other gated request needs an approved
device token (no loopback rule; the §6 "loopback is implicitly trusted" anchor was removed — see the
Phase 6 supersession banner at the top and [`docs/device-auth-operations.md`](../device-auth-operations.md)).

- `POST /api/auth/device/start` → server generates `deviceId` + token + short `code`, stores a `pending`
  entry, returns `{ code, deviceId, pollAfterMs }`. (Token is returned now but **dormant** until
  approved; the client stores it immediately.) Idempotent per existing token if the client re-starts.
- `GET /api/auth/device/status` with `Authorization: Bearer <token>` (or `?deviceId=`) →
  `{ status: "pending" | "approved" | "revoked" | "unknown" }`. The unauthorized page polls this.
- `POST /api/auth/device/verify` with `Authorization: Bearer <token>` →
  `{ ok: true }` (approved) or `401`. Called on boot; cheap (hash compare).

Polling: simple interval, **2–3s** (Open Q 4A: long-poll/SSE is nicer but the codebase's realtime path
is the `/ws` channel which we don't want pre-auth; a 2–3s `GET status` is simplest and low-cost on
loopback/LAN). Stop polling on terminal status; cap total wait (e.g. 10 min = pending expiry) then show
"code expired, refresh".

### 4.3 Authenticating the real app traffic

Once approved, the client includes `Authorization: Bearer <token>` on `/api/*` requests and as a `/ws`
query param or first-message handshake (`?token=` on the WS URL — `store.ts` builds the WS URL, ~L470).
The server validates the token on WS upgrade and on each mutating `/api/*` call (alongside the existing
CSRF check). Unauthorized → `401`/close.

> Open Q 4B **[RESOLVED — Phase 6]**: do we gate **read** endpoints (`GET /api/state`) too, or only
> mutations + WS? **Gate every read and mutation endpoint plus the `/ws` upgrade — token-only, loopback
> included.** The only pre-auth opening is the `/api/auth/device/*` + bootstrap enrollment endpoints
> (and static assets / the unauthorized page). There is no loopback exemption. *(Original recommendation
> "gate everything non-loopback, loopback stays open for bootstrap" is superseded.)*

---

## 5. p2p → Mesh Assistant routing

### 5.1 p2p vs group detection (already available)

`InboundMsg.chatType` is `"p2p" | "group"` (`parseInboundEvent`, `src/channels/consumer.ts` ~L95). The
channel already branches on it implicitly via the `@`-gate (`passesAtGate` returns true for p2p).

### 5.2 Routing rules

In `FeishuChannel.onInbound` (`src/channels/feishu-channel.ts` ~L202), after the **dynamic** sender gate
(§ replaces `senderAllowed`):

- `chatType === "group"`: **unchanged** — look up `byChat.get(chatId)` → binding → mesh; commands and
  `deliverPrompt → mesh.promptRouter(binding.mesh, …)` as today. Group identity is the binding; the
  per-`(channel, open_id)` allow gate is additional (an unbound group chat is still dropped first by
  `byChat`).
- `chatType === "p2p"`: route to the **Mesh Assistant**. p2p has no `chatId → mesh` binding; instead the
  authorized user talks to the central controller. Deliver via `MeshAssistant.prompt(text, images)`
  (`src/mesh-assistant.ts` L115), and mirror the assistant's streamed reply back to the p2p chat.

### 5.3 The coupling problem (important)

Today `FeishuChannel` only holds a `MeshGateway` (the `MeshManager`); it has **no handle to the Mesh
Assistant**, and the assistant is a separate instance reached by `MeshAssistant.prompt()` (not
`promptRouter`), is **optional** (`--no-assistant`), and emits its own update stream (not mesh events).
So routing p2p to it requires a new seam:

- Introduce an **`AssistantGateway`** interface (narrow): `prompt(text, images?)`, `onAssistant(listener)`
  (subscribe to the assistant's `agent_message_chunk`/idle updates), and `available(): boolean`.
  `main.ts` wires the real `MeshAssistant` into it; tests use a fake.
- `FeishuChannel` gains an optional `assistant?: AssistantGateway`. For p2p: if `assistant?.available()`,
  reuse the **same outbound streaming machinery** (the `OutboundSink`/CardSender turn-boundary logic
  from the turn-delay work, see [[project-feishu-channel]]) but driven by assistant updates instead of
  router events. A per-p2p-chat `BindingRuntime`-like state is keyed by `chatId` (the p2p chat id).
- If no assistant configured: reply with a short notice ("助手未启用") and don't route. (Open Q 5A.)

### 5.4 Outbound for p2p

The existing outbound path keys streaming state per binding and filters to `rt.routerId`. For p2p we key
by the p2p `chatId` and filter to the assistant's update stream. The turn-boundary fallback, commit
barrier, and (for CardKit) card streaming all apply unchanged — only the **event source** differs
(assistant vs mesh router). This is the largest net-new code area and should be its own phase (§8).

> Open Q 5B: multiple authorized users each p2p-DM the bot → they all talk to the **one** Mesh
> Assistant instance (shared conversation/session) unless the assistant supports per-user sessions.
> Recommended for v1: single shared assistant session (matches "central controller"), document that
> concurrent p2p users share context; revisit per-user sessions later.

---

## 6. Bootstrap / first device

The lockout risk: a freshly-exposed server with an empty allowlist where the operator is **remote**
(no easy CLI) could lock everyone out. Layered bootstrap:

1. ~~**Loopback is implicitly authorized** (§0 trust model). The operator's browser on the host (or via
   an SSH/loopback tunnel) reaches the app with no token. This is the primary bootstrap and matches
   today's behavior. Implementation: the device-token gate is **skipped for `127.0.0.1`/`::1`** requests
   (detected from the socket remote address, not a spoofable header).~~ **— REMOVED in Phase 6**
   (Open Q 6A confirmed: funnel traffic appears as loopback, so this is not safe). There is **no**
   loopback bootstrap; a host operator instead approves the first device via the CLI (2) or mints a
   one-time bootstrap token (3).
2. **CLI approval** for any device (the normal path) — the operator runs
   `mesh device approve <code>` on the host.
3. **One-time bootstrap token** for the remote-only case. *(As shipped: the operator runs
   `mesh auth bootstrap [--ttl <s>]` on the host, which prints a single-use, short-TTL token once;
   the remote device pastes it into the unauthorized page to approve itself. The bootstrap-condition
   below is historical — Phase 6 makes the token the only allow path regardless of bind address.)*
   ~~on startup, if the allowlist is empty AND the server is bound non-loopback, the backend prints a
   single-use, short-TTL bootstrap URL/token to **stdout / `<root>/backend.log`** (`service.ts`)~~. The
   remote operator who can read the host log (the only person who should) uses it once to approve their
   first device, then it's consumed.

Feishu has no cold-lock problem: an unauthorized user simply gets the auth-code reply; the operator
approves via CLI. The very first Feishu user is approved the same way as every other.

> Open Q 6A **[RESOLVED — Phase 6]**: is loopback-implicit-trust acceptable in the deployed topology? In
> the prod Tailscale-funnel setup ([[reference-prod-tailscale-topology]]) traffic arrives at Windows then
> loopback-forwards into WSL, so **all** funnel traffic appears as loopback to the WSL service — which
> defeats the gate. **Validated true.** Loopback-trust was therefore removed entirely in Phase 6: the
> approved device token is the only allow path (no loopback bypass, no env/flag override); bootstrap now
> relies solely on (2) CLI approval and (3) the one-time bootstrap token.

---

## 7. Affected files & coupling points

New files:

- `src/auth-store.ts` — load/save `devices.json` + `feishu.json` (atomic write + lockfile + sanitize),
  modeled on `src/session-storage.ts` / `src/board-store.ts`.
- `src/auth-codes.ts` — AES-256-GCM encrypt/decrypt for Feishu codes; key load/generate/rotate (`keys.json`).
- `src/auth-cli.ts` (or inline in `main.ts`) — `mesh device|feishu|auth …` subcommands.
- Web: device-auth endpoints in `src/web/api.ts`; an "unauthorized" view + boot-time verify in
  `src/web/client/*`.

Modified (touch points found in research):

- `src/channels/gating.ts` `senderAllowed` (~L10) — the single static gate; becomes a dynamic
  `(channelKey, openId)` lookup against the auth store (sync against an in-memory snapshot the channel
  keeps fresh via the file watcher, to keep `onInbound` non-blocking).
- `src/channels/feishu-channel.ts` `onInbound` (~L202) — call the dynamic gate; on **deny**, emit the
  auth-code reply (new `sendAuthCode` path using the existing `sender.enqueue`); branch p2p→assistant vs
  group→mesh (§5).
- `src/channels/types.ts` / `config.ts` — `allowSenders` stays as an **optional seed/migration source**
  (read once to pre-populate the registry), no longer the live gate.
- `src/web/api.ts` `handleApi` (~L34) + `sameOriginCheck` (~L418) — add endpoints + token gate.
- `src/web/server.ts` / `api-server.ts` — pass the socket remote address into `ApiRequestContext`
  (not from headers). **Phase 6:** the remote address is **diagnostic only** (gate logs / coarse origin
  class) — it never grants access; the original "evaluate the §6 loopback rule" use was removed.
- `src/web/gateway.ts` (WebGateway) + `src/web/client/store.ts` — token on `/api/*` + `/ws`.
- `src/main.ts` — CLI subcommand wiring; construct/inject `AssistantGateway`.
- `src/mesh-assistant.ts` — expose the narrow `AssistantGateway` (prompt + update subscription +
  availability) for the channel.

Coupling points with `src/channels` / Feishu PoC:

- The dynamic gate must stay **synchronous + fast** in `onInbound` (hot path). Keep an in-memory
  allowlist snapshot refreshed by the auth-store file watcher (debounced), like the config watcher.
- p2p→assistant reuses the **outbound streaming/turn-boundary machinery** (commit barrier, fallback
  timer, CardKit) — do not fork it; parameterize the event source.
- The auth-store file watcher and the existing `channels/feishu.json` watcher are independent; ensure
  they don't fight (separate files, separate debounce).

---

## 8. Phased implementation breakdown

Ordered so file-range overlaps are serialized (esp. everything touching `feishu-channel.ts` and
`api.ts`). Suggested one-commit-per-phase, each with tests + `bun test` + `bunx tsc --noEmit`.

1. **Auth store + codes (pure modules, no wiring).** `src/auth-store.ts`, `src/auth-codes.ts`,
   `keys.json`. Unit tests: atomic write, lockfile, sanitize/expiry GC, AES-256-GCM encrypt/decrypt
   round-trip, tamper/expired/unknown-kid rejection, key rotation overlap. No channel/web changes.
   *No overlap — can go first.*
2. **CLI commands.** `mesh device|feishu|auth …` in `main.ts`/`auth-cli.ts`, on top of phase 1. Tests
   for list/approve/revoke against a temp `<root>`. *Overlaps `main.ts` only.*
3. **Feishu dynamic gate + auth-code reply (B).** Replace `senderAllowed` usage with the registry
   snapshot; emit auth code on deny; seed from existing `allowSenders`. Touches `gating.ts`,
   `feishu-channel.ts`, `types.ts`/`config.ts`. Tests: unknown sender → code reply + no route; approved
   sender (via store) → routes; per-`(channel,open_id)` granularity; revoke. *Serial vs phase 5
   (both edit `feishu-channel.ts`).*
4. **WebUI device auth (A).** Endpoints in `api.ts`, remote-address plumb in `server.ts`/`api-server.ts`,
   token gate on `/api/*` + `/ws`, client unauthorized page + boot verify + localStorage token, ~~loopback
   rule~~ + bootstrap (§6). Tests: issue/poll/verify, approval flips status, revoke rejects, ~~loopback
   bypass,~~ non-loopback requires token. *Overlaps `api.ts`/web only — parallel-safe with phase 3.*
   (The loopback bypass shipped here was **removed in Phase 6** — token is now the only allow path.)
5. **p2p → Mesh Assistant (C).** `AssistantGateway` seam, `mesh-assistant.ts` exposure, `main.ts` wiring,
   p2p branch in `feishu-channel.ts` reusing outbound streaming. Tests with a fake assistant gateway:
   p2p→assistant.prompt + streamed reply mirrored; group unchanged; no-assistant notice. *Serial after
   phase 3 (shared `feishu-channel.ts`).*
6. **Hardening / docs / enforcement.** Bootstrap-token flag, key rotation command polish, operator docs,
   the prod loopback validation (Open Q 6A). **Outcome: 6A confirmed loopback-trust is unusable in the
   funnel topology, so Phase 6 removed the loopback bypass outright** — the approved device token is the
   only allow path for gated `/api/*` and `/ws`, the remote address is diagnostic only, and no env/flag
   re-enables a bypass. Operator runbook: [`docs/device-auth-operations.md`](../device-auth-operations.md).

Serialization summary: 1 → (2 ‖ part of 4) → 3 → 5; phase 4 (web) is independent of 3 and can run in
parallel, but **3 and 5 must be serial** (same file). Phase 6 last.

---

## 9. Open questions (recap, each with a recommendation)

- **6A (top priority) — [RESOLVED, Phase 6]:** Does the prod Tailscale-funnel→loopback topology make
  *all* remote traffic look like loopback to the WSL service? **Yes (validated).** The loopback-trust
  gate is unsafe in prod, so Phase 6 removed it: the approved device token is the only allow path
  (no loopback bypass, no env/flag override); bootstrap leans on CLI approval + the one-time bootstrap
  token only. 4B is likewise settled — the gate now covers everything (token-only, loopback included).
- **2A:** Short opaque auth-code id (stateful pending lookup) vs full AES-256-GCM token in chat
  (stateless, long). *Recommend short id for UX; both secure.*
- **4A:** Poll (2–3s `GET status`) vs long-poll/SSE. *Recommend simple poll pre-auth.*
- **4B — [RESOLVED, Phase 6]:** Gate read endpoints too or only mutations+WS? *Gate every read and
  mutation endpoint plus the `/ws` upgrade — token-only, loopback included; only `/api/auth/device/*` +
  bootstrap (and static/unauthorized page) stay pre-auth. (Old "gate everything non-loopback" superseded.)*
- **5A:** No-assistant p2p behavior — notice vs route to a default mesh. *Recommend notice.*
- **5B:** Shared single Mesh Assistant session for all p2p users vs per-user sessions. *Recommend shared
  for v1; document the shared-context caveat.*
- **1/3:** Should the backend ever **write** the auth store (e.g. `lastSeenAt`), or stay read-only with
  the CLI as sole mutator? *Recommend CLI-sole-mutator + optional throttled lastSeen, to minimize
  cross-process contention.*
