import { expect, test } from "bun:test";
import { join } from "node:path";
import { HARNESSES } from "./harness";
import { clearHarnessProbeCache, probeHarnesses, type HarnessProbeConnection } from "./harness-probe";
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

test("probeHarnesses marks npm and self installer metadata", async () => {
  clearHarnessProbeCache();
  const rows = await probeHarnesses({ which: () => null, latest: async () => undefined });
  expect(rows.find((r) => r.id === "claude")).toMatchObject({ installable: "npm", installSpec: { npmPackage: "@agentclientprotocol/claude-agent-acp", pinnedVersion: "0.44.0" } });
  expect(rows.find((r) => r.id === "codex")).toMatchObject({ installable: "npm", installSpec: { npmPackage: "@zed-industries/codex-acp", pinnedVersion: "0.16.0" } });
  expect(rows.find((r) => r.id === "opencode")).toMatchObject({ installable: "self", installHint: { command: "curl -fsSL https://opencode.ai/install | bash" } });
  expect(rows.find((r) => r.id === "kimi")).toMatchObject({ installable: "self", installHint: { command: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash" } });
});
