import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId, HarnessId, ThinkingEffort } from "./acp/types";

export interface AgentSessionRecord {
  sessionId: string;
  cwd: string;
  harness: HarnessId;
  model?: string;
  mode?: string;
  effort?: ThinkingEffort;
}

export interface MeshSessionState {
  meshExpectedAlive: boolean;
  agents: Record<AgentId, AgentSessionRecord>;
}

export function sessionStatePath(runDir: string, meshName: string): string {
  return join(runDir, `${meshName}.sessions.json`);
}

function sanitizeAgentRecord(input: unknown): AgentSessionRecord | undefined {
  const raw = input as Partial<Record<keyof AgentSessionRecord, unknown>> | undefined;
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.sessionId !== "string" || typeof raw.cwd !== "string" || typeof raw.harness !== "string") {
    return undefined;
  }
  const record: AgentSessionRecord = {
    sessionId: raw.sessionId,
    cwd: raw.cwd,
    harness: raw.harness as HarnessId,
  };
  if (typeof raw.model === "string") record.model = raw.model;
  if (typeof raw.mode === "string") record.mode = raw.mode;
  if (typeof raw.effort === "string") record.effort = raw.effort as ThinkingEffort;
  return record;
}

function sanitizeState(input: unknown): MeshSessionState {
  const raw = input as { meshExpectedAlive?: unknown; agents?: unknown } | undefined;
  const agents: Record<AgentId, AgentSessionRecord> = {};
  if (raw?.agents && typeof raw.agents === "object") {
    for (const [agentId, value] of Object.entries(raw.agents as Record<string, unknown>)) {
      const record = sanitizeAgentRecord(value);
      if (record) agents[agentId] = record;
    }
  }
  return {
    meshExpectedAlive: typeof raw?.meshExpectedAlive === "boolean" ? raw.meshExpectedAlive : true,
    agents,
  };
}

export async function readSessionState(runDir: string, meshName: string): Promise<MeshSessionState> {
  try {
    return sanitizeState(JSON.parse(await readFile(sessionStatePath(runDir, meshName), "utf8")));
  } catch {
    return { meshExpectedAlive: true, agents: {} };
  }
}

export async function writeSessionState(runDir: string, meshName: string, state: MeshSessionState): Promise<void> {
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await chmod(runDir, 0o700).catch(() => {});
  const path = sessionStatePath(runDir, meshName);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const sanitized = sanitizeState(state);
  await writeFile(tmp, JSON.stringify(sanitized, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

export async function updateAgentSession(
  runDir: string,
  meshName: string,
  agentId: AgentId,
  record: AgentSessionRecord,
): Promise<MeshSessionState> {
  const state = await readSessionState(runDir, meshName);
  state.meshExpectedAlive = true;
  const sanitized = sanitizeAgentRecord(record);
  if (!sanitized) throw new Error(`invalid session record for ${agentId}`);
  state.agents[agentId] = sanitized;
  await writeSessionState(runDir, meshName, state);
  return state;
}

export async function setMeshExpectedAlive(runDir: string, meshName: string, expectedAlive: boolean): Promise<MeshSessionState> {
  const state = await readSessionState(runDir, meshName);
  state.meshExpectedAlive = expectedAlive;
  await writeSessionState(runDir, meshName, state);
  return state;
}

/** Invalidate one agent's persisted ACP session id (keeps cwd/harness/model/mode/effort)
 *  so the agent's NEXT spawn starts a fresh session instead of resuming. No-op if absent.
 *  Does NOT touch meshExpectedAlive — clearing a session must never resurrect a stopped mesh. */
export async function clearAgentSession(runDir: string, meshName: string, agentId: AgentId): Promise<MeshSessionState> {
  const state = await readSessionState(runDir, meshName);
  const rec = state.agents[agentId];
  if (rec) rec.sessionId = "";
  await writeSessionState(runDir, meshName, state);
  return state;
}

/** Invalidate every agent's persisted session id (mesh-wide fresh start). */
export async function clearAllAgentSessions(runDir: string, meshName: string): Promise<MeshSessionState> {
  const state = await readSessionState(runDir, meshName);
  for (const rec of Object.values(state.agents)) rec.sessionId = "";
  await writeSessionState(runDir, meshName, state);
  return state;
}
