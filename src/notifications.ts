// Step 7.4-C.1 — server-persistent, cross-mesh notification center store (design:
// docs/design/ui/notifications-system.md). Pure reducers + fs ops; the web/gateway layer holds
// an in-memory cache and broadcasts deltas. Type-only re-exported into web/types.ts so the client
// bundle shares the model without pulling node:fs (same pattern as src/diagnostics.ts).
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, withFileLock } from "./auth-codes";

export type NotificationType =
  | "harness-upgrade"   // an installed harness adapter is behind latest
  | "frontend-update"   // a newer WebUI build is available (client-synthesized; not persisted)
  | "service-status"    // backend / mesh-host daemon up↔down / recovery
  | "system-alert"      // auto-compact, orphan reaped, generic operator alert
  | "device-auth";      // a new device is requesting approval

export type NotificationSeverity = "info" | "warning" | "error";

/** A resolvable IN-APP target (never an arbitrary URL — same /bnw-namespace discipline as the
 *  device-auth ?next guard). The client maps this to a BnwRoute via bnwHref(). */
export type NotificationSource =
  | { surface: "harnesses" }
  | { surface: "doctor" }
  | { surface: "channels" }
  | { surface: "settings"; tab?: "appearance" | "language" | "prefs" | "devices" }
  | { surface: "runtime"; mesh: string; agent?: string }
  | { surface: "board"; mesh: string; issue?: number };

export interface NotificationRecord {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  source?: NotificationSource;
  createdAt: string;        // ISO; list is newest-first by (createdAt, id)
  readAt?: string;          // ISO when read; absent ⇒ unread
  dedupKey: string;         // re-firing the same key is idempotent (version/state encoded in the key)
}

export interface NotificationsFile {
  version: number;
  revision: number;         // monotonic; bumped on every successful mutation (WS ordering)
  seq: number;              // id allocator (ntf-<seq>)
  notifications: NotificationRecord[]; // newest-first
}

/** Producer input (id/createdAt/readAt are server-assigned). */
export interface NotificationDraft {
  type: NotificationType;
  severity?: NotificationSeverity;
  title: string;
  body?: string;
  source?: NotificationSource;
  dedupKey: string;
}

export interface NotificationsView {
  items: NotificationRecord[];
  unreadCount: number;
  revision: number;
}
export interface NotificationsPage extends NotificationsView {
  nextCursor: string | null;
}

export const NOTIF_SCHEMA_VERSION = 1;
export const MAX_HISTORY = 200;
export const READ_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export function notificationsPath(root: string): string {
  return join(root, "notifications.json");
}
export function emptyNotifications(): NotificationsFile {
  return { version: NOTIF_SCHEMA_VERSION, revision: 0, seq: 0, notifications: [] };
}
export function countUnread(file: NotificationsFile): number {
  return file.notifications.reduce((n, r) => n + (r.readAt ? 0 : 1), 0);
}
export function notificationsView(file: NotificationsFile): NotificationsView {
  return { items: file.notifications, unreadCount: countUnread(file), revision: file.revision };
}
const cursorOf = (r: NotificationRecord) => `${r.createdAt}_${r.id}`;
function byNewest(a: NotificationRecord, b: NotificationRecord): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

// ── pure reducers (testable without fs) ──────────────────────────────────────────

/** Emit (or idempotently refresh) a notification. Dedup by key: a re-fired key updates the
 *  existing record's CONTENT but PRESERVES its readAt + position — the version/state is encoded
 *  in the key, so a genuinely new event is a new key (new unread row), and re-detecting the same
 *  event never re-nags an already-read row. Returns the record + whether anything changed. */
