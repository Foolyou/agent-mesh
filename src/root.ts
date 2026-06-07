// Resolve the agent-mesh data root. `--root <dir>` (or the MESH_ROOT env) names a BASE
// directory; the service keeps its data in a `.agent-mesh` sub-directory inside it (like a
// project-local `.git`). With no --root/MESH_ROOT the base is the home directory, so the
// default root is `~/.agent-mesh`. `~` is expanded; relative bases resolve against cwd.
//
//   (none)               → ~/.agent-mesh
//   --root /srv/x        → /srv/x/.agent-mesh
//   --root .             → <cwd>/.agent-mesh
import { homedir } from "node:os";
import { resolve, isAbsolute, join } from "node:path";

/** The fixed sub-directory, under the chosen base, where mesh data lives. */
export const MESH_DIR = ".agent-mesh";
/** The default resolved root (base = home), in display form. */
export const DEFAULT_ROOT = `~/${MESH_DIR}`;

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/** Storage root = `<base>/.agent-mesh`, where base = `--root` arg | MESH_ROOT env | home. */
export function resolveRoot(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string {
  const i = argv.indexOf("--root");
  const rawBase = (i >= 0 ? argv[i + 1] : undefined) ?? env.MESH_ROOT;
  const base = rawBase ? expandHome(rawBase) : homedir();
  return join(base, MESH_DIR);
}
