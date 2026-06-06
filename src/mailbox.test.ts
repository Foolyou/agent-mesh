import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sendMail, readMailFor } from "./mailbox";

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
