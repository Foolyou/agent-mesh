# Device / Account Authorization — Operations

How an operator runs the mesh web console and Feishu channel under **mandatory device
authorization** (device-auth phase 6). For the design rationale see
[`docs/design/device-auth.md`](./design/device-auth.md); this page is the operator runbook.

---

## 0. What changed (and the security model)

- **An approved device token is the ONLY way past the gate.** Every non-device `/api/*`
  request and the `/ws` upgrade require a valid device token. There is no other allow path.
- **Loopback is NOT trusted.** Earlier builds implicitly trusted requests whose socket
  address was loopback (`127.0.0.1`/`::1`). Production funnel testing proved that remote
  traffic reaches the service **as a loopback socket** (the funnel forwards into a loopback
  port), so a loopback address is not a trustworthy origin signal and the bypass was removed.
  This applies to **every** session, including local development on the host.
- **There is no override.** No environment variable, flag, or config re-enables loopback
  trust or otherwise bypasses the token. (If you read about `MESH_TRUST_LOOPBACK_WHEN_EXPOSED`
  in an older note, it no longer exists.)
- **The host CLI needs no token.** `mesh device …`, `mesh auth …`, and `mesh channels feishu …`
  operate directly on the on-disk auth store (`<root>/auth/*.json`); they
  do not go through the HTTP gate. Anyone who can run `mesh …` on the host is already the root of trust.

### Where state lives

The auth store is under the resolved root `<root>` (default `~/.agent-mesh`; overridable with
`--root <dir>` or `MESH_ROOT`):

- `<root>/auth/devices.json` — WebUI device allowlist + pending codes + the one-time bootstrap token.
- `<root>/auth/feishu.json` — Feishu `(channelKey, openId)` authorization registry.
- `<root>/auth/keys.json` — AES-256-GCM key store for Feishu auth codes.

Raw tokens are never stored — only `sha256` hashes. Run the CLI with the **same `--root`** the
backend/service uses (or rely on the default).

---

## 1. First device & enrollment (WebUI)

When a browser opens the console without an approved token it shows an **unauthorized page**
with a short **device code** and polls for approval. Two ways to approve:

### A. Operator at the host CLI (normal path)

1. On the new device, open the console → note the device code (e.g. `K7Q-3F9`).
2. On the host:
   ```
   mesh device approve K7Q-3F9 [--label chrome-laptop]
   ```
3. The page polls, sees `approved`, and enters the app. The device's token persists in the
   browser (`localStorage["mesh.deviceToken"]`) and is sent as `Authorization: Bearer …` on
   `/api/*` and as `?token=…` on `/ws` thereafter.

Local/host browsers use the **same** flow — loopback is no longer auto-trusted.

### B. One-time bootstrap token (remote-only cold start)

When the operator can read the host (logs/shell) but cannot easily reach the host CLI for the
new device, mint a single-use token:

1. On the host:
   ```
   mesh auth bootstrap            # default TTL 10 min
   mesh auth bootstrap --ttl 300  # custom TTL in seconds
   ```
   It prints the raw token **once** (stored only as a hash; re-running supersedes any prior one).
2. On the new device's unauthorized page, the device first requests a code (which also mints its
   own dormant token), then paste the bootstrap token into the "bootstrap token" field and submit.
   The server consumes the bootstrap token (one-time) and flips **that device** to approved; the
   bootstrap token itself never becomes a durable credential.
3. The device now holds its own approved token and proceeds normally.

A bootstrap token is single-use and short-lived: once consumed or expired it is rejected.

---

## 2. Device management

```
mesh device list                                 # pending codes, approved + revoked devices, bootstrap status
mesh device approve <code> [--label <name>]      # approve a pending device code
mesh device revoke <deviceId|label>              # revoke (the device is rejected immediately)
```

- `list` shows pending codes (with a coarse, non-PII origin/UA class), approved devices
  (id, label, last-seen), revoked devices, and whether a bootstrap token is set/consumed.
- `revoke` accepts a device id or a label; revoked devices are kept for audit and the gate
  rejects them.

---

## 3. Feishu authorization

Unauthorized Feishu users receive an auth code from the bot; approve `(channelKey, openId)` on
the host. `channelKey` is `feishu:<appId>`.

```
mesh channels feishu list                        # pending registrations + approved/revoked (channelKey, openId)
mesh channels feishu approve <code>              # decrypt the auth code, approve that (channelKey, openId)
mesh channels feishu revoke <channelKey> <openId> # revoke an approved entry
```

`mesh channels <provider> …` is the only form (Feishu is the first provider).

The encrypted auth-code body is never printed; `approve` trusts only the decrypted identity.

---

## 4. Auth encryption key rotation

The Feishu auth codes are encrypted with a key store (`keys.json`). Rotate periodically:

```
mesh auth list           # show key ids + the active key (secrets are never printed)
mesh auth rotate-key     # add a new active key; older keys are retained to decrypt outstanding codes
```

Rotation keeps prior keys so codes minted before the rotation still decrypt until they expire.

---

## 5. Recovery & operator notes

- **Locked out of the WebUI?** There is no loopback fallback. Recover from the **host CLI**
  (which needs no token): `mesh device approve <code>` for a device showing a code, or
  `mesh auth bootstrap` to mint a one-time token. Both work offline against `<root>/auth/`.
- **Use the right root.** If the service runs with a non-default `--root`/`MESH_ROOT`, pass the
  same `--root` to the `mesh device …` / `mesh auth …` / `mesh channels feishu …` commands, or they
  will read an empty store.
- **Service liveness is unaffected.** `mesh up/status/restart` run the combined web+API control
  plane and, like `scripts/update.sh`, probe it for liveness, not data: a protected control plane
  answering `401` to an unauthenticated probe still counts as **alive** (only a 5xx, network error,
  or timeout is unhealthy). The probe sends no token and exposes nothing.
- **Exposing the console.** When binding beyond loopback (`--host 0.0.0.0`, a Tailscale funnel,
  etc.) the token is the entire protection — there is no loopback shortcut. Approve devices via
  the CLI (or bootstrap) and treat the device tokens as secrets.
- **No bypass to add.** Do not look for an env/flag to disable auth or re-trust loopback; none
  exists by design, and adding one would defeat the funnel-exposure protection.
