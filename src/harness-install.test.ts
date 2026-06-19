import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarnessInstall, resetHarnessInstallJobsForTests } from "./harness-install";

const TEST_HOME = join(tmpdir(), "mesh-home");
const TEST_PREFIX = join(TEST_HOME, ".agent-mesh", "npm-global");

function doneSpawn(calls: any[]) {
  return (argv: string[], opts: any) => {
    calls.push({ argv, opts });
    return {
      exited: Promise.resolve(0),
      stdout: new Response("").body,
      stderr: new Response("").body,
    };
  };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

test("startHarnessInstall spawns npm install with safe argv flags and env", async () => {
  resetHarnessInstallJobsForTests();
  const calls: any[] = [];
  const job = await startHarnessInstall("claude", {
    prefix: TEST_PREFIX,
    home: TEST_HOME,
    which: () => "/usr/bin/npm",
    spawn: doneSpawn(calls),
    clearProbeCache: () => {},
    clearModelsCache: () => {},
    reprobe: async () => [],
    broadcast: () => {},
  });
  await job.done;

  expect(calls).toHaveLength(1);
  expect(calls[0].argv).toEqual([
    "npm",
    "install",
    "--prefix",
    TEST_PREFIX,
    "--cache",
    join(TEST_PREFIX, ".cache"),
    "--registry",
    "https://registry.npmjs.org/",
    "--ignore-scripts",
    "--no-progress",
    "--no-fund",
    "--no-audit",
    "@agentclientprotocol/claude-agent-acp@0.44.0",
  ]);
  expect(calls[0].argv.join(" ")).not.toContain("bash -c");
  expect(calls[0].opts.env.npm_config_ignore_scripts).toBe("true");
  expect(calls[0].opts.cwd).toBe(TEST_PREFIX);
});

test("startHarnessInstall rejects non-npm harnesses and missing npm", async () => {
  resetHarnessInstallJobsForTests();
  await expect(startHarnessInstall("opencode", { which: () => "/usr/bin/npm" })).rejects.toThrow(/not npm-installable/);
  await expect(startHarnessInstall("claude", { which: () => null })).rejects.toMatchObject({ code: "missing-npm" });
});

test("startHarnessInstall is idempotent for active jobs", async () => {
  resetHarnessInstallJobsForTests();
  const calls: any[] = [];
  let resolveExit!: (code: number) => void;
  const first = await startHarnessInstall("codex", {
    prefix: TEST_PREFIX,
    home: TEST_HOME,
    which: () => "/usr/bin/npm",
    reprobe: async () => [],
    spawn: (argv, opts) => {
      calls.push({ argv, opts });
      return { exited: new Promise<number>((resolve) => { resolveExit = resolve; }), stdout: new Response("").body, stderr: new Response("").body };
    },
  });
  const second = await startHarnessInstall("codex", { which: () => "/usr/bin/npm" });
  expect(second.id).toBe(first.id);
  expect(calls).toHaveLength(1);
  resolveExit(0);
  await first.done;
});

test("startHarnessInstall invalidates caches, reprobes, and broadcasts after success", async () => {
  resetHarnessInstallJobsForTests();
  const events: any[] = [];
  const job = await startHarnessInstall("codex", {
    prefix: TEST_PREFIX,
    home: TEST_HOME,
    which: () => "/usr/bin/npm",
    spawn: doneSpawn([]),
    clearProbeCache: (id) => events.push(["clearProbe", id]),
    clearModelsCache: (id) => events.push(["clearModels", id]),
    reprobe: async (opts) => {
      events.push(["reprobe", opts]);
      return [];
    },
    broadcast: (event) => events.push(["broadcast", event]),
  });
  await job.done;

  expect(events).toContainEqual(["clearProbe", "codex"]);
  expect(events).toContainEqual(["clearModels", "codex"]);
  expect(events).toContainEqual(["reprobe", { refresh: true }]);
  expect(events).toContainEqual(["broadcast", { t: "harnesses-changed", harnessId: "codex" }]);
});

test("startHarnessInstall broadcasts harness changes when spawn fails", async () => {
  resetHarnessInstallJobsForTests();
  const events: any[] = [];
  await expect(startHarnessInstall("codex", {
    prefix: TEST_PREFIX,
    home: TEST_HOME,
    which: () => "/usr/bin/npm",
    spawn: () => {
      throw new Error("spawn failed");
    },
    broadcast: (event) => events.push(event),
  })).rejects.toMatchObject({ code: "spawn-failed" });

  expect(events).toContainEqual({ t: "harnesses-changed", harnessId: "codex" });
});

test("startHarnessInstall records redacted stdout and stderr lines", async () => {
  resetHarnessInstallJobsForTests();
  const job = await startHarnessInstall("codex", {
    prefix: TEST_PREFIX,
    home: TEST_HOME,
    which: () => "/usr/bin/npm",
    spawn: () => ({
      exited: Promise.resolve(0),
      stdout: streamOf("fetching /home/chenan/pkg.tgz\n"),
      stderr: streamOf("log at /Users/alice/.npm/_logs/x-debug.log\n"),
    }),
    reprobe: async () => [],
  });
  await job.done;
  expect(job.events).toContainEqual(expect.objectContaining({ step: "fetch", stdoutLine: "fetching ~/pkg.tgz" }));
  expect(job.events).toContainEqual(expect.objectContaining({ step: "install", stderrLine: "log at ~/.npm/_logs/x-debug.log" }));
});

test("startHarnessInstall drops npm auth token-looking output lines", async () => {
  resetHarnessInstallJobsForTests();
  const job = await startHarnessInstall("codex", {
    prefix: TEST_PREFIX,
    home: TEST_HOME,
    which: () => "/usr/bin/npm",
    spawn: () => ({
      exited: Promise.resolve(0),
      stdout: streamOf("_authToken=abc\nAuthorization: Bearer abc\nnormal install line\n"),
      stderr: streamOf("npm_token=abc\n_password=abc\n"),
    }),
    reprobe: async () => [],
  });
  await job.done;
  const text = job.events.map((e) => `${(e as any).stdoutLine ?? ""}${(e as any).stderrLine ?? ""}`).join("\n");
  expect(text).toContain("normal install line");
  expect(text).not.toContain("_authToken");
  expect(text).not.toContain("Authorization");
  expect(text).not.toContain("npm_token");
  expect(text).not.toContain("_password");
});

test("startHarnessInstall keeps node_modules log lines while dropping NODE_AUTH output", async () => {
  resetHarnessInstallJobsForTests();
  const job = await startHarnessInstall("codex", {
    prefix: TEST_PREFIX,
    home: TEST_HOME,
    which: () => "/usr/bin/npm",
    spawn: () => ({
      exited: Promise.resolve(0),
      stdout: streamOf("added 42 packages to node_modules in 3.5s\nNODE_AUTH_TOKEN=abc\n"),
      stderr: streamOf("audited 42 packages in node_modules\n"),
    }),
    reprobe: async () => [],
  });
  await job.done;
  const text = job.events.map((e) => `${(e as any).stdoutLine ?? ""}${(e as any).stderrLine ?? ""}`).join("\n");
  expect(text).toContain("added 42 packages to node_modules in 3.5s");
  expect(text).toContain("audited 42 packages in node_modules");
  expect(text).not.toContain("NODE_AUTH_TOKEN");
});
