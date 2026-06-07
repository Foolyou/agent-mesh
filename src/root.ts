// Resolve the agent-mesh data root: where mesh definitions, the per-mesh mailbox,
// and run-time sockets live. Precedence: `--root <path>` arg > MESH_ROOT env >
// default ~/.agent-mesh. `~` is expanded; relative paths resolve against cwd.
import { homedir } from "node:os";
import { resolve, isAbsolute, join } from "node:path";

export const DEFAULT_ROOT = "~/.agent-mesh";

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

export function resolveRoot(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string {
  const i = argv.indexOf("--root");
  const raw = (i >= 0 ? argv[i + 1] : undefined) ?? env.MESH_ROOT ?? DEFAULT_ROOT;
  return expandHome(raw);
}
