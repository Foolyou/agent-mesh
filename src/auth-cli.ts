// Host CLI commands for device/account authorization (design: docs/design/device-auth.md §3).
//
//   mesh device list | approve <code> [--label <name>] | revoke <deviceId|label>
//   mesh feishu list | approve <code> | revoke <channelKey> <openId>
//   mesh auth   list | rotate-key
//
// These run on the mesh HOST with NO backend required: load `<root>/auth/*.json`, mutate, atomic-write
// under the Phase 1 lockfile, print a result. All store/crypto primitives come from the frozen Phase 1
// modules (auth-store, auth-codes) — this file adds no new persistence or crypto.
//
// Output discipline (per dispatch): NEVER print an AES key, a raw device token, an encrypted-token
// body, or a raw crypto error. Decrypt failures surface only the generic AuthCodeError message.

import {
  AuthCodeError,
  decryptAuthCode,
  generateToken,
  hashToken,
  loadKeys,
  rotateKeys,
  type KeysFile,
} from "./auth-codes";
import {
  feishuAllowKey,
  readDevices,
  readFeishuAuth,
  updateDevices,
  updateFeishuAuth,
} from "./auth-store";

/** Result of a CLI command: stdout lines, stderr lines, and a process exit code. The caller
 *  (main.ts) is responsible for printing — keeping these pure makes them unit-testable. */
export interface CliResult {
  exitCode: number;
  out: string[];
  err: string[];
}

const ok = (...out: string[]): CliResult => ({ exitCode: 0, out, err: [] });
const fail = (...err: string[]): CliResult => ({ exitCode: 2, out: [], err });

/** Default bootstrap-token lifetime: short (10 min) — it only has to survive enrolling one device. */
const DEFAULT_BOOTSTRAP_TTL_SEC = 600;

// A decrypt target when the key store is absent: decryptAuthCode then rejects with a generic
// AuthCodeError("invalid") rather than throwing a raw TypeError on a missing key.
const NO_KEYS: KeysFile = { version: 1, active: "", keys: {} };

function nowIso(): string {
  return new Date().toISOString();
}