export function mutateEmit(file: NotificationsFile, draft: NotificationDraft, now: number): { record: NotificationRecord; changed: boolean; created: boolean } {
  const existing = file.notifications.find((n) => n.dedupKey === draft.dedupKey);
  const severity = draft.severity ?? "info";
  if (existing) {
    const changed = existing.title !== draft.title || existing.body !== draft.body || existing.severity !== severity || JSON.stringify(existing.source) !== JSON.stringify(draft.source);
    if (!changed) return { record: existing, changed: false, created: false };
    existing.title = draft.title;
    existing.body = draft.body;
    existing.severity = severity;
    existing.source = draft.source;
    file.revision += 1;
    return { record: existing, changed: true, created: false };
  }
  file.seq += 1;
  const record: NotificationRecord = {
    id: `ntf-${file.seq}`, type: draft.type, severity, title: draft.title, body: draft.body,
    source: draft.source, createdAt: new Date(now).toISOString(), dedupKey: draft.dedupKey,
  };
  file.notifications.unshift(record);
  file.revision += 1;
  mutateCleanup(file, now);
  return { record, changed: true, created: true };
}

/** Mark one record read (idempotent). Returns true if a record's readAt changed. */
export function mutateMarkRead(file: NotificationsFile, id: string, now: number): boolean {
  const rec = file.notifications.find((n) => n.id === id);
  if (!rec || rec.readAt) return false;
  rec.readAt = new Date(now).toISOString();
  file.revision += 1;
  return true;
}
/** Mark every record read. Returns count newly read. */
export function mutateMarkAll(file: NotificationsFile, now: number): number {
  const iso = new Date(now).toISOString();
  let n = 0;
  for (const r of file.notifications) if (!r.readAt) { r.readAt = iso; n += 1; }
  if (n) file.revision += 1;
  return n;
}
/** Retention: drop read records older than READ_TTL; cap to MAX_HISTORY newest, preferring to
 *  keep unread. Returns the number removed. Bumps revision only if something was removed. */
export function mutateCleanup(file: NotificationsFile, now: number): number {
  const before = file.notifications.length;
  file.notifications = file.notifications.filter((n) => !(n.readAt && now - Date.parse(n.readAt) > READ_TTL_MS));
  if (file.notifications.length > MAX_HISTORY) {
    const sorted = [...file.notifications].sort(byNewest);
    const unread = sorted.filter((n) => !n.readAt);
    const read = sorted.filter((n) => !!n.readAt);
    file.notifications = [...unread, ...read].slice(0, MAX_HISTORY).sort(byNewest); // drop oldest read first
  }
  const removed = before - file.notifications.length;
  if (removed) file.revision += 1;
  return removed;
}

/** Keyset (cursor) pagination, newest-first; optional unread filter. */
export function pageList(file: NotificationsFile, opts: { unread?: boolean; limit?: number; cursor?: string } = {}): NotificationsPage {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT));
  let items = [...file.notifications].sort(byNewest);
  if (opts.unread) items = items.filter((n) => !n.readAt);
  if (opts.cursor) {
    const idx = items.findIndex((n) => cursorOf(n) === opts.cursor);
    if (idx >= 0) items = items.slice(idx + 1);
  }
  const page = items.slice(0, limit);
  const nextCursor = items.length > limit && page.length ? cursorOf(page[page.length - 1]) : null;
  return { items: page, unreadCount: countUnread(file), revision: file.revision, nextCursor };
}

// ── fs ops (atomic + lock-serialized, mirroring auth-store) ───────────────────────

export async function readNotifications(root: string): Promise<NotificationsFile> {
  try {
    return sanitize(JSON.parse(await readFile(notificationsPath(root), "utf8")));
  } catch {
    return emptyNotifications();
  }
}

/** Synchronous load — used at gateway construction so the very first snapshot/list after a
 *  restart already reflects persisted records (no empty-then-fills race). */
export function readNotificationsSync(root: string): NotificationsFile {
  try {
    return sanitize(JSON.parse(readFileSync(notificationsPath(root), "utf8")));
  } catch {
    return emptyNotifications();
  }
}

