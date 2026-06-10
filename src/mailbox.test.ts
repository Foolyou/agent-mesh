import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { compactMailbox, readMailboxEvents, sendMail, readMailFor } from "./mailbox";

test("readMailFor returns only mail addressed to the agent", async () => {
  const p = join(tmpdir(), `mbx-${randomUUID()}.ndjson`);
  await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "b", body: "hi-b" });
  await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "c", body: "hi-c" });
  const forB = await readMailFor("b", { mailboxPath: p });
  expect(forB.map((m) => m.body)).toEqual(["hi-b"]);
});

test("readMailFor honors sinceId cursor", async () => {
  const p = join(tmpdir(), `mbx-${randomUUID()}.ndjson`);
  const first = await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "b", body: "one" });
  await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "b", body: "two" });
  const after = await readMailFor("b", { mailboxPath: p, sinceId: first.id });
  expect(after.map((m) => m.body)).toEqual(["two"]);
});

test("compactMailbox archives only mail covered by each recipient cursor", async () => {
  const p = join(tmpdir(), `mbx-${randomUUID()}.ndjson`);
  const b1 = await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "b", body: "b-one" });
  await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "b", body: "b-two" });
  await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "c", body: "c-one" });

  const result = await compactMailbox({ mailboxPath: p, cursors: { b: b1.id } });

  expect(result.archived).toBe(1);
  expect((await readMailboxEvents(p)).map((event) => event.body)).toEqual(["b-two", "c-one"]);
  expect((await readMailboxEvents(result.archivePath)).map((event) => event.body)).toEqual(["b-one"]);
});

test("compactMailbox keeps cold or dead recipient mail without a cursor in the main mailbox", async () => {
  const p = join(tmpdir(), `mbx-${randomUUID()}.ndjson`);
  const ready = await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "ready", body: "ready-read" });
  await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "cold", body: "cold-unread" });

  const result = await compactMailbox({ mailboxPath: p, cursors: { ready: ready.id } });

  expect(result.archived).toBe(1);
  expect((await readMailboxEvents(p)).map((event) => event.body)).toEqual(["cold-unread"]);
  expect((await readMailboxEvents(result.archivePath)).map((event) => event.body)).toEqual(["ready-read"]);
});

test("readMailFor with a cursor reads current mailbox incrementally after compaction", async () => {
  const p = join(tmpdir(), `mbx-${randomUUID()}.ndjson`);
  const first = await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "b", body: "old" });
  await compactMailbox({ mailboxPath: p, cursors: { b: first.id } });
  await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "b", body: "new" });

  expect((await readMailFor("b", { mailboxPath: p, sinceId: first.id })).map((event) => event.body)).toEqual(["new"]);
});

test("compactMailbox replaces archive without duplicating previously archived events", async () => {
  const p = join(tmpdir(), `mbx-${randomUUID()}.ndjson`);
  const b1 = await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "b", body: "b-one" });

  await compactMailbox({ mailboxPath: p, cursors: { b: b1.id } });
  await compactMailbox({ mailboxPath: p, cursors: { b: b1.id } });

  const archivePath = p.replace(/\.ndjson$/, ".archive.ndjson");
  expect((await readMailboxEvents(archivePath)).map((event) => event.id)).toEqual([b1.id]);
});

test("compactMailbox skips replacement when mail is appended after its snapshot", async () => {
  const p = join(tmpdir(), `mbx-${randomUUID()}.ndjson`);
  const first = await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "b", body: "old" });

  const result = await compactMailbox({
    mailboxPath: p,
    cursors: { b: first.id },
    beforeReplace: async () => {
      await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "b", body: "new" });
    },
  });

  expect(result).toMatchObject({ archived: 0, skipped: true });
  expect((await readMailboxEvents(p)).map((event) => event.body)).toEqual(["old", "new"]);
  expect(await readMailboxEvents(result.archivePath)).toEqual([]);

  const current = await readMailboxEvents(p);
  const next = await compactMailbox({ mailboxPath: p, cursors: { b: current[current.length - 1]!.id } });
  expect(next.archived).toBe(2);
  expect(next.skipped).toBeUndefined();
  expect(await readMailboxEvents(p)).toEqual([]);
  expect((await readMailboxEvents(next.archivePath)).map((event) => event.body)).toEqual(["old", "new"]);
});

test("compactMailbox can roll the archive to the newest capped events", async () => {
  const p = join(tmpdir(), `mbx-${randomUUID()}.ndjson`);
  const first = await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "b", body: "one" });
  const second = await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "b", body: "two" });
  const third = await sendMail({ mailboxPath: p, mesh: "m", from: "a", to: "b", body: "three" });

  const result = await compactMailbox({ mailboxPath: p, cursors: { b: third.id }, archiveCap: 2 });

  expect(result.archived).toBe(3);
  expect((await readMailboxEvents(result.archivePath)).map((event) => event.id)).toEqual([second.id, third.id]);
  expect((await readMailboxEvents(result.archivePath)).map((event) => event.body)).toEqual(["two", "three"]);
  expect(first.id).toBeString();
});
