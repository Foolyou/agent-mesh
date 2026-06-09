// Mailbox primitives serve two paths:
//
// - Live ACP mesh: agents communicate through the control plane's injected MCP
//   tools (`send_mail`, `check_mail`, etc.). The control plane passes explicit
//   mailbox paths when it needs this module; live agents should not discover mesh
//   access through env vars or by reading/writing mailbox files directly.
// - Legacy PTY CLI prototype: `mailbox-send.ts`, `mailbox-tail.ts`, and related
//   scripts still use AGENT_ROOM_* defaults for local NDJSON files. Keep that
//   compatibility here until the PTY prototype is retired.
import { mkdir, readFile, appendFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type MailboxEventType =
  | "stage"
  | "result"
  | "question"
  | "blocked"
  | "handoff"
  | "error";

export type MailboxEvent = {
  id: string;
  ts: string;
  from: string;
  type: MailboxEventType;
  taskId: string;
  phase?: string;
  body: string;
  meta?: Record<string, unknown>;
};

export function defaultMailboxPath(): string {
  return process.env.AGENT_ROOM_MAILBOX || ".mesh/mailbox.ndjson";
}

export function resolveMailboxPath(path = defaultMailboxPath()): string {
  return resolve(process.cwd(), path);
}

function defaultArchivePath(mailboxPath: string): string {
  return mailboxPath.endsWith(".ndjson")
    ? mailboxPath.replace(/\.ndjson$/, ".archive.ndjson")
    : `${mailboxPath}.archive.ndjson`;
}

const mailboxLocks = new Map<string, Promise<unknown>>();

async function withMailboxLock<T>(mailboxPath: string, run: () => Promise<T>): Promise<T> {
  const previous = mailboxLocks.get(mailboxPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current, () => current);
  mailboxLocks.set(mailboxPath, chained);
  await previous.catch(() => {});
  try {
    return await run();
  } finally {
    release();
    if (mailboxLocks.get(mailboxPath) === chained) mailboxLocks.delete(mailboxPath);
  }
}

export async function sendMailboxEvent(input: {
  mailboxPath?: string;
  from: string;
  type: MailboxEventType;
  taskId?: string;
  phase?: string;
  body: string;
  meta?: Record<string, unknown>;
}): Promise<MailboxEvent> {
  const mailboxPath = resolveMailboxPath(input.mailboxPath);
  return withMailboxLock(mailboxPath, async () => {
    await mkdir(dirname(mailboxPath), { recursive: true });

    const event: MailboxEvent = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      from: input.from,
      type: input.type,
      taskId: input.taskId || process.env.AGENT_ROOM_TASK_ID || "default",
      phase: input.phase,
      body: input.body,
      meta: input.meta,
    };

    await appendFile(mailboxPath, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  });
}

/** Send an addressed inter-agent message (mesh mailbox). */
export async function sendMail(input: {
  mailboxPath?: string;
  mesh: string;
  from: string;
  to: string;
  body: string;
}): Promise<MailboxEvent> {
  return sendMailboxEvent({
    mailboxPath: input.mailboxPath,
    from: input.from,
    type: "handoff",
    body: input.body,
    meta: { to: input.to, mesh: input.mesh },
  });
}

/**
 * Read mail addressed to `agent`. If `sinceId` is given, returns only mail
 * after that event id (callers track a per-recipient cursor).
 */
export async function readMailFor(
  agent: string,
  options: { mailboxPath?: string; sinceId?: string } = {},
): Promise<MailboxEvent[]> {
  const all = await readMailboxEvents(options.mailboxPath);
  let mail = all.filter((event) => (event.meta as { to?: string } | undefined)?.to === agent);
  if (options.sinceId) {
    const index = mail.findIndex((event) => event.id === options.sinceId);
    if (index >= 0) mail = mail.slice(index + 1);
  }
  return mail;
}

export async function readMailboxEvents(
  mailboxPath = defaultMailboxPath(),
): Promise<MailboxEvent[]> {
  try {
    const text = await readFile(resolveMailboxPath(mailboxPath), "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as MailboxEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function compactMailbox(input: {
  mailboxPath?: string;
  archivePath?: string;
  cursors: Record<string, string | undefined>;
  beforeReplace?: () => Promise<void>;
}): Promise<{ archived: number; kept: number; archivePath: string; skipped?: boolean }> {
  const mailboxPath = resolveMailboxPath(input.mailboxPath);
  const archivePath = resolveMailboxPath(input.archivePath ?? defaultArchivePath(mailboxPath));
  const events = await readMailboxEvents(mailboxPath);
  const snapshotIds = events.map((event) => event.id);
  const cursorOrdinals = new Map<string, number>();
  const ordinals = new Map<string, Map<string, number>>();
  for (const event of events) {
    const to = (event.meta as { to?: string } | undefined)?.to;
    if (!to) continue;
    let recipientOrdinals = ordinals.get(to);
    if (!recipientOrdinals) {
      recipientOrdinals = new Map<string, number>();
      ordinals.set(to, recipientOrdinals);
    }
    recipientOrdinals.set(event.id, recipientOrdinals.size);
  }
  for (const [recipient, cursor] of Object.entries(input.cursors)) {
    if (!cursor) continue;
    const ordinal = ordinals.get(recipient)?.get(cursor);
    if (ordinal !== undefined) cursorOrdinals.set(recipient, ordinal);
  }

  const keep: MailboxEvent[] = [];
  const archive: MailboxEvent[] = [];
  for (const event of events) {
    const to = (event.meta as { to?: string } | undefined)?.to;
    if (!to) {
      keep.push(event);
      continue;
    }
    const cursorOrdinal = cursorOrdinals.get(to);
    const eventOrdinal = ordinals.get(to)?.get(event.id);
    if (cursorOrdinal !== undefined && eventOrdinal !== undefined && eventOrdinal <= cursorOrdinal) {
      archive.push(event);
    } else {
      keep.push(event);
    }
  }

  if (archive.length === 0) {
    return { archived: 0, kept: keep.length, archivePath };
  }

  await input.beforeReplace?.();

  return withMailboxLock(mailboxPath, async () => {
    const current = await readMailboxEvents(mailboxPath);
    if (
      current.length !== snapshotIds.length ||
      current.some((event, index) => event.id !== snapshotIds[index])
    ) {
      return { archived: 0, kept: current.length, archivePath, skipped: true };
    }
    const archivedById = new Map<string, MailboxEvent>();
    for (const event of await readMailboxEvents(archivePath)) archivedById.set(event.id, event);
    for (const event of archive) archivedById.set(event.id, event);
    const archiveTmp = `${archivePath}.${process.pid}.${Date.now()}.tmp`;
    const mailboxTmp = `${mailboxPath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(mailboxPath), { recursive: true });
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(archiveTmp, [...archivedById.values()].map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    await writeFile(mailboxTmp, keep.length ? keep.map((event) => JSON.stringify(event)).join("\n") + "\n" : "", "utf8");
    try {
      await rename(archiveTmp, archivePath);
      await rename(mailboxTmp, mailboxPath);
    } catch (error) {
      await unlink(archiveTmp).catch(() => {});
      await unlink(mailboxTmp).catch(() => {});
      throw error;
    }
    return { archived: archive.length, kept: keep.length, archivePath };
  });
}