/** Concurrency-safe read-modify-write under one lock (read → mutator → cleanup → atomic write),
 *  mirroring auth-store.updateDevices so a producer write and a mark-read never clobber. */
export async function updateNotifications(root: string, mutator: (file: NotificationsFile) => void, now: number = Date.now()): Promise<NotificationsFile> {
  return withFileLock(notificationsPath(root), async () => {
    let file: NotificationsFile;
    try {
      file = sanitize(JSON.parse(await readFile(notificationsPath(root), "utf8")));
    } catch {
      file = emptyNotifications();
    }
    mutator(file);
    mutateCleanup(file, now);
    await atomicWriteFile(notificationsPath(root), JSON.stringify(file, null, 2), 0o600);
    return file;
  });
}

// ── strict validation at the persistence boundary ────────────────────────────────
// A poisoned notifications.json must never push an arbitrary `source` (the safety property is
// "structured /bnw source only" — same discipline as the device-auth ?next guard), an unknown
// `type`, or a bad `severity` into GatewayState / the WS stream.
const NOTIF_TYPES = new Set<NotificationType>(["harness-upgrade", "frontend-update", "service-status", "system-alert", "device-auth"]);
const NOTIF_SEVERITIES = new Set<NotificationSeverity>(["info", "warning", "error"]);
const SETTINGS_TABS = new Set(["appearance", "language", "prefs", "devices"]);

/** Returns a valid structured source, or undefined (the field is dropped — never trusted). */
export function validateSource(s: unknown): NotificationSource | undefined {
  if (!s || typeof s !== "object") return undefined;
  const o = s as Record<string, unknown>;
  switch (o.surface) {
    case "harnesses": case "doctor": case "channels": return { surface: o.surface };
    case "settings": return typeof o.tab === "string" && SETTINGS_TABS.has(o.tab) ? { surface: "settings", tab: o.tab as any } : { surface: "settings" };
    case "runtime": return typeof o.mesh === "string" ? { surface: "runtime", mesh: o.mesh, ...(typeof o.agent === "string" ? { agent: o.agent } : {}) } : undefined;
    case "board": return typeof o.mesh === "string" ? { surface: "board", mesh: o.mesh, ...(Number.isInteger(o.issue) ? { issue: o.issue as number } : {}) } : undefined;
    default: return undefined; // unknown surface / URL-like escape hatch → dropped
  }
}

/** Normalize a persisted record: drop it entirely on a missing required field or unknown type;
 *  coerce an invalid severity to "info"; strip a poisoned source. Returns null ⇒ drop. */
function normalizeRecord(v: unknown): NotificationRecord | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.title !== "string" || typeof r.createdAt !== "string" || typeof r.dedupKey !== "string") return null;
  if (typeof r.type !== "string" || !NOTIF_TYPES.has(r.type as NotificationType)) return null;
  const out: NotificationRecord = {
    id: r.id, type: r.type as NotificationType,
    severity: typeof r.severity === "string" && NOTIF_SEVERITIES.has(r.severity as NotificationSeverity) ? (r.severity as NotificationSeverity) : "info",
    title: r.title, createdAt: r.createdAt, dedupKey: r.dedupKey,
  };
  if (typeof r.body === "string") out.body = r.body;
  if (typeof r.readAt === "string") out.readAt = r.readAt;
  const source = validateSource(r.source);
  if (source) out.source = source;
  return out;
}

function sanitize(v: unknown): NotificationsFile {
  if (!v || typeof v !== "object") return emptyNotifications();
  const f = v as Partial<NotificationsFile>;
  const notifications = (Array.isArray(f.notifications) ? f.notifications.map(normalizeRecord).filter((r): r is NotificationRecord => r !== null) : []);
  return {
    version: typeof f.version === "number" ? f.version : NOTIF_SCHEMA_VERSION,
    revision: typeof f.revision === "number" ? f.revision : 0,
    seq: typeof f.seq === "number" ? f.seq : notifications.length,
    notifications,
  };
}
