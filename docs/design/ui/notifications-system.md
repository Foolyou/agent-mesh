# Notifications system — design (Step 7.4-C, Option B)

Server-persistent, cross-mesh **notification center**: the app-level aggregator for system
messages (harness upgrades, frontend self-update, service/connection status, device-auth
requests, system alerts). It is **NOT** a transcript and **NOT** a mesh's local activity/mail
(`coverage/10-notifications.md` §scope). Surfaced at `/bnw/notifications` (mockup 10) with a
topbar 🔔 unread badge.

This is the **design only** (Step 7.4-C first scope). No backend or frontend code lands in this
commit. It is grounded in existing repo patterns so the implementation is a thin, familiar
addition rather than a new subsystem invented from scratch.

Status today (`coverage/10-notifications.md`): **[N]** net-new — there is no notifications
center; only ad-hoc upgrade notices exist in `HarnessPanel.tsx`. The router `notifications`
route + topbar 🔔 already exist (`router.tsx`, `bnw/BnwApp.tsx`) and render a placeholder.

---

## 1. Data model

A single global store (cross-mesh). One record per logical notification:

```ts
type NotificationType =
  | "harness-upgrade"     // an installed harness adapter is behind latest
  | "frontend-update"     // a newer WebUI build is available (client-relative — see §5)
  | "service-status"      // backend/mesh daemon up↔down / recovery
  | "system-alert"        // auto-compact, orphan reaped, generic operator alert
  | "device-auth";        // a new device is requesting approval

type NotificationSeverity = "info" | "warning" | "error";

interface NotificationRecord {
  id: string;                 // server-allocated, e.g. `ntf-<seq>` (monotonic, like board task ids)
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;              // one-line, already redacted/secret-free
  body?: string;             // optional detail line
  /** Where "follow" navigates — a /bnw route the client can resolve (NOT an external URL).
   *  Stored as a structured target so the client builds the href via bnwHref(). */
  source?: NotificationSource;
  createdAt: string;          // ISO; list is newest-first by (createdAt, id)
  readAt?: string;           // ISO when marked read; absent ⇒ unread
  /** Idempotency / coalescing key — re-firing the same logical event updates the existing
   *  record instead of appending (e.g. "harness-upgrade:codex:1.2.5"). See §below. */
  dedupKey: string;
}

/** A resolvable in-app target (never an arbitrary URL — same /bnw-namespace discipline as the
 *  device-auth ?next guard). The client maps this to a BnwRoute → bnwHref. */
type NotificationSource =
  | { surface: "harnesses" }
  | { surface: "doctor" }
  | { surface: "channels" }
  | { surface: "settings"; tab?: "appearance" | "language" | "prefs" | "devices" }
  | { surface: "runtime"; mesh: string; agent?: string }
  | { surface: "board"; mesh: string; issue?: number };
```

- **Unread marker** = `readAt` absent. `unreadCount` = count of records with no `readAt`.
- **Dedup**: each producer computes a stable `dedupKey`. On emit, if a record with that key
  exists it is **updated in place** (refresh `title`/`body`/`severity`/`createdAt`, clear
  `readAt` so it re-surfaces as unread); otherwise a new record is appended. This prevents the
  obvious spam (the harness probe re-detecting "codex outdated" every refresh would otherwise
  add a row each time). Mirrors how the board allocates ids + sanitizes on every write.
- Maps cleanly onto mockup 10's `NotifClass` (`harness`/`update`/`service`/`system`/`device`)
  and `Notif` fields (`id`/`cls`/`title`/`detail`/`time`/`unread`/`actionLabel`/`actionSurface`)
  — the wire `type`→`cls`, `body`→`detail`, `createdAt`→relative `time`, `source`→`actionSurface`.

---

## 2. Storage

**Server-persistent JSON, single global file** at `<root>/notifications.json` (sibling to
`<root>/auth/` and `<root>/run/`; `root` is the gateway's storage root, the same one
`/api/diagnostics` and device-auth already use). Global (not per-mesh) because the center
aggregates cross-mesh system events — unlike `boards/<mesh>.json` which is mesh-scoped.

```ts
interface NotificationsFile {
  version: number;            // schema version (forward-migration, like DevicesFile.version)
  revision: number;          // monotonic; bumped on every successful mutation (WS ordering/dedup)
  seq: number;               // id allocator (ntf-<seq>), like board epicSeq/taskSeq
  notifications: NotificationRecord[]; // newest-first
}
```

**Atomic, lock-serialized read-modify-write** — mirror `auth-store.ts` exactly (it already
solves "a CLI op and a backend touch must not clobber each other"):

> `auth-store.ts` `updateDevices(root, mutator)` runs read → mutate → `atomicWriteFile` all under
> `withFileLock(devicesPath(root), …)` (`src/auth-codes.ts` `atomicWriteFile` + `withFileLock`).

