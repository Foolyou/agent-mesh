// Mailbox primitives serve two paths:
//
// - Live ACP mesh: agents communicate through the control plane's injected MCP
//   tools (`send_mail`, `check_mail`, etc.). The control plane passes explicit
//   mailbox paths when it needs this module; live agents should not discover mesh
//   access through env vars or by reading/writing mailbox files directly.
// - Legacy PTY CLI prototype: `mailbox-send.ts`, `mailbox-tail.ts`, and related
//   scripts still use AGENT_ROOM_* defaults for local NDJSON files. Keep that
//   compatibility here until the PTY prototype is retired.
import { mkdir, readFile, appendFile } from "node:fs/promises";
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
