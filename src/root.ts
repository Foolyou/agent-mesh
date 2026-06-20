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

/** Resolve base + storage root from an ALREADY-EXTRACTED `--root` value (e.g. from the CLI
 *  dispatcher's parsed globals, which also handle `--root=<v>`) plus the env. base = rootArg |
 *  MESH_ROOT env | home; root = `<base>/.agent-mesh`. Returns both so a caller can forward `base`
 *  as `--root` to a re-spawned backend and have it resolve the SAME root. */
export function resolveRootFrom(
  rootArg: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { base: string; root: string } {
  const rawBase = rootArg ?? env.MESH_ROOT;
  const base = rawBase ? expandHome(rawBase) : homedir();
  return { base, root: join(base, MESH_DIR) };
}

/** Storage root = `<base>/.agent-mesh`, where base = `--root` arg | MESH_ROOT env | home.
 *  Parses `--root <value>` from `argv`; for the `--root=<value>` form, extract via the dispatcher
 *  and use {@link resolveRootFrom} instead (this raw-argv form is kept for non-CLI callers). */
export function resolveRoot(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string {
  const i = argv.indexOf("--root");
  return resolveRootFrom(i >= 0 ? argv[i + 1] : undefined, env).root;
}