function ageStr(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Pull `--name <value>` out of args, returning the value (if any) and the remaining tokens. */
function takeFlag(args: string[], name: string): { value?: string; rest: string[] } {
  const i = args.indexOf(name);
  if (i < 0) return { rest: args };
  const value = args[i + 1];
  const rest = [...args.slice(0, i), ...args.slice(value === undefined ? i + 1 : i + 2)];
  return { value, rest };
}

// ── device commands ──────────────────────────────────────────────────────────

export async function deviceList(root: string): Promise<CliResult> {
  const file = await readDevices(root);
  const out: string[] = [];
  const pending = Object.entries(file.pending);
  out.push(`Pending devices (${pending.length}):`);
  for (const [code, p] of pending) {
    out.push(`  ${code}\tdevice ${p.deviceId}\tage ${ageStr(p.createdAt)}\tclass ${p.userAgentClass ?? "-"}\torigin ${p.remoteHint ?? "-"}\texpires ${p.expiresAt}`);
  }
  const approved = Object.entries(file.devices).filter(([, r]) => r.status === "approved");
  out.push(`Approved devices (${approved.length}):`);
  for (const [id, r] of approved) {
    out.push(`  ${id}\t${r.label ?? "-"}\tlastSeen ${r.lastSeenAt ?? "never"}\tapproved ${r.approvedAt ?? "-"}`);
  }
  const revoked = Object.entries(file.devices).filter(([, r]) => r.status === "revoked");
  if (revoked.length) {
    out.push(`Revoked devices (${revoked.length}):`);
    for (const [id, r] of revoked) out.push(`  ${id}\t${r.label ?? "-"}`);
  }
  out.push(`Bootstrap token: ${file.bootstrap ? (file.bootstrap.consumedAt ? "consumed" : `set (expires ${file.bootstrap.expiresAt})`) : "none"}`);
  return ok(...out);
}

export async function deviceApprove(root: string, code: string, label?: string): Promise<CliResult> {
  if (!code) return fail("usage: mesh device approve <code> [--label <name>]");
  const file = await readDevices(root);
  const pending = file.pending[code];
  if (!pending) return fail(`no pending device code '${code}' (already approved or expired?)`);
  const deviceId = pending.deviceId;
  await updateDevices(root, (f) => {
    const p = f.pending[code];
    if (!p) return; // raced away between read and lock — nothing to do
    delete f.pending[code];
    f.devices[p.deviceId] = {
      ...(label ? { label } : {}),
      status: "approved",
      tokenHash: p.tokenHash,
      createdAt: p.createdAt,
      approvedAt: nowIso(),
    };
  });
  return ok(`approved device ${deviceId}${label ? ` (label: ${label})` : ""}`);
}

export async function deviceRevoke(root: string, target: string): Promise<CliResult> {
  if (!target) return fail("usage: mesh device revoke <deviceId|label>");
  const revoked: string[] = [];
  await updateDevices(root, (f) => {
    if (f.devices[target]) {
      f.devices[target].status = "revoked";
      revoked.push(target);
      return;
    }
    for (const [id, rec] of Object.entries(f.devices)) {
      if (rec.label === target) {
        rec.status = "revoked";
        revoked.push(id);
      }
    }
  });
  if (!revoked.length) return fail(`no device matching '${target}'`);
  return ok(`revoked ${revoked.length} device(s): ${revoked.join(", ")}`);
}

// ── feishu commands ──────────────────────────────────────────────────────────

export async function feishuList(root: string): Promise<CliResult> {
  const file = await readFeishuAuth(root);
  const out: string[] = [];
  const pending = Object.entries(file.pending);
  out.push(`Pending feishu authorizations (${pending.length}):`);
  for (const [code, p] of pending) {
    // channelKey/openId/appId here are advisory display copies (the encrypted token is authoritative);
    // the encrypted token body is never printed.
    out.push(`  ${code}\t${p.channelKey}\t${p.openId}\tappId ${p.appId}\tfirstSeen ${p.firstSeenAt}\texpires ${p.expiresAt}`);
  }
  const approved = Object.values(file.allow).filter((e) => e.status === "approved");
  out.push(`Approved (channelKey, openId) (${approved.length}):`);
  for (const e of approved) {
    out.push(`  ${e.channelKey}\t${e.openId}\tapproved ${e.approvedAt}${e.note ? `\t${e.note}` : ""}`);
  }
  const revoked = Object.values(file.allow).filter((e) => e.status === "revoked");
  if (revoked.length) {
    out.push(`Revoked (${revoked.length}):`);
    for (const e of revoked) out.push(`  ${e.channelKey}\t${e.openId}`);
  }
  return ok(...out);
}

export async function feishuApprove(root: string, code: string): Promise<CliResult> {
  if (!code) return fail("usage: mesh feishu approve <code>");
  const file = await readFeishuAuth(root);
  const pending = file.pending[code];
  if (!pending) return fail(`no pending feishu authorization '${code}' (already approved or expired?)`);

  // Short-id flow: the encrypted token is the source of truth. Decrypt it and trust ONLY the decoded
  // (channelKey, openId, appId) — never the advisory plaintext fields on the pending entry.
  const keys = (await loadKeys(root)) ?? NO_KEYS;
  let payload;
  try {
    payload = decryptAuthCode(keys, pending.encryptedToken);
  } catch (e) {
    // AuthCodeError messages are already generic + key/plaintext-free; never leak a raw crypto error.
    const msg = e instanceof AuthCodeError ? e.message : "invalid or unrecognized authorization code";
    return fail(msg); // no state change on a failed decrypt (matches design §2.1)
  }

  await updateFeishuAuth(root, (f) => {
    delete f.pending[code];
    f.allow[feishuAllowKey(payload.channelKey, payload.openId)] = {
      channelKey: payload.channelKey,
      openId: payload.openId,
      status: "approved",
      approvedAt: nowIso(),
    };
  });
  return ok(`approved ${payload.openId} on ${payload.channelKey} (appId ${payload.appId})`);
}

export async function feishuRevoke(root: string, channelKey: string, openId: string): Promise<CliResult> {
  if (!channelKey || !openId) return fail("usage: mesh feishu revoke <channelKey> <openId>");
  const key = feishuAllowKey(channelKey, openId);
  let found = false;
  await updateFeishuAuth(root, (f) => {
    const entry = f.allow[key];
    if (entry) {
      entry.status = "revoked";
      found = true;
    }
  });
  if (!found) return fail(`no approved feishu entry for (${channelKey}, ${openId})`);
  return ok(`revoked ${openId} on ${channelKey}`);
}

// ── auth key commands ──────────────────────────────────────────────────────────

export async function authList(root: string): Promise<CliResult> {
  const keys = await loadKeys(root);
  if (!keys) return ok("no auth encryption key store yet (created on first authorization code)");
  const out: string[] = [`Auth encryption keys (active: ${keys.active}):`];
  for (const [kid, k] of Object.entries(keys.keys)) {
    // metadata only — the secret is NEVER printed
    out.push(`  ${kid}\tcreated ${k.createdAt}${kid === keys.active ? "\t(active)" : ""}`);
  }
  return ok(...out);
}

export async function authRotateKey(root: string): Promise<CliResult> {
  const rotated = await rotateKeys(root);
  return ok(`rotated auth encryption key; new active ${rotated.active}; retained ${Object.keys(rotated.keys).length} key(s)`);
}

/** Issue a one-time, short-TTL bootstrap token for enrolling the first remote device (design §6).
 *  The raw token is printed to stdout ONCE; the store keeps only its hash. Re-issuing supersedes any
 *  previous bootstrap token (the new entry has no consumedAt). Phase 4's web gate verifies/consumes it. */
export async function authBootstrap(root: string, ttlArg?: string): Promise<CliResult> {
  let ttl = DEFAULT_BOOTSTRAP_TTL_SEC;
  if (ttlArg !== undefined) {
    const n = Number(ttlArg);
    if (!Number.isInteger(n) || n <= 0) return fail(`invalid --ttl '${ttlArg}' (expected a positive integer number of seconds)`);
    ttl = n;
  }
  const token = generateToken();
  const now = Date.now();
  const expiresAt = new Date(now + ttl * 1000).toISOString();
  let replaced = false;
  await updateDevices(root, (f) => {
    replaced = !!f.bootstrap; // a single bootstrap slot — note whether we superseded a prior one
    // hash only — the raw token never touches the store; replaces any prior (incl. consumed) token
    f.bootstrap = { tokenHash: hashToken(token), createdAt: new Date(now).toISOString(), expiresAt };
  });
  return ok(
    `bootstrap token ${replaced ? "replaced" : "minted"} (one-time, expires ${expiresAt}):`,
    `  ${token}`,
    "Use it once from the new device to enroll. It is stored only as a hash and shown here only once.",
  );
}

// ── dispatcher ───────────────────────────────────────────────────────────────

const USAGE: Record<string, string[]> = {
  device: [
    "usage: mesh device list",
    "       mesh device approve <code> [--label <name>]",
    "       mesh device revoke <deviceId|label>",
  ],
  feishu: [
    "usage: mesh feishu list",
    "       mesh feishu approve <code>",
    "       mesh feishu revoke <channelKey> <openId>",
  ],
  auth: ["usage: mesh auth list", "       mesh auth rotate-key", "       mesh auth bootstrap [--ttl <seconds>]"],
};

/** main.ts entry seam: run a `mesh <group> …` command, print `out`→stdout and `err`→stderr, and
 *  return the exit code. Writers are injectable so the print/exit glue is unit-testable without
 *  spawning the binary. */
export async function runAuthCommand(
  root: string,
  group: string,
  args: string[],
  io: { out?: (line: string) => void; err?: (line: string) => void } = {},
): Promise<number> {
  const writeOut = io.out ?? ((l: string) => console.log(l));
  const writeErr = io.err ?? ((l: string) => console.error(l));
  const res = await runAuthCli(root, group, args);
  for (const l of res.out) writeOut(l);
  for (const l of res.err) writeErr(l);
  return res.exitCode;
}

/** Parse + run `mesh <group> <action> …`. `args` are the tokens AFTER the group (i.e.
 *  process.argv.slice(3)). Returns a CliResult; the caller prints and sets the exit code. */
export async function runAuthCli(root: string, group: string, args: string[]): Promise<CliResult> {
  const usage = USAGE[group];
  if (!usage) return fail(`unknown command group '${group}'`);
  const action = args[0];
  const rest = args.slice(1);

  if (group === "device") {
    if (action === "list") return deviceList(root);
    if (action === "approve") {
      const { value: label, rest: pos } = takeFlag(rest, "--label");
      return deviceApprove(root, pos[0], label);
    }
    if (action === "revoke") return deviceRevoke(root, rest[0]);
    return fail(...usage);
  }
  if (group === "feishu") {
    if (action === "list") return feishuList(root);
    if (action === "approve") return feishuApprove(root, rest[0]);
    if (action === "revoke") return feishuRevoke(root, rest[0], rest[1]);
    return fail(...usage);
  }
  // group === "auth"
  if (action === "list") return authList(root);
  if (action === "rotate-key") return authRotateKey(root);
  if (action === "bootstrap") {
    const hadFlag = rest.includes("--ttl");
    const { value: ttl } = takeFlag(rest, "--ttl");
    if (hadFlag && ttl === undefined) return fail("invalid --ttl (missing value)", ...usage);
    return authBootstrap(root, ttl);
  }
  return fail(...usage);
}
