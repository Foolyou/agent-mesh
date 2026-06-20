import { chromium, type Browser, type BrowserContext, type BrowserContextOptions } from "playwright";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRoot } from "../root";
import { updateDevices, type DevicesFile } from "../auth-store";
import { generateToken, hashToken } from "../auth-codes";

const CHROMIUM_ARGS = ["--disable-gpu", "--disable-software-rasterizer"];

export function launchChromium(): Promise<Browser> {
  return chromium.launch({ headless: true, args: CHROMIUM_ARGS });
}

export function e2eEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...process.env, NODE_ENV: "production", ...extra };
}

/** Reserve an available TCP port (bind :0, read the assigned port, release it). Lets e2e
 *  self-isolate on a default-free port so back-to-back and concurrent runs never collide on a
 *  shared fixed port (e.g. the old 10020 default). Small bind→spawn race is acceptable for e2e. */
export function freePort(): number {
  const srv = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = srv.port;
  srv.stop(true);
  if (!port) throw new Error("failed to reserve a free port");
  return port;
}

// ── device-auth for browser e2e (device-auth P6: a device token is the only allow path) ──────────
//
// The web gate now requires an approved device token for every non-device /api/* call and the WS
// upgrade — loopback is no longer trusted. So a browser e2e must (1) run the --fake server against an
// isolated MESH_ROOT seeded with one approved device token, and (2) inject that same token into the
// browser's localStorage before the app boots. This provisions REAL authorization (no bypass).

export interface E2eAuth {
  /** Base dir to hand the spawned server as MESH_ROOT (it resolves <base>/.agent-mesh as its root). */
  meshRootBase: string;
  /** The resolved auth-store root under meshRootBase (where the seeded device lives). */
  authRoot: string;
  /** The raw approved device token to inject into the browser + use for readiness probes. */
  token: string;
  /** Env for Bun.spawn so the server's resolveRoot() lands on the seeded root. */
  env: Record<string, string | undefined>;
}

/** Seed ONE approved device token into an existing auth-store root and return the raw token. Used by
 *  e2e that already pass their own `--root <base>` (compute the root via `e2eAuthRoot(base)`). */
export async function seedApprovedDevice(authRoot: string): Promise<string> {
  const token = generateToken();
  await updateDevices(authRoot, (f: DevicesFile) => {
    f.devices["dv_e2e"] = {
      status: "approved",
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    };
  });
  return token;
}

/** The resolved auth-store root the server uses for `--root <base>` (mirrors main.ts resolveRoot). */
export function e2eAuthRoot(base: string): string {
  return resolveRoot(["--root", base]);
}

/** Create an isolated MESH_ROOT and seed it with one approved device token. Pass `env` to the
 *  server spawn and `token` to `authedContext` / `authedReady`. Consumes existing auth-store /
 *  auth-codes APIs only (no frozen-module changes). */
export async function provisionE2eAuth(extraEnv: Record<string, string | undefined> = {}): Promise<E2eAuth> {
  const meshRootBase = await mkdtemp(join(tmpdir(), "mesh-e2e-auth-"));
  const authRoot = resolveRoot([], { MESH_ROOT: meshRootBase } as NodeJS.ProcessEnv);
  const token = await seedApprovedDevice(authRoot);
  return { meshRootBase, authRoot, token, env: e2eEnv({ MESH_ROOT: meshRootBase, ...extraEnv }) };
}

/** A browser context pre-seeded with the device token in localStorage, so the app boots authorized
 *  (the boot probe + all /api fetches carry Bearer, and the WS URL carries ?token=). */
export async function authedContext(browser: Browser, token: string, opts: BrowserContextOptions = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript((t: string) => {
    try {
      localStorage.setItem("mesh.deviceToken", t);
    } catch {
      /* storage unavailable */
    }
  }, token);
  return ctx;
}

/** Readiness probe that carries the device token, so a 200 (not the gate's 401) signals "up". */
export function authedReady(base: string, token: string): Promise<Response> {
  return fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${token}` } });
}
