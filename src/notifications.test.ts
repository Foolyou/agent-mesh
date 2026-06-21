// Step 7.4-C.1 — notification store: pure reducers (emit/dedup/mark/cleanup/pagination) + fs
// concurrency/atomicity (mirrors auth-store discipline).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyNotifications, mutateEmit, mutateMarkRead, mutateMarkAll, mutateCleanup, pageList, countUnread,
  readNotifications, updateNotifications, notificationsPath, MAX_HISTORY, READ_TTL_MS,
  type NotificationsFile, type NotificationDraft,
} from "./notifications";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "notif-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const draft = (o: Partial<NotificationDraft> & Pick<NotificationDraft, "dedupKey">): NotificationDraft => ({ type: "system-alert", title: "t", ...o });
const T0 = Date.parse("2026-06-22T00:00:00.000Z");

test("mutateEmit: new key appends an unread record + allocates id + bumps revision", () => {
  const f = emptyNotifications();
  const { record, changed } = mutateEmit(f, draft({ dedupKey: "k1", title: "first" }), T0);
  expect(changed).toBe(true);
  expect(record.id).toBe("ntf-1");
  expect(record.readAt).toBeUndefined();
  expect(f.revision).toBe(1);
  expect(countUnread(f)).toBe(1);
});

test("mutateEmit: same key is idempotent — identical content does NOT change/re-nag", () => {
  const f = emptyNotifications();
  mutateEmit(f, draft({ dedupKey: "k1", title: "x" }), T0);
  mutateMarkRead(f, "ntf-1", T0 + 1);
  const rev = f.revision;
  const { changed } = mutateEmit(f, draft({ dedupKey: "k1", title: "x" }), T0 + 2);
  expect(changed).toBe(false);
  expect(f.revision).toBe(rev);          // no churn
  expect(countUnread(f)).toBe(0);        // stays read (never re-nags)
  expect(f.notifications.length).toBe(1); // no duplicate
});

test("mutateEmit: same key with changed content updates in place but PRESERVES readAt", () => {
  const f = emptyNotifications();
  mutateEmit(f, draft({ dedupKey: "k1", title: "old" }), T0);
  mutateMarkRead(f, "ntf-1", T0 + 1);
  const { changed, record } = mutateEmit(f, draft({ dedupKey: "k1", title: "new body" }), T0 + 2);
  expect(changed).toBe(true);
  expect(record.title).toBe("new body");
  expect(record.readAt).toBeDefined();   // content refreshed, still read
  expect(f.notifications.length).toBe(1);
});

test("mutateMarkRead / mutateMarkAll", () => {
  const f = emptyNotifications();
  mutateEmit(f, draft({ dedupKey: "a" }), T0);
  mutateEmit(f, draft({ dedupKey: "b" }), T0 + 1);
  expect(countUnread(f)).toBe(2);
  expect(mutateMarkRead(f, "ntf-1", T0 + 2)).toBe(true);
  expect(mutateMarkRead(f, "ntf-1", T0 + 3)).toBe(false); // idempotent
  expect(countUnread(f)).toBe(1);
  expect(mutateMarkAll(f, T0 + 4)).toBe(1);
  expect(countUnread(f)).toBe(0);
});

test("mutateCleanup: drops read older than TTL, keeps unread regardless of age", () => {
  const f = emptyNotifications();
  mutateEmit(f, draft({ dedupKey: "old-read" }), T0);
  mutateEmit(f, draft({ dedupKey: "old-unread" }), T0);
  mutateMarkRead(f, "ntf-1", T0); // old-read read at T0
  const removed = mutateCleanup(f, T0 + READ_TTL_MS + 1000);
  expect(removed).toBe(1);
  expect(f.notifications.map((n) => n.dedupKey)).toEqual(["old-unread"]); // unread survives
});

test("mutateCleanup: caps history at MAX_HISTORY, dropping oldest read first", () => {
  const f = emptyNotifications();
  for (let i = 0; i < MAX_HISTORY + 5; i++) mutateEmit(f, draft({ dedupKey: `k${i}`, title: `n${i}` }), T0 + i);
  // mark the 10 oldest read so they're the preferred drop targets
  for (let i = 0; i < 10; i++) mutateMarkRead(f, `ntf-${i + 1}`, T0);
  mutateCleanup(f, T0 + MAX_HISTORY + 100);
  expect(f.notifications.length).toBe(MAX_HISTORY);
  // the newest are kept; the very newest dedupKey is present
  expect(f.notifications[0].dedupKey).toBe(`k${MAX_HISTORY + 4}`);
});

test("pageList: newest-first, unread filter, keyset cursor pagination", () => {
  const f = emptyNotifications();
  for (let i = 0; i < 5; i++) mutateEmit(f, draft({ dedupKey: `k${i}` }), T0 + i * 1000);
  mutateMarkRead(f, "ntf-2", T0); // ntf-2 read
  const p1 = pageList(f, { limit: 2 });
  expect(p1.items.map((n) => n.id)).toEqual(["ntf-5", "ntf-4"]); // newest first
  expect(p1.nextCursor).toBeTruthy();
  const p2 = pageList(f, { limit: 2, cursor: p1.nextCursor! });
  expect(p2.items.map((n) => n.id)).toEqual(["ntf-3", "ntf-2"]);
  const unread = pageList(f, { unread: true, limit: 50 });
  expect(unread.items.some((n) => n.id === "ntf-2")).toBe(false); // filtered out
  expect(unread.unreadCount).toBe(4);
});

test("updateNotifications: atomic round-trip persists to <root>/notifications.json", async () => {
  await updateNotifications(dir, (f) => { mutateEmit(f, draft({ dedupKey: "k1", title: "persisted" }), T0); }, T0);
  const onDisk = JSON.parse(await readFile(notificationsPath(dir), "utf8")) as NotificationsFile;
  expect(onDisk.notifications[0].title).toBe("persisted");
  const reread = await readNotifications(dir);
  expect(reread.notifications.length).toBe(1);
  expect(reread.revision).toBe(onDisk.revision);
});

test("updateNotifications: concurrent emits are lock-serialized — none are lost", async () => {
  await Promise.all(Array.from({ length: 12 }, (_, i) => updateNotifications(dir, (f) => { mutateEmit(f, draft({ dedupKey: `k${i}` }), T0 + i); })));
  const f = await readNotifications(dir);
  expect(f.notifications.length).toBe(12);            // every write survived the lock
  expect(new Set(f.notifications.map((n) => n.id)).size).toBe(12); // ids unique (seq under lock)
});

test("readNotifications: missing / corrupt file → empty store (no throw)", async () => {
  expect(await readNotifications(join(dir, "nope"))).toEqual(emptyNotifications());
});
