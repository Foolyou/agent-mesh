// src/cli-dispatch.ts — bounded top-level command resolver for the `mesh` binary.
//
// Design: docs/design/mesh-cli-dispatch.md §2.2–§2.3. The dispatcher must (a) keep bare `mesh`
// read-only, (b) print usage + exit 0 for help, (c) exit 2 (never boot a service) for an unknown
// command or an unknown leading flag, and (d) accept global flags BOTH before and after the command
// WITHOUT swallowing command-local flags (`--label`, `--ttl`, `-v`, `-f`, …).
//
// We deliberately do NOT use src/args.ts::parseArgs here: it greedily consumes `--flag <next>`
// (args.ts:30-37), so a boolean global eats the command (`--fake status` → fake="status") and
// subcommand flags get stripped before auth-cli/channels see them. Instead this resolver knows ONLY a
// fixed table of global options (and their arity), stops at the first command token, and keeps the
// command tail verbatim — peeling only KNOWN globals from it.

/** Global options that take a value (arity 1). Also accept the `--k=v` form. */
export const GLOBAL_VALUE = new Set(["--root", "--port", "--host", "--assistant-harness", "--master-harness"]);
/** Boolean global options (arity 0). */
export const GLOBAL_BOOL = new Set(["--fake", "--cold", "--no-assistant", "--no-mesh-assistant", "--no-master"]);
/** Tokens that request help anywhere (bare `help` only counts as the leading command token). */
const HELP_LEADING = new Set(["help", "--help", "-h"]);
const HELP_FLAG = new Set(["--help", "-h"]);

/** Commands the dispatcher recognizes. `start`/`stop` alias `up`/`down`. */
export const KNOWN_COMMANDS = new Set([
  "run", "up", "start", "down", "stop", "status", "restart", "logs",
  "ps", "doctor", "kill", "channels", "device", "auth",
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
    "usage:",
    "  mesh <command> [args] [flags]",
    "  mesh help | --help | -h",
    "",
    "foreground:",
    "  mesh run                         run the combined web console in the foreground",
    "  mesh run --port <n>              run on a specific port",
    "  mesh run --no-assistant          skip the Mesh Assistant",
    "",
    "service:",
    "  mesh up | start                  background-start the combined control plane",
    "  mesh down | stop                 stop the control plane; mesh daemons keep running",
    "  mesh restart                     restart the control plane; mesh daemons keep running",
    "  mesh status                      show service state, port, and running meshes",
    "  mesh logs [-f]                   show or follow the control-plane log",
    "",
    "mesh daemons:",
    "  mesh ps [-v]                     list running mesh daemons",
    "  mesh kill <name> | --all         stop one or all mesh daemons",
    "",
    "channels:",
    "  mesh channels feishu list",
    "  mesh channels feishu approve <code>",
    "  mesh channels feishu revoke <channelKey> <openId>",
    "",
    "authorization:",
    "  mesh device list",
    "  mesh device approve <code> [--label <name>]",
    "  mesh device revoke <deviceId|label>",
    "  mesh auth list",
    "  mesh auth rotate-key",
    "  mesh auth bootstrap [--ttl <seconds>]",
    "",
    "flags:",
    "  --root <dir>                     base dir; data lives in <dir>/.agent-mesh",
    "  --port <n>                       port for run/up/status/restart/down/logs",
    "  --host <addr>                    bind address for started web console",
    "  --cold                           with up/down/restart: reap mesh daemons too",
    "  --no-assistant                   startup paths skip the Mesh Assistant",
    "  --assistant-harness <id>         codex | claude | opencode | kimi",
    "",
    "defaults:",
    "  mesh                             print status, then this help; starts nothing",
    "  mesh run                         auto-selects a free port > 12345",
    "  mesh up                          uses port 10010 unless --port is supplied",
    "  --host                           defaults to 127.0.0.1",
    "  --root                           defaults to ~",
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
