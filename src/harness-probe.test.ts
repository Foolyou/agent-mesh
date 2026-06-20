import { expect, test } from "bun:test";
import { join } from "node:path";
import { HARNESSES } from "./harness";
import { clearHarnessProbeCache, parseToolVersion, probeHarnesses, type HarnessProbeConnection } from "./harness-probe";
import type { HarnessId } from "./acp/types";

class FakeProbeConnection implements HarnessProbeConnection {
  constructor(private version: string, private calls: string[]) {}
  async start(): Promise<void> {
    this.calls.push("start");
  }
  async initialize(): Promise<unknown> {
    this.calls.push("initialize");
    return { agentInfo: { version: this.version } };
  }
  kill(): void {
    this.calls.push("kill");
  }
}

test("probeHarnesses reports all registered harnesses with managed prefix taking precedence over PATH", async () => {
  clearHarnessProbeCache();
  const managedBin = "/home/u/.agent-mesh/npm-global/bin";
  const rows = await probeHarnesses({
    managedBin,
    which: (command, path) => {
      if (path === managedBin && command === "codex-acp") return join(managedBin, command);
      if (path !== managedBin && command === "claude-agent-acp") return `/usr/bin/${command}`;
      return null;
    },
    latest: async () => undefined,
    createConnection: () => new FakeProbeConnection("9.9.9", []),
  });

  expect(rows.map((r) => r.id)).toEqual(Object.keys(HARNESSES) as HarnessId[]);
  expect(rows.find((r) => r.id === "codex")).toMatchObject({ installed: true, path: join(managedBin, "codex-acp"), version: "9.9.9" });
  expect(rows.find((r) => r.id === "claude")).toMatchObject({ installed: true, path: "/usr/bin/claude-agent-acp" });
});

test("probeHarnesses uses registry latest and stale-while-error cache", async () => {
  clearHarnessProbeCache();
  let fail = false;
  const latest = async () => {
    if (fail) throw new Error("registry down");
    return { claude: "0.44.0" } as Partial<Record<HarnessId, string>>;
  };
  const first = await probeHarnesses({
    refresh: true,
    which: (command) => (command === "claude-agent-acp" ? `/bin/${command}` : null),
    latest,
    createConnection: () => new FakeProbeConnection("0.42.0", []),
  });
  expect(first.find((r) => r.id === "claude")).toMatchObject({ latest: "0.44.0", outdated: true });

  fail = true;
  const stale = await probeHarnesses({
    refresh: true,
    which: (command) => (command === "claude-agent-acp" ? `/bin/${command}` : null),
    latest,
    createConnection: () => new FakeProbeConnection("0.42.0", []),
  });
  expect(stale.find((r) => r.id === "claude")).toMatchObject({ latest: "0.44.0", outdated: true, error: "registry-unavailable" });
});

test("parseToolVersion extracts the semver token from --version output", () => {
  expect(parseToolVersion("codex-cli 0.141.0")).toBe("0.141.0");
  expect(parseToolVersion("2.1.181 (Claude Code)")).toBe("2.1.181");
  expect(parseToolVersion("1.2.3-beta.4 extra")).toBe("1.2.3-beta.4");
  expect(parseToolVersion("no version here")).toBeUndefined();
  expect(parseToolVersion("")).toBeUndefined();
});

test("probeHarnesses adds display-only body-tool version for codex/claude (success)", async () => {
  clearHarnessProbeCache();
  const calls: string[] = [];
  const rows = await probeHarnesses({
    refresh: true,
    which: (command) => (["codex-acp", "claude-agent-acp", "codex", "claude"].includes(command) ? `/bin/${command}` : null),
    latest: async () => undefined,
    createConnection: () => new FakeProbeConnection("9.9.9", []),
    runToolVersion: async (command) => {
      calls.push(command);
      if (command === "/bin/codex") return "codex-cli 0.141.0";
      if (command === "/bin/claude") return "2.1.181 (Claude Code)";
      return null;
    },
  });
  // adapter version (from ACP initialize) is unchanged; body version is the parsed CLI version
  expect(rows.find((r) => r.id === "codex")).toMatchObject({ version: "9.9.9", toolVersion: "0.141.0", toolPath: "/bin/codex" });
  expect(rows.find((r) => r.id === "claude")).toMatchObject({ version: "9.9.9", toolVersion: "2.1.181", toolPath: "/bin/claude" });
  // opencode/kimi launch the tool directly (no separate body) → never body-probed
  expect(rows.find((r) => r.id === "opencode")?.toolVersion).toBeUndefined();
  expect(rows.find((r) => r.id === "kimi")?.toolVersion).toBeUndefined();
  expect(calls.sort()).toEqual(["/bin/claude", "/bin/codex"]);
});

test("probeHarnesses body-tool probe is fail-soft (null / unparsable → unknown, row not failed)", async () => {
  clearHarnessProbeCache();
  const rows = await probeHarnesses({
    refresh: true,
    which: (command) => (["codex-acp", "claude-agent-acp", "codex", "claude"].includes(command) ? `/bin/${command}` : null),
    latest: async () => undefined,
    createConnection: () => new FakeProbeConnection("9.9.9", []),
    runToolVersion: async (command) => {
      if (command === "/bin/codex") return null; // missing/nonzero/error
      if (command === "/bin/claude") return "weird output without a semver"; // unparsable
      return null;
    },
  });
  const codex = rows.find((r) => r.id === "codex")!;
  expect(codex.toolVersion).toBeUndefined();
  expect(codex.version).toBe("9.9.9"); // adapter version untouched
  expect(codex.error).toBeUndefined(); // row not failed by a soft body-probe miss
  const claude = rows.find((r) => r.id === "claude")!;
  expect(claude.toolVersion).toBeUndefined();
  expect(claude.error).toBeUndefined();
});

test("probeHarnesses skips the body-tool probe when the body binary is not on PATH", async () => {
  clearHarnessProbeCache();
  let called = 0;
  const rows = await probeHarnesses({
    refresh: true,
    which: (command) => (command === "codex-acp" ? `/bin/${command}` : null), // body `codex` absent
    latest: async () => undefined,
    createConnection: () => new FakeProbeConnection("9.9.9", []),
    runToolVersion: async () => {
      called++;
      return "codex-cli 0.141.0";
    },
  });
  const codex = rows.find((r) => r.id === "codex")!;
  expect(codex.toolVersion).toBeUndefined();
  expect(codex.toolPath).toBeUndefined();
  expect(called).toBe(0); // never invoked without a resolved body path
});

test("probeHarnesses marks npm and self installer metadata", async () => {
  clearHarnessProbeCache();
  const rows = await probeHarnesses({ which: () => null, latest: async () => undefined });
  expect(rows.find((r) => r.id === "claude")).toMatchObject({ installable: "npm", installSpec: { npmPackage: "@agentclientprotocol/claude-agent-acp", pinnedVersion: "0.44.0" } });
  expect(rows.find((r) => r.id === "codex")).toMatchObject({ installable: "npm", installSpec: { npmPackage: "@zed-industries/codex-acp", pinnedVersion: "0.16.0" } });
  expect(rows.find((r) => r.id === "opencode")).toMatchObject({ installable: "self", installHint: { command: "curl -fsSL https://opencode.ai/install | bash" } });
  expect(rows.find((r) => r.id === "kimi")).toMatchObject({ installable: "self", installHint: { command: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash", docsUrl: "https://moonshotai.github.io/kimi-code/en/" } });
});
