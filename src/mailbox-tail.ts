import { stat } from "node:fs/promises";
import { parseArgs, booleanArg, stringArg } from "./args";
import { defaultMailboxPath, readMailboxEvents, resolveMailboxPath } from "./mailbox";

function printEvent(event: Awaited<ReturnType<typeof readMailboxEvents>>[number]): void {
  const phase = event.phase ? `/${event.phase}` : "";
  console.log(`[${event.ts}] ${event.from} ${event.type}${phase} task=${event.taskId}`);
  console.log(event.body.trimEnd());
  console.log("");
}

const { values } = parseArgs();
const mailbox = stringArg(values, "mailbox", defaultMailboxPath());
const follow = booleanArg(values, "follow");
let seen = 0;
let lastSize = -1;

async function tick(): Promise<void> {
  const path = resolveMailboxPath(mailbox);
  const size = await stat(path).then((value) => value.size).catch(() => 0);
  if (size === lastSize) {
    return;
  }
  lastSize = size;

  const events = await readMailboxEvents(mailbox);
  for (const event of events.slice(seen)) {
    printEvent(event);
  }
  seen = events.length;
}

await tick();

if (follow) {
  setInterval(() => {
    tick().catch((error) => {
      console.error(error);
    });
  }, 500);
} else {
  process.exit(0);
}
