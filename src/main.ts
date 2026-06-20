// src/main.ts — one binary, three commands:
//   mesh                  combined single process (SPA + API + WS in-process)
//   mesh backend [--port] headless control plane: REST API + WS only
//   mesh web [--port] [--backend URL]   SPA + reverse-proxy /api + /ws to a backend
//
// Flags: --fake (scripted demo, no real agents), --no-assistant (skip the Mesh Assistant),
//        --assistant-harness <codex|claude|opencode|kimi> (Mesh Assistant harness).
// The subprocess-per-mesh model is unchanged; the backend (or combined) process owns
// MeshManager and reaps the whole mesh-host subprocess tree on exit.
import { MeshManager } from "./mesh-manager";
import { MeshAssistant, meshAssistantGateway } from "./mesh-assistant";
import { WebGateway } from "./web/gateway";
import { startWebServer } from "./web/server";
import { startApiServer } from "./web/api-server";
import { FakeManager, FakeAssistant } from "./web/fake";
import { runMeshHost } from "./mesh-host";
import { resolveRootFrom } from "./root";
import { uploadRoot } from "./web/uploads";
import { assistantCliDeprecationWarnings, assistantHarnessPassthrough, noAssistantSelected, parseAssistantHarness } from "./cli-options";
import { createFeishuChannelController, unavailableAssistantGateway } from "./channels";
import { runAuthCommand } from "./auth-cli";
import { collectPsDetail, runDoctor, renderPsDetail, renderDoctor, doctorExitCode } from "./diagnostics";
import { cliPsSources, doctorSources, diagnosticsRunDir } from "./diagnostics-sources";
import { resolveCommand, isKnownCommand, usageLines, channelsUsageLines, CHANNEL_PROVIDERS } from "./cli-dispatch";
import { join } from "node:path";
import * as service from "./service";

// Single-binary support: when this binary is re-execed as a mesh-host subprocess
// (MeshHostClient sets MESH_SOCK/MESH_CONFIG), run the host body instead of the CLI.
if (process.env.MESH_SOCK && process.env.MESH_CONFIG) {
  await runMeshHost();
} else {
  await runCli();
}