A `updateNotifications(root, mutator)` helper uses the same `withFileLock` + `atomicWriteFile`
seam. **Why this fits the repo**: notifications have multiple writers (producers across the
backend + the mark-read REST handlers), exactly the auth-store concurrency shape — not the
client-optimistic-CAS shape of the board.

**CAS posture** (vs the board): the board needs client-supplied `expectedRevision`/409 because
clients race to mutate the *same* entity optimistically (`board.ts` `casCheck`/
`applyBoardCommand`). Notifications mutations are server-authoritative and idempotent
(`mark-read <id>` is the same regardless of how many times it runs), so **no client-supplied
CAS token is required**. The server's `revision` is used only for WS ordering and to let a
reconnecting client cheaply detect "did anything change since my snapshot?" — survives restart
because it's persisted in the file.

---

## 3. REST API

All routes under `/api/notifications`, **device-auth gated** (placed below the device-auth
block in `api.ts`, like `/api/diagnostics/*`) and **CSRF-checked for every POST**
(`sameOriginCheck(ctx.headers, ctx.expectedOrigin)`, like the feishu/diagnostics-reap POSTs).
Results are already secret-free (titles/bodies are redacted at the producer).

| Method + path | Body | Response | Notes |
|---|---|---|---|
| `GET /api/notifications` | — | `{ notifications, unreadCount, revision, nextCursor? }` | query: `?unread=1` (filter), `?limit=<n>` (default 50, max 200), `?cursor=<createdAt>_<id>` (keyset pagination, newest-first) |
| `POST /api/notifications/<id>/read` | — | `{ ok, unreadCount, revision }` | idempotent mark-read of one record |
| `POST /api/notifications/read-all` | — | `{ ok, unreadCount: 0, revision }` | mark every record read |
| `POST /api/notifications/cleanup` | `{ }` | `{ removed, revision }` | apply retention now (see §6); cleanup also runs automatically on each write |

Pagination = **keyset/cursor** on `(createdAt, id)` (newest-first), not offset — stable under
concurrent inserts, same shape the transcript backfill uses conceptually. `nextCursor` is null
when the page is the tail.

---

## 4. WS events (on the existing gateway seam)

Reuse the gateway's single broadcast fan-out (`gateway.ts` `broadcast(m: ServerMsg)` →
`this.listeners`; clients subscribe and get `{ t: "snapshot", state }` first). **Snapshot-first
then deltas**, exactly like the board.

**Snapshot** — fold the center into `GatewayState` so the very first WS frame carries it (no
extra round-trip), mirroring how `appVersion`/`meshes` ride the snapshot:

```ts
// added to GatewayState
notifications?: { items: NotificationRecord[]; unreadCount: number; revision: number };
```

**Deltas** — three additive `ServerMsg` variants (the union lives in `types.ts`):

```ts
| { t: "notification.add"; item: NotificationRecord; unreadCount: number; revision: number }
| { t: "notification.update"; id: string; patch: Partial<NotificationRecord>; unreadCount: number; revision: number }
| { t: "notification.unread"; unreadCount: number; revision: number }
```

- `notification.add` — a producer emitted a new (or dedup-refreshed) record → push + new count.
- `notification.update` — a record's `readAt` changed (mark-read) → patch + new count.
- `notification.unread` — count-only nudge (e.g. after `read-all` or `cleanup`).

Every delta carries `unreadCount` so the topbar 🔔 badge updates from **one** field without
re-deriving. `revision` lets a client that missed frames request a fresh `GET` (or just trust
the next snapshot on reconnect).

**Client folding** (`store.ts applyMsg`) mirrors the board case (`case "board": …withPerMesh…`):
the snapshot replaces `state.notifications`; `notification.add` prepends to `items` + sets
`unreadCount`; `notification.update` patches the matching `item`; `notification.unread` sets the
count. A `useUnreadCount(store)` selector feeds the topbar `<Badge>`.

---

## 5. Producers (concrete integration points)

Each producer calls one server-side `emitNotification(root, draft)` (which does the dedup +
`updateNotifications` write + `broadcast({t:"notification.add"…})`). Hooks:

- **harness-upgrade** — where "outdated" is already computed: `gateway.ts`
  `runningAgentsUsingOldVersion(id, latest)` + the harness probe (`HarnessProbeRow.outdated`,
  `broadcastHarnessesChanged`). When a probe/reprobe finds `installed < latest`, emit
  `harness-upgrade` (dedupKey `harness-upgrade:<id>:<latest>`, source `{surface:"harnesses"}`).
- **service-status** — server-observable transitions only: a mesh-host daemon dying/being
  reaped, or the backend (re)starting. Hook the mesh-manager/control-plane events the gateway
  already folds. (Client-side WS connection-lost stays a **transient banner**, not a persisted
  record — see open question Q2.) dedupKey `service-status:<mesh|backend>:<up|down>`, source
  `{surface:"doctor"}`.
