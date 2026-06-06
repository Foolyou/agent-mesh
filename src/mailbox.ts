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
