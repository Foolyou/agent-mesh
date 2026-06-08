// Modal form to compose a MeshConfig and POST it. Client-side validation mirrors
// src/mesh-validate.ts; the server re-validates and any error is shown inline.
import { useState } from "react";
import type { Store } from "./store";
import type { HarnessId, AgentRole, MeshConfig, ThinkingEffort } from "../types";
import { Btn } from "./ui";
import { useI18n } from "./i18n";

interface AgentDraft {
  id: string;
  harness: HarnessId;
  role: AgentRole;
  project: string;
  effort?: ThinkingEffort;
  instructions?: string;
}
interface EdgeDraft {
  from: string;
  to: string;
  steer?: boolean;
}

const HARNESSES: HarnessId[] = ["claude", "codex", "opencode", "kimi"];

function validate(name: string, agents: AgentDraft[], edges: EdgeDraft[]): string | null {
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
    const instructions = a.instructions?.trim();
    if (instructions && instructions.length > 4000) return `agent "${a.id}" instructions are too long (max 4000 chars)`;
  }
  const router = agents.find((a) => a.role === "router")?.id;
  for (const edge of edges) {
    if (!ids.includes(edge.from) || !ids.includes(edge.to)) return `edge ${edge.from}→${edge.to} references an unknown agent`;
    if (edge.steer === true && edge.to === router) return `edge ${edge.from}→${edge.to} cannot enable steer to the router`;
  }
  return null;
}

export function MeshBuilder({
  store,
  onClose,
  initial,
}: {
  store: Store;
  onClose: (created?: string) => void;
  initial?: MeshConfig;
}) {
  const { t } = useI18n();
  const editing = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [agents, setAgents] = useState<AgentDraft[]>(
    initial?.agents?.length
      ? initial.agents.map((a) => ({ id: a.id, harness: a.harness, role: a.role, project: a.project, effort: a.effort, instructions: a.instructions }))
      : [{ id: "router", harness: "claude", role: "router", project: "test_mesh_0" }],
  );
  const [edges, setEdges] = useState<EdgeDraft[]>(initial ? initial.edges.map((e) => ({ from: e.from, to: e.to, steer: e.steer === true })) : []);
  const [charter, setCharter] = useState(initial?.charter ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setAgent = (i: number, patch: Partial<AgentDraft>) =>
    setAgents((as) => as.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const addAgent = () =>
    setAgents((as) => [...as, { id: `agent-${as.length}`, harness: "codex", role: "member", project: "test_mesh_0" }]);
  const delAgent = (i: number) => setAgents((as) => as.filter((_, j) => j !== i));

  const ids = agents.map((a) => a.id);
  const addEdge = () => setEdges((e) => [...e, { from: ids[0] ?? "", to: ids[1] ?? ids[0] ?? "" }]);
  const setEdge = (i: number, which: 0 | 1, v: string) =>
    setEdges((e) => e.map((edge, j) => (j === i ? (which === 0 ? { ...edge, from: v } : { ...edge, to: v }) : edge)));
  const setEdgeSteer = (i: number, steer: boolean) => setEdges((e) => e.map((edge, j) => (j === i ? { ...edge, steer } : edge)));
  const delEdge = (i: number) => setEdges((e) => e.filter((_, j) => j !== i));

  async function submit() {
    const v = validate(name, agents, edges) ?? (charter.length > 4000 ? "charter is too long (max 4000 chars)" : null);
    if (v) {
      setErr(v);
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const normalizedAgents = agents.map((a) => ({
        ...a,
        instructions: a.instructions?.trim() || undefined,
      }));
      await store.defineMesh({ name, agents: normalizedAgents, edges, charter: charter.trim() || undefined });
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
          <span style={{ flex: 1 }}>{editing ? t("build.edit", { name: initial!.name }) : t("build.define")}</span>
          <Btn small kind="ghost" onClick={() => onClose()}>
            ✕ esc
          </Btn>
        </div>
        <div className="mbody">
          <div className="field">
            <label>{editing ? t("build.name.locked") : t("build.name")}</label>
            <input
              className="inp"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. build-squad"
              autoFocus={!editing}
              readOnly={editing}
            />
          </div>

          <div className="field">
            <label>{t("build.agents")}</label>
            {agents.map((a, i) => (
              <div className="agent-block" key={i}>
                <div className="agrow">
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
                <div className="agrow-adv">
                  <span className="adv-label">{t("effort")}</span>
                  <select
                    className="inp adv-sel"
                    value={a.effort ?? ""}
                    title={t("effort.hint")}
                    onChange={(e) => setAgent(i, { effort: (e.target.value || undefined) as ThinkingEffort | undefined })}
                  >
                    <option value="">{t("effort.default")}</option>
                    <option value="minimal">{t("effort.minimal")}</option>
                    <option value="low">{t("effort.low")}</option>
                    <option value="medium">{t("effort.medium")}</option>
                    <option value="high">{t("effort.high")}</option>
                  </select>
                </div>
                <div className="agent-instructions-field">
                  <label className="adv-label" htmlFor={`agent-${i}-instructions`}>
                    {t("build.instructions")}
                  </label>
                  <textarea
                    id={`agent-${i}-instructions`}
                    className="inp agent-instructions"
                    rows={3}
                    value={a.instructions ?? ""}
                    placeholder={t("build.instructions.placeholder")}
                    onChange={(e) => setAgent(i, { instructions: e.target.value })}
                  />
                </div>
              </div>
            ))}
            <div>
              <Btn small onClick={addAgent}>
                {t("build.addAgent")}
              </Btn>
            </div>
          </div>

          <div className="field">
            <label>{t("build.edges")}</label>
            {edges.map((edge, i) => (
              <div className="row" key={i}>
                <select className="inp" value={edge.from} onChange={(e) => setEdge(i, 0, e.target.value)}>
                  {ids.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
                <span className="sub">→</span>
                <select className="inp" value={edge.to} onChange={(e) => setEdge(i, 1, e.target.value)}>
                  {ids.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
                <label className="check-inline" title={t("build.steer.tooltip")}>
                  <input type="checkbox" checked={edge.steer === true} onChange={(e) => setEdgeSteer(i, e.target.checked)} />
                  {t("build.steer")}
                </label>
                <Btn small kind="ghost" onClick={() => delEdge(i)}>
                  ✕
                </Btn>
              </div>
            ))}
            <div>
              <Btn small onClick={addEdge} disabled={agents.length < 2}>
                {t("build.addEdge")}
              </Btn>
            </div>
          </div>

          <div className="field">
            <label>{t("build.charter")}</label>
            <textarea
              className="inp"
              rows={4}
              value={charter}
              placeholder={"e.g. Goal: build a tiny wordcount CLI.\nNorms: keep it one file, write a test, hand off via send_mail when done."}
              onChange={(e) => setCharter(e.target.value)}
              style={{ resize: "vertical", fontFamily: "var(--mono)" }}
            />
          </div>

          {err ? <div className="err">{err}</div> : null}

          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Btn kind="ghost" onClick={() => onClose()}>
              {t("cancel")}
            </Btn>
            <Btn kind="go" onClick={submit} disabled={busy}>
              {busy ? t("build.saving") : editing ? t("build.save") : t("build.define")}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