async function runCli() {

// Bounded top-level dispatch (design §2.2-§2.3): resolve the command + global flags + verbatim
// command tail BEFORE touching any service/gateway. help/unknown short-circuit here so they never
// boot a server. (Assistant-harness parsing stays where it is for now — its downshift is Commit 2.)
const resolved = resolveCommand(process.argv.slice(2));
if (resolved.mode === "help") {
  for (const line of usageLines()) console.log(line);
  return;
}
if (resolved.mode === "error") {
  console.error(resolved.message);
  for (const line of usageLines()) console.error(line);
  process.exitCode = 2;
  return;
}
const { command, globals, commandTail } = resolved;
// A named command that we don't recognize is an error — exit 2, never fall through to the console.
if (command !== undefined && !isKnownCommand(command)) {
  console.error(`unknown command '${command}'`);
  for (const line of usageLines()) console.error(line);
  process.exitCode = 2;
  return;
}
// bare `mesh` (no command token) → the combined web console (the default branch below).
const cmd = command ?? "all";
const g = (k: string): string | undefined => (typeof globals[k] === "string" ? (globals[k] as string) : undefined);
const gb = (k: string): boolean => globals[k] === true;
const tailHas = (f: string) => commandTail.includes(f);

const fake = gb("fake");

// Assistant config is resolved LAZILY (memoized): only the control-plane / gateway startup paths
// consult it, so an invalid --assistant-harness or MESH_ASSISTANT_HARNESS never breaks a read-only
// command (status/ps/doctor/logs/kill/device/feishu/auth), and the deprecated-flag warnings
// (--master-* / MESH_MASTER_HARNESS) print only when a startup path actually needs the harness.
let assistantCfg: { harness: ReturnType<typeof parseAssistantHarness>; noAssistant: boolean } | undefined;
function resolveAssistant() {
  if (!assistantCfg) {
    // Feed cli-options the RESOLVER-parsed values (not raw process.argv) normalized back into the
    // `--flag value` shape it expects, so the `--assistant-harness=<v>` / `--master-harness=<v>` forms
    // are honored too — not just the space form (parseAssistantHarness uses indexOf and would miss
    // `=`). cli-options still applies the env fallback + precedence (CLI beats env).
    const a: string[] = [];
    const ah = g("assistant-harness");
    if (ah !== undefined) a.push("--assistant-harness", ah);
    const mh = g("master-harness");
    if (mh !== undefined) a.push("--master-harness", mh);
    if (gb("no-assistant")) a.push("--no-assistant");
    if (gb("no-mesh-assistant")) a.push("--no-mesh-assistant");
    if (gb("no-master")) a.push("--no-master");
    for (const warning of assistantCliDeprecationWarnings(a)) console.warn(warning);
    assistantCfg = { harness: parseAssistantHarness(a), noAssistant: noAssistantSelected(a) };
  }
  return assistantCfg;
}

// Derive BOTH the storage root and the base from the resolver's parsed `--root` global (which also
// handles `--root=<v>`), so they can never disagree. `base` is what we forward as --root to a
// re-spawned backend; `root` = `<base>/.agent-mesh`. MESH_ROOT env fallback is preserved.
const { base, root } = resolveRootFrom(g("root"));
// Bind interface: loopback by default (server fns default to 127.0.0.1); --host opts into exposure.
const hostname = g("host");

async function buildGateway() {
  const { harness: assistantHarness, noAssistant } = resolveAssistant();
  const manager: any = fake ? new FakeManager(root) : new MeshManager({ root });
  // Real backend: load whatever the user has defined in their root and nothing more.
  // (We deliberately do NOT seed a sample mesh — the user's storage root stays clean;
  // the UI's empty state guides first-run mesh creation. `--fake` provides the demo.)
  if (!fake) await manager.loadDefinitions();
  let gateway: WebGateway;
  const assistant: any = fake
    ? new FakeAssistant()
    : noAssistant
      ? undefined
      : new MeshAssistant(manager, { cwd: join(root, "assistant"), harness: assistantHarness, uploadRoot: uploadRoot(root), onCapabilities: (caps) => gateway?.setAssistantCapabilities(caps) });
  // Inject the Mesh Assistant gateway for authorized p2p DMs (Phase 5). When the assistant is disabled
  // (--no-assistant), inject an always-unavailable gateway so p2p uniformly gets the notice path.
  const feishu = fake
    ? undefined
    : createFeishuChannelController(manager, { root, assistant: assistant ? meshAssistantGateway(assistant) : unavailableAssistantGateway() });
  gateway = new WebGateway(manager, assistant, { root, channels: { feishu } });
  if (!fake) {
    // Reconnect to any mesh daemons that outlived a previous backend (the whole point of
    // the daemon model): their agents kept running; we re-attach and the daemon replays
    // what we missed. Done AFTER the gateway subscribes so the replay rebuilds its view.
    const back = await manager.reattachRunning();
    if (back.length) console.log(`  reattached to running mesh(es): ${back.join(", ")}`);
  }
  if (fake) {
    gateway.setAssistantStatus("ready");
    gateway.setAssistantCapabilities({ image: true });
  } else if (assistant) {
    assistant
      .start()
      .then(() => gateway.setAssistantStatus("ready"))
      .catch(() => gateway.setAssistantStatus("absent"));
  }
  // External chat bridge (Feishu). Optional: the backend can boot with no config, then the
  // controller hot-reloads `<root>/channels/feishu.json` when the user enables it later.
  if (feishu) {
    try {
      await feishu.start();
    } catch (err) {
      console.warn(`  feishu channel failed to start: ${String(err)}`);
    }
  }
  return { manager, assistant, gateway, feishu };
}

function reapOnExit(stop: () => Promise<void> | void) {
  let down = false;
  const shutdown = async () => {
    if (down) return;
    down = true;
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Survive a terminal hangup so a backend started via `mesh up` (or in a closing shell)
  // isn't taken down with the launcher; stop is explicit (SIGINT/SIGTERM / `mesh down`).
  process.on("SIGHUP", () => {});
}

// ── service management (background backend under a root) ─────────────────────────
const svcPort = Number(process.env.MESH_PORT) || Number(g("port")) || 10010;
const svcCold = gb("cold");
// flags forwarded to the spawned backend (so `mesh up --fake --no-assistant` works). Built lazily
// via resolveAssistant() so ONLY up/restart (startup paths) validate the assistant harness — `down`
// and `status` below never trigger the parse.
const svcPass = () => {
  const { harness, noAssistant } = resolveAssistant();
  return [...(fake ? ["--fake"] : []), ...(noAssistant ? ["--no-assistant"] : []), ...assistantHarnessPassthrough(harness)];
};
if (cmd === "up" || cmd === "start") {
  await service.up(base, root, svcPort, { cold: svcCold, passthrough: svcPass() });
} else if (cmd === "down" || cmd === "stop") {
  await service.down(root, svcPort, { cold: svcCold });
} else if (cmd === "status") {
  await service.status(root, svcPort);
} else if (cmd === "restart") {
  await service.restart(base, root, svcPort, { cold: svcCold, passthrough: svcPass() });
} else if (cmd === "logs") {
  await service.logs(root, { follow: tailHas("-f") || tailHas("--follow") });
} else if (cmd === "ps") {
  if (tailHas("-v") || tailHas("--verbose")) {
    // verbose: shared diagnostics — running meshes + (static) agents + orphans/leaks. Read-only; does
    // NOT connect to any mesh-host socket (that would kick the live backend off its own mesh).
    const ps = await collectPsDetail(diagnosticsRunDir(root), cliPsSources(root));
    for (const line of renderPsDetail(ps)) console.log(line);
  } else {
    // default `mesh ps` — unchanged minimal output: running mesh daemons from the registry.
    const mgr = new MeshManager({ root });
    const running = await mgr.listRunning();
    if (!running.length) console.log("no running meshes");
    else for (const r of running) console.log(`${r.name}\tpid ${r.pid}\t${r.socketPath}`);
  }
} else if (cmd === "doctor") {
  // system health check — shared diagnostics, rendered. Non-zero exit only on an error (warnings pass).
  const report = await runDoctor(doctorSources(root, svcPort));
  for (const line of renderDoctor(report)) console.log(line);
  process.exitCode = doctorExitCode(report);
} else if (cmd === "kill") {
  const target = commandTail[0];
  const mgr = new MeshManager({ root });
  if (target === "--all" || target === "-a") {
    const running = await mgr.listRunning();
    for (const r of running) await mgr.kill(r.name);
    console.log(`killed ${running.length} mesh(es)`);
  } else if (target) {
    console.log((await mgr.kill(target)) ? `killed ${target}` : `no running mesh "${target}"`);
  } else {
    console.error("usage: mesh kill <name> | --all");
    process.exitCode = 2;
  }
} else if (cmd === "channels") {
  // external chat channels (design §2.1): `mesh channels <provider> <action> …`. Routes to the same
  // offline auth-cli implementation as the (deprecated) top-level alias; provider-keyed so more
  // providers can be added without a new top-level command. Unknown/missing provider → exit 2.
  const provider = commandTail[0];
  if (provider && CHANNEL_PROVIDERS.has(provider)) {
    process.exitCode = await runAuthCommand(root, provider, commandTail.slice(1));
  } else {
    console.error(provider ? `unknown channels provider '${provider}'` : "missing channels provider");
    for (const line of channelsUsageLines()) console.error(line);
    process.exitCode = 2;
  }
} else if (cmd === "feishu") {
  // DEPRECATED top-level alias of `mesh channels feishu …` — one warning, then the same impl.
  console.warn("`mesh feishu …` is deprecated; use `mesh channels feishu …`");
  process.exitCode = await runAuthCommand(root, "feishu", commandTail);
} else if (cmd === "device" || cmd === "auth") {
  // device/account authorization CLI (design §3): operates on <root>/auth/*.json directly, no
  // backend needed. Usage + exit codes come from runAuthCli; this is pure delegation. The command
  // tail is passed verbatim so subcommand-local flags (--label, --ttl) reach auth-cli intact.
  process.exitCode = await runAuthCommand(root, cmd, commandTail);
} else if (cmd === "backend") {
  const port = Number(process.env.MESH_API_PORT) || Number(g("port")) || 7300;
  const { manager, assistant, gateway, feishu } = await buildGateway();
  const server = startApiServer(gateway, { port, hostname });
  console.log(`\n  mesh backend (REST + WS) → ${server.url}${fake ? "  (fake)" : `  · root: ${root}`}\n`);
  reapOnExit(async () => {
    server.stop();
    gateway.dispose();
    await feishu?.stop();
    manager.disconnectAll?.(); // leave mesh daemons running for the next backend to reattach
    await assistant?.stop?.();
  });
} else if (cmd === "web") {
  const port = Number(process.env.MESH_WEB_PORT) || Number(g("port")) || 7317;
  const backendUrl = g("backend") || process.env.MESH_BACKEND_URL || "http://localhost:7300";
  const server = startWebServer({ port, backendUrl, hostname });
  console.log(`\n  mesh web (SPA) → ${server.url}  → proxying to backend ${backendUrl}\n`);
  reapOnExit(() => server.stop());
} else {
  // default: combined single process
  const port = Number(process.env.MESH_WEB_PORT) || Number(g("port")) || 7317;
  const { manager, assistant, gateway, feishu } = await buildGateway();
  const server = startWebServer({ port, gateway, hostname });
  console.log(`\n  agent-mesh web console → ${server.url}${fake ? "  (fake mode)" : `  · root: ${root}`}\n`);
  reapOnExit(async () => {
    server.stop();
    gateway.dispose();
    await feishu?.stop();
    manager.disconnectAll?.(); // leave mesh daemons running for the next backend to reattach
    await assistant?.stop?.();
  });
  }
}
