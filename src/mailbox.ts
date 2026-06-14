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

/** Addressed-mail metadata shape stored on MailboxEvent.meta. */
export type MailMeta = {
  to: string;
  mesh: string;
  steer?: boolean;
  /** Per-mesh monotonic short number agents use to reference mail ("#17"). */
  seq?: number;
  /** seq of the mail this one replies to. */
  replyTo?: number;
  /** Board task this mail is associated with (the mail→task half of the link; the task→mail
   *  half lives in Task.mailEventIds). Set when the send_mail `task` field parsed to "#N"/"N"
   *  and that task exists. */
  boardTaskId?: number;
};

/** Send an addressed inter-agent message (mesh mailbox). */
export async function sendMail(input: {
  mailboxPath?: string;
  mesh: string;
  from: string;
  to: string;
  body: string;
  /** Marks steer deliveries so durable mail history can distinguish them. */
  steer?: boolean;
  seq?: number;
  replyTo?: number;
  /** Task thread this mail belongs to (e.g. a task slug); lands on event.taskId. */
  task?: string;
  /** Resolved board task id ("#N"/"N") for the mail↔board link, when applicable. */
  boardTaskId?: number;
}): Promise<MailboxEvent> {
  return sendMailboxEvent({
    mailboxPath: input.mailboxPath,
    from: input.from,
    type: "handoff",
    taskId: input.task,
    body: input.body,
    meta: {
      to: input.to,
      mesh: input.mesh,
      ...(input.steer ? { steer: true } : {}),
      ...(input.seq !== undefined ? { seq: input.seq } : {}),
      ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
      ...(input.boardTaskId !== undefined ? { boardTaskId: input.boardTaskId } : {}),
    } satisfies MailMeta,
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

/** Recent addressed (agent-to-agent) mail across the live mailbox AND its compaction
 *  archive, oldest first, capped to the most recent `cap`. Compaction moves consumed
 *  mail to the archive, so the live file alone under-reports history. */
export async function readRecentAddressedMail(
  options: { mailboxPath?: string; cap?: number } = {},
): Promise<MailboxEvent[]> {
  const mailboxPath = resolveMailboxPath(options.mailboxPath);
  const archived = await readMailboxEvents(defaultArchivePath(mailboxPath));
  const live = await readMailboxEvents(mailboxPath);
  const seen = new Set<string>();
  const mail = [...archived, ...live].filter((event) => {
    const meta = event.meta as { to?: string; steer?: boolean } | undefined;
    if (!meta?.to || meta.steer || seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
  const cap = options.cap ?? 200;
  return mail.length > cap ? mail.slice(mail.length - cap) : mail;
}

/** Unread addressed mail from the live mailbox only, using per-recipient cursors.
 *  Compacted archive files contain already-consumed history and are deliberately
 *  ignored so a restarted mesh does not replay old coordination traffic. */
export async function readUnreadAddressedMail(
  options: { mailboxPath?: string; cursors: Record<string, string | undefined>; cap?: number },
): Promise<MailboxEvent[]> {
  const live = await readMailboxEvents(options.mailboxPath);
  const cursorInLive = new Set<string>();
  for (const event of live) {
    const to = (event.meta as { to?: string } | undefined)?.to;
    if (to && options.cursors[to] === event.id) cursorInLive.add(to);
  }

  const passedCursor = new Set<string>();
  const mail = live.filter((event) => {
    const meta = event.meta as { to?: string; steer?: boolean } | undefined;
    const to = meta?.to;
    if (!to || meta.steer) return false;
    const cursor = options.cursors[to];
    if (cursor && cursorInLive.has(to) && !passedCursor.has(to)) {
      if (event.id === cursor) passedCursor.add(to);
      return false;
    }
    return true;
  });

  const cap = options.cap ?? 200;
  return mail.length > cap ? mail.slice(mail.length - cap) : mail;
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
  archiveCap?: number;
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
    const archivedEvents = [...archivedById.values()];
    const archiveCap = input.archiveCap ?? Number.POSITIVE_INFINITY;
    const rolledArchive = Number.isFinite(archiveCap) && archiveCap >= 0
      ? archivedEvents.slice(Math.max(0, archivedEvents.length - archiveCap))
      : archivedEvents;
    const archiveTmp = `${archivePath}.${process.pid}.${Date.now()}.tmp`;
    const mailboxTmp = `${mailboxPath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(mailboxPath), { recursive: true });
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(archiveTmp, rolledArchive.length ? rolledArchive.map((event) => JSON.stringify(event)).join("\n") + "\n" : "", "utf8");
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
