import { homedir } from "node:os";
import { resolve, sep, join } from "node:path";
import type { HarnessId } from "./acp/types";

export const NPM_INSTALL_SPEC = {
  claude: { package: "@agentclientprotocol/claude-agent-acp", version: "0.44.0", bin: "claude-agent-acp" },
  codex: { package: "@zed-industries/codex-acp", version: "0.16.0", bin: "codex-acp" },
} as const;

// Verified against official docs as of 2026-06-13.
export const SELF_INSTALL_HINTS = {
  opencode: {
    command: "curl -fsSL https://opencode.ai/install | bash",
    docsUrl: "https://opencode.ai/docs/",
  },
  kimi: {
    command: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
    docsUrl: "https://moonshotai.github.io/kimi-code/en/",
  },
} as const;

export const NPM_PKG_SPEC_RE = /^@?[a-z0-9][a-z0-9._-]*\/?[a-z0-9._-]*@\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;

export function npmPackageSpec(id: HarnessId): string {
  if (!Object.hasOwn(NPM_INSTALL_SPEC, id)) throw new Error(`harness ${id} is not npm-installable`);
  const spec = NPM_INSTALL_SPEC[id as keyof typeof NPM_INSTALL_SPEC];
  return `${spec.package}@${spec.version}`;
}

export function assertSafeNpmPackageSpec(pkgSpec: string): void {
  if (!NPM_PKG_SPEC_RE.test(pkgSpec)) throw new Error(`unsafe npm package spec: ${pkgSpec}`);
}

export function agentMeshHome(home = homedir()): string {
  return resolve(home, ".agent-mesh");
}

export function managedNpmPrefix(home = homedir()): string {
  return join(agentMeshHome(home), "npm-global");
}

export function assertManagedNpmPrefix(prefix: string, home = homedir()): string {
  const base = agentMeshHome(home);
  const full = resolve(prefix);
  if (full !== base && !full.startsWith(base.endsWith(sep) ? base : base + sep)) {
    throw new Error("managed npm prefix must stay under ~/.agent-mesh");
  }
  return full;
}

export function managedNpmBin(prefix = managedNpmPrefix()): string {
  return join(assertManagedNpmPrefix(prefix), "bin");
}

export function managedNpmCache(prefix = managedNpmPrefix()): string {
  return join(assertManagedNpmPrefix(prefix), ".cache");
}