- **device-auth** — when `POST /api/auth/device/start` creates a pending device
  (`auth-store` `DevicePending`), emit a `device-auth` "new device requesting approval"
  (dedupKey `device-auth:<deviceId>`, source `{surface:"settings",tab:"devices"}`).
  **Informational only** — approval stays host-CLI authoritative (7.4-B audit: no web
  approve/revoke seam); the follow action opens the settings devices placeholder.
- **system-alert** — operator alerts the backend already knows: auto-compact triggered
  (mesh-host signal), orphan reaped (diagnostics), etc. dedupKey per event, source
  `{surface:"doctor"}` or `{surface:"runtime",mesh,agent}`.
- **frontend-update** — **client-relative**, so it is **client-synthesized**, not server
  persisted: the client already detects a new build via `store.ts` `noteSnapshotVersion` →
  `getUpgrade()` (`{available, current, next}`). The notification view merges this ephemeral
  "update available" entry (action = reload) on top of the server list. It is not written to
  `notifications.json` because "your bundle is stale" is true only for that client. (See Q1.)

---

## 6. Retention / cleanup

Applied inside `updateNotifications` on every write, and via `POST …/cleanup`:

- **Cap**: keep at most `MAX_HISTORY = 200` newest records; older ones are dropped.
- **Age**: drop **read** records older than `READ_TTL = 30 days`. Unread records are kept
  regardless of age (an unacknowledged alert must not silently vanish) up to the cap.
- **Dedup** (write-time): re-firing a `dedupKey` updates in place — no unbounded growth from a
  flapping producer.
- `mark-all-read` does **not** delete; it only sets `readAt` (history is preserved until the
  age/cap policy removes it).

---

## 7. Frontend plan (`/bnw/notifications`, mockup 10)

- **Route**: `notifications` already in `BnwRoute` + `parseBnwRoute` + `bnwHref`
  (`/bnw/notifications`). `BnwApp` renders a real `BnwNotifications` (replacing the placeholder).
- **Topbar bell**: the existing `🔔` `RouteLink` in `BnwApp` gains a `<Badge count={unreadCount}
  max={99} tone="urgent">` fed by the real folded `unreadCount` (mockup 10 header badge).
- **List** (mirror `NotificationsFrame`/`NotifItem`): newest-first; **unread / 历史·已读 split**;
  per-item type chip + icon (`NOTIF_ICON`/`NOTIF_TONE`), title, relative time, unread dot
  (`data-unread-dot`); **follow** action → `navigate(bnwHref(source))` (resolved from the
  structured `source`, never a raw URL); **mark read** per item (`POST …/<id>/read`) and
  **全部已读** in the header (`POST …/read-all`).
- **Category chips**: filter by the 5 types (client-side over the folded list, or `?unread=1`
  server filter for the unread view).
- **States** (per `coverage/10` matrix): empty ("全部已读"), loading (skeleton), error
  (ErrorBanner + retry), offline (pinned connection-lost banner + last-known list, mark-read
  disabled), permission (read-only; device-class follow gated). The bell badge shows the stale
  count when offline.
- **Wiring** is store-only (folded WS state + the four REST calls) — no old view-component
  imports; `/bnw × 9` a11y will crawl `/bnw/notifications` (unread + history + empty) when the
  implementation phase lands.

---

## 8. Open design questions (for prdmgr)

1. **frontend-update placement** — recommend client-synthesized ephemeral (not server
   persisted), since "stale bundle" is client-relative (§5). Confirm, or do you want the server
   to persist a single deploy-level "new build N" record for all clients?
2. **service/connection status** — recommend: persist only **server-observable** events (daemon
   death/restart); keep the client WS connection-lost as a transient banner (not a stored
   record). Confirm, or persist connection-lost per client too?
3. **Read state scope** — `readAt` is **global** (shared across all approved devices), matching
   the single-operator model. Per-device read state is out of scope. Confirm.
4. **device-auth notification** — informational only (no web approve; links to the host-CLI
   devices placeholder from 7.4-B). Confirm that surfacing "new device pending" to an authorized
   web session is acceptable (it reveals a pending enrollment exists; approval still host-CLI).
5. **Delta vs whole-doc** — recommend per-event deltas (add/update/unread) for efficiency, as
   the lead's scope requests ("new notification push + unread-count update"). The board ships
   whole-doc; notifications history is larger, so deltas are preferred. Confirm.
6. **Implementation slicing** — suggest: 7.4-C.1 backend module (store + REST + WS + producers)
   → gate; 7.4-C.2 `/bnw/notifications` UI + topbar badge → gate. Confirm or collapse.
