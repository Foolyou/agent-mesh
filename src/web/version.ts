import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

const WIRE_PROTOCOL_VERSION = "assistant-wire-v1";

export function appVersionFrom(input: { env?: Record<string, string | undefined>; candidates?: (string | undefined)[] } = {}): string {
  const env = input.env ?? process.env;
  const explicit = env.MESH_BUILD_ID || env.MESH_VERSION;
  if (explicit) return explicit;
  for (const candidate of input.candidates ?? []) {
    if (!candidate) continue;
    try {
      const buildId = readFileSync(`${candidate}.build-id`, "utf8").trim();
      if (buildId) return buildId;
    } catch {
      /* try next source */
    }
  }
  for (const candidate of input.candidates ?? []) {
    if (!candidate) continue;
    try {
      const st = statSync(candidate);
      return `${basename(candidate)}:${st.size}:${Math.floor(st.mtimeMs)}`;
    } catch {
      /* try next source */
    }
  }
  return "dev";
}

export function defaultAppVersion(): string {
  const main = (globalThis.Bun as typeof Bun | undefined)?.main;
  return defaultAppVersionFrom(appVersionFrom({ candidates: [process.argv[1], main] }));
}

export function defaultAppVersionFrom(base: string): string {
  return `${base}:${WIRE_PROTOCOL_VERSION}`;
}
