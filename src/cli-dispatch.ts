// src/cli-dispatch.ts — bounded top-level command resolver for the `mesh` binary.
//
// Design: docs/design/mesh-cli-dispatch.md §2.2–§2.3. The dispatcher must (a) start the combined
// console only for the bare `mesh`, (b) print usage + exit 0 for help, (c) exit 2 (never boot a
// service) for an unknown command or an unknown leading flag, and (d) accept global flags BOTH before
// and after the command WITHOUT swallowing command-local flags (`--label`, `--ttl`, `-v`, `-f`, …).
//
// We deliberately do NOT use src/args.ts::parseArgs here: it greedily consumes `--flag <next>`
// (args.ts:30-37), so a boolean global eats the command (`--fake status` → fake="status") and
// subcommand flags get stripped before auth-cli/channels see them. Instead this resolver knows ONLY a
// fixed table of global options (and their arity), stops at the first command token, and keeps the
// command tail verbatim — peeling only KNOWN globals from it.

/** Global options that take a value (arity 1). Also accept the `--k=v` form. */
export const GLOBAL_VALUE = new Set(["--root", "--port", "--host", "--backend", "--assistant-harness", "--master-harness"]);
/** Boolean global options (arity 0). */
export const GLOBAL_BOOL = new Set(["--fake", "--cold", "--no-assistant", "--no-mesh-assistant", "--no-master"]);
/** Tokens that request help anywhere (bare `help` only counts as the leading command token). */
const HELP_LEADING = new Set(["help", "--help", "-h"]);
const HELP_FLAG = new Set(["--help", "-h"]);

/** Commands the dispatcher recognizes. `start`/`stop` alias `up`/`down`; `feishu` is a DEPRECATED
 *  top-level alias of `channels feishu` (kept known so it routes + warns, not "unknown command"). */
export const KNOWN_COMMANDS = new Set([
  "up", "start", "down", "stop", "status", "restart", "logs",
  "ps", "doctor", "kill", "channels", "device", "feishu", "auth", "backend", "web",
]);

export function isKnownCommand(command: string): boolean {
  return KNOWN_COMMANDS.has(command);
}

export type ResolvedCommand =
  | { mode: "help" }
  | { mode: "error"; message: string }
  | { mode: "run"; command: string | undefined; globals: Record<string, string | boolean>; commandTail: string[] };

/** Parse a known global option at argv[i]. Returns the consumed count (1 or 2) and writes into
 *  `globals`, or an error string if a value-global is missing its value. Returns null when argv[i] is
 *  not a known global (caller decides: command token, error, or command-tail). */
function takeGlobal(argv: string[], i: number, globals: Record<string, string | boolean>): number | { error: string } | null {
  const a = argv[i];
  const eq = a.startsWith("--") ? a.indexOf("=") : -1;
  const name = eq >= 0 ? a.slice(0, eq) : a;
  if (GLOBAL_VALUE.has(name)) {
    if (eq >= 0) {
      globals[name.slice(2)] = a.slice(eq + 1);
      return 1;
    }
    const v = argv[i + 1];
    if (v === undefined) return { error: `option ${a} requires a value` };
    globals[name.slice(2)] = v;
    return 2;
  }
  if (GLOBAL_BOOL.has(a)) {
    globals[a.slice(2)] = true;
    return 1;
  }
  return null;
}

/**
 * Resolve `argv` (process.argv.slice(2)) into a command + globals + verbatim command tail.
 *
 * Phase 1 (prefix): peel known globals until the first command token; a help token anywhere in the
 * prefix → help mode; an UNKNOWN leading flag → error (no command owns it, so we never boot a service).
 * Phase 2/3 (tail): everything after the command, with known globals peeled (so post-command globals
 * work) and EVERYTHING ELSE kept verbatim for command-local parsers.
 */
export function resolveCommand(argv: string[]): ResolvedCommand {
  const globals: Record<string, string | boolean> = {};
  let i = 0;
  let command: string | undefined;

  // ── Phase 1: locate the command, peeling known globals before it ──
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (HELP_LEADING.has(a)) return { mode: "help" };
    const took = takeGlobal(argv, i, globals);
    if (took === null) {
      if (a.startsWith("-")) return { mode: "error", message: `unknown option ${a}` };
      command = a;
      i++; // command consumed; tail starts at the next token
      break;
    }
    if (typeof took === "object") return { mode: "error", message: took.error };
    i += took - 1; // -1 because the for-loop also does i++
  }

  // ── Phase 2/3: command tail, peeling known globals, keeping the rest verbatim ──
  const commandTail: string[] = [];
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (HELP_FLAG.has(a)) return { mode: "help" }; // `mesh <cmd> --help` shows usage, runs nothing
    const took = takeGlobal(argv, i, globals);
    if (took === null) {
      commandTail.push(a); // unknown/subcommand flag or positional → verbatim
      continue;
    }
    if (typeof took === "object") return { mode: "error", message: took.error };
    i += took - 1;
  }

  return { mode: "run", command, globals, commandTail };
}

/** Top-level usage text (design §2.1). Printed on `help` (stdout) and on unknown command/flag (stderr). */
export function usageLines(): string[] {
  return [
    "agent-mesh — multi-agent control plane",
    "",
    "usage: mesh [global flags] <command> [args]",
    "",
    "launch:",
    "  mesh                      start the combined web console (SPA + API + WS)",
    "  mesh up | start           background-start the control plane (combined web+API)",
    "  mesh down | stop          stop it (mesh daemons stay running; --cold reaps them)",
    "  mesh restart              restart it (hot; --cold also reaps mesh daemons)",
    "  mesh backend              headless REST + WS only",
    "  mesh web --backend <url>  SPA + reverse-proxy to a backend",
    "",
    "read-only / config:",
    "  mesh status               control plane up/down + running meshes",
    "  mesh ps [-v]              running mesh daemons (-v: detailed)",
    "  mesh doctor               system health check",
    "  mesh logs [-f]            backend log (-f: follow)",
    "  mesh kill <name> | --all  stop a / all mesh daemon(s)",
    "  mesh channels <provider> … external chat channels; provider: feishu",
    "  mesh device …             device authorization (list | approve | revoke)",
    "  mesh auth …               auth keys (list | rotate-key | bootstrap)",
    "",
    "help:",
    "  mesh help | --help | -h",
    "",
    "global flags: --root <dir>  --port <n>  --host <addr>  --backend <url>  --fake  --cold",
    "              --no-assistant  --assistant-harness <codex|claude|opencode|kimi>",
  ];
}

/** Channel providers the `mesh channels <provider> …` tree routes to. Feishu is the first; add more
 *  here as they land (the dispatch + usage stay table-driven). */
export const CHANNEL_PROVIDERS = new Set(["feishu"]);

/** Usage for the `mesh channels` subcommand tree (printed on an unknown/missing provider). */
export function channelsUsageLines(): string[] {
  return [
    "usage: mesh channels <provider> <action> …",
    "  mesh channels feishu list",
    "  mesh channels feishu approve <code>",
    "  mesh channels feishu revoke <channelKey> <openId>",
  ];
}
