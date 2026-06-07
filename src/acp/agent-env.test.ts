// src/acp/agent-env.test.ts
// Agents must NOT inherit the mesh-host's MESH_* control env, or a `mesh`/`bun src/main.ts`
// they run would re-exec as a mesh-host and take the backend down (the restart-script bug).
import { test, expect } from "bun:test";
import { agentEnv } from "./client";

test("agentEnv strips every MESH_* var but keeps the rest", () => {
  const saved = { ...process.env };
  try {
    process.env.MESH_SOCK = "/x/run/dev.sock";
    process.env.MESH_CONFIG = '{"name":"dev"}';
    process.env.MESH_ROOT = "/x";
    process.env.MESH_HOST_SCRIPT = "/x/host.ts";
    process.env.PATH = process.env.PATH || "/usr/bin";
    process.env.AGENT_KEEPS_THIS = "yes";

    const env = agentEnv();
    expect(Object.keys(env).some((k) => k.startsWith("MESH_"))).toBe(false);
    expect(env.MESH_SOCK).toBeUndefined();
    expect(env.MESH_CONFIG).toBeUndefined();
    expect(env.PATH).toBeTruthy(); // normal env survives
    expect(env.AGENT_KEEPS_THIS).toBe("yes");
  } finally {
    process.env = saved;
  }
});
