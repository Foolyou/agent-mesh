import { sessionNotificationSchema } from "@zed-industries/agent-client-protocol";

const COMPAT_UPDATE_KINDS = new Set(["tool_call_update", "usage_update", "config_option_update"]);
const PATCHED = Symbol.for("mesh.acp.sessionNotificationCompat");

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompatSessionNotification(value: unknown): boolean {
  if (!isObject(value) || typeof value.sessionId !== "string" || !isObject(value.update)) return false;
  const kind = value.update.sessionUpdate;
  return typeof kind === "string" && COMPAT_UPDATE_KINDS.has(kind);
}

/** ACP 0.4.5 predates some codex notifications and rejects the whole session/update
 * frame before our client callback sees it. Keep strict parsing for normal traffic, but
 * let the known forward-compatible update shapes through unchanged when strict parsing
 * fails so the existing best-effort transcript/config pipeline can process them.
 */
export function installAcpNotificationCompat(): void {
  const schema = sessionNotificationSchema as any;
  if (schema[PATCHED]) return;
  const originalParse = schema.parse.bind(schema);
  schema.parse = (value: unknown, params?: unknown) => {
    try {
      return originalParse(value, params);
    } catch (err) {
      if (isCompatSessionNotification(value)) return value;
      throw err;
    }
  };
  schema[PATCHED] = true;
}

installAcpNotificationCompat();
