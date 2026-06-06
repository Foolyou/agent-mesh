// Modal form to compose a MeshConfig and POST it. Client-side validation mirrors
// src/mesh-validate.ts; the server re-validates and any error is shown inline.
import { useState } from "react";
import type { Store } from "./store";
import type { HarnessId, AgentRole } from "../types";
import { Btn } from "./ui";

interface AgentDraft {
  id: string;
  harness: HarnessId;
  role: AgentRole;
  project: string;
}

const HARNESSES: HarnessId[] = ["claude", "codex", "opencode"];

function validate(name: string, agents: AgentDraft[], edges: [string, string][]): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return "mesh name must match [A-Za-z0-9._-] and be non-empty";
  if (agents.length === 0) return "at least one agent is required";
  const ids = agents.map((a) => a.id);
  if (ids.some((id) => !id.trim())) return "every agent needs an id";
  if (new Set(ids).size !== ids.length) return "agent ids must be unique";
  const routers = agents.filter((a) => a.role === "router");
  if (routers.length !== 1) return "exactly one agent must be the router";
  for (const a of agents) {
    if (!a.project.trim()) return `agent "${a.id}" needs a project (working dir)`;
    if (a.project.startsWith("/") || a.project.includes("..")) return `agent "${a.id}" project must be a relative path`;
  }
  for (const [from, to] of edges) {
    if (!ids.includes(from) || !ids.includes(to)) return `edge ${from}→${to} references an unknown agent`;
  }
  return null;
}

export function MeshBuilder({ store, onClose }: { store: Store; onClose: (created?: string) => void }) {
  const [name, setName] = useState("");
  const [agents, setAgents] = useState<AgentDraft[]>([
    { id: "router", harness: "claude", role: "router", project: "test_mesh_0" },
  ]);
  const [edges, setEdges] = useState<[string, string][]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setAgent = (i: number, patch: Partial<AgentDraft>) =>
    setAgents((as) => as.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const addAgent = () =>
    setAgents((as) => [...as, { id: `agent-${as.length}`, harness: "codex", role: "member", project: "test_mesh_0" }]);
  const delAgent = (i: number) => setAgents((as) => as.filter((_, j) => j !== i));

  const ids = agents.map((a) => a.id);
  const addEdge = () => setEdges((e) => [...e, [ids[0] ?? "", ids[1] ?? ids[0] ?? ""]]);
  const setEdge = (i: number, which: 0 | 1, v: string) =>
    setEdges((e) => e.map((pair, j) => (j === i ? (which === 0 ? [v, pair[1]] : [pair[0], v]) : pair)));
  const delEdge = (i: number) => setEdges((e) => e.filter((_, j) => j !== i));

  async function submit() {
    const v = validate(name, agents, edges);
    if (v) {
      setErr(v);
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await store.defineMesh({ name, agents, edges });
      onClose(name);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onClick={() => onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="mhead">
          <span style={{ flex: 1 }}>define mesh</span>
          <Btn small kind="ghost" onClick={() => onClose()}>
            ✕ esc
          </Btn>
        </div>
        <div className="mbody">
          <div className="field">
            <label>mesh name</label>
            <input className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. build-squad" autoFocus />
          </div>

          <div className="field">
            <label>agents — exactly one router</label>
            {agents.map((a, i) => (
              <div className="agrow" key={i}>
                <input className="inp" value={a.id} placeholder="id" onChange={(e) => setAgent(i, { id: e.target.value })} />
                <select className="inp" value={a.harness} onChange={(e) => setAgent(i, { harness: e.target.value as HarnessId })}>
                  {HARNESSES.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
                <select className="inp" value={a.role} onChange={(e) => setAgent(i, { role: e.target.value as AgentRole })}>
                  <option value="router">router</option>
                  <option value="member">member</option>
                </select>
                <input className="inp" value={a.project} placeholder="project dir" onChange={(e) => setAgent(i, { project: e.target.value })} />
                <Btn small kind="ghost" onClick={() => delAgent(i)} disabled={agents.length === 1}>
                  ✕
                </Btn>
              </div>
            ))}
            <div>
              <Btn small onClick={addAgent}>
                + agent
              </Btn>
            </div>
          </div>

          <div className="field">
            <label>mail edges — from → to (directed)</label>
            {edges.map((pair, i) => (
              <div className="row" key={i}>
                <select className="inp" value={pair[0]} onChange={(e) => setEdge(i, 0, e.target.value)}>
                  {ids.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
                <span className="sub">→</span>
                <select className="inp" value={pair[1]} onChange={(e) => setEdge(i, 1, e.target.value)}>
                  {ids.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
                <Btn small kind="ghost" onClick={() => delEdge(i)}>
                  ✕
                </Btn>
              </div>
            ))}
            <div>
              <Btn small onClick={addEdge} disabled={agents.length < 2}>
                + edge
              </Btn>
            </div>
          </div>

          {err ? <div className="err">{err}</div> : null}

          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Btn kind="ghost" onClick={() => onClose()}>
              cancel
            </Btn>
            <Btn kind="go" onClick={submit} disabled={busy}>
              {busy ? "defining…" : "define mesh"}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
