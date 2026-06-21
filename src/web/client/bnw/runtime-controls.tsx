// Step 7.1-B — interactive runtime controls for the new /bnw focus/overview views.
// EVERY action here calls a REAL store mutation (no fakes). Independent view layer: shared
// store only; no old view component (MeshDetail/ChatPane/…) imported. Pure harness logic is
// reused from ../../harness-utils (a shared util module, not a view).
import { useState } from "react";
import { Button, Composer, ConfirmButton, Input, Select, Textarea } from "../ui/index";
import type { Store } from "../store";
import type { AgentModes, AgentModels, AgentEfforts, PermissionReq, QueueSummary, MeshSummary, StartSessionStrategy } from "../../types";
import type { HarnessId, AgentRole } from "../../../acp/types";
import { supportsRuntimeEffort, supportsThinkingToggle, kimiThinkingEnabled, kimiModelForThinking } from "../../../harness-utils";

const HARNESSES: HarnessId[] = ["claude", "codex", "opencode", "kimi"];

// Small busy wrapper for any mutation promise (the store already toasts errors via guard()).
function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (p: Promise<unknown>) => { setBusy(true); try { await p; } finally { setBusy(false); } };
  return { busy, run };
}

// #10 — per-agent runtime selectors (mode / model / effort / kimi-thinking), real mutations.
export function RuntimeSelectors({ store, mesh, agent, harness, modes, models, efforts, disabled }: {
  store: Store; mesh: string; agent: string; harness: HarnessId;
  modes?: AgentModes; models?: AgentModels; efforts?: AgentEfforts; disabled: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const set = async (which: string, p: Promise<{ error?: string }>) => {
    setBusy(which);
    try { await p; } finally { setBusy(null); }
  };
  const showEffort = supportsRuntimeEffort(harness) && (efforts?.available?.length ?? 0) > 0;
  const showThinking = supportsThinkingToggle(harness);
  return (
    <div data-bnw-selectors className="flex flex-wrap items-center gap-2 text-xs">
      {(modes?.available?.length ?? 0) > 0 ? (
        <label className="inline-flex items-center gap-1 text-text-muted">mode
          <Select aria-label={`${agent} mode`} value={modes!.current} disabled={disabled || busy === "mode"} className="w-28"
            onChange={(e) => void set("mode", store.setMode(mesh, agent, e.target.value))}>
            {modes!.available.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </label>
      ) : null}
      {(models?.available?.length ?? 0) > 0 ? (
        <label className="inline-flex items-center gap-1 text-text-muted">model
          <Select aria-label={`${agent} model`} value={models!.current} disabled={disabled || busy === "model"} className="w-32"
            onChange={(e) => void set("model", store.setModel(mesh, agent, e.target.value))}>
            {models!.available.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </label>
      ) : null}
      {showEffort ? (
        <label className="inline-flex items-center gap-1 text-text-muted">effort
          <Select aria-label={`${agent} effort`} value={efforts!.current} disabled={disabled || busy === "effort"} className="w-24"
            onChange={(e) => void set("effort", store.setEffort(mesh, agent, e.target.value))}>
            {efforts!.available.map((ef) => <option key={ef.id} value={ef.id}>{ef.name}</option>)}
          </Select>
        </label>
      ) : null}
      {showThinking ? (
        <label className="inline-flex items-center gap-1.5 text-text-secondary">
          <input type="checkbox" aria-label={`${agent} kimi thinking`} className="accent-accent"
            checked={kimiThinkingEnabled(models?.current)} disabled={disabled || busy === "thinking" || !models?.current}
            onChange={(e) => { const next = kimiModelForThinking(models!.current, e.target.checked); void set("thinking", store.setModel(mesh, agent, next)); }} />
          thinking
        </label>
      ) : null}
    </div>
  );
}

// #11 — wake a cold/lazy agent (real mutation).
export function WakeButton({ store, mesh, agent, disabled }: { store: Store; mesh: string; agent: string; disabled?: boolean }) {
  const { busy, run } = useBusy();
  return <Button size="sm" variant="secondary" busy={busy} disabled={disabled} aria-label={`wake ${agent}`}
    onClick={() => void run(store.wakeAgent(mesh, agent))}>Wake</Button>;
}

// Composer — real text send (steer when the agent is working, else prompt) + interrupt +
// new-session (two-click). No mock mutations.
export function FocusComposer({ store, mesh, agent, working, disabled }: { store: Store; mesh: string; agent: string; working: boolean; disabled: boolean }) {
  const [text, setText] = useState("");
  const { busy, run } = useBusy();
  const send = async () => {
    const t = text.trim();
    if (!t || busy || disabled) return;
    await run(working ? store.steerAgent(mesh, agent, t) : store.promptAgent(mesh, agent, t));
    setText("");
  };
  return (
    <Composer
      ariaLabel="Message composer"
      actions={<div className="flex items-center gap-2">
        <ConfirmButton size="sm" variant="ghost" confirmLabel="新会话?（重置该 agent 会话）" disabled={disabled} aria-label={`new session ${agent}`} onConfirm={() => void run(store.newAgentSession(mesh, agent))}>新会话</ConfirmButton>
        {working ? <Button size="sm" variant="ghost" disabled={disabled} aria-label={`interrupt ${agent}`} onClick={() => void run(store.interruptAgent(mesh, agent))}>打断</Button> : null}
        <Button size="sm" variant="primary" busy={busy} disabled={disabled || !text.trim()} aria-label="send" onClick={() => void send()}>{working ? "Steer" : "Send"}</Button>
      </div>}
      hint={working ? "agent 正在工作 — 发送将作为 steer 插入" : undefined}
    >
      <Textarea aria-label="message input" rows={2} value={text} disabled={disabled}
        placeholder={`给 ${agent} 发消息…`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
    </Composer>
  );
}

// C2 — docked composer-adjacent approval bar. FIFO: only the OLDEST pending for this agent
// renders, the rest summarized as 「还有 N 个待授权」. resolvePermission is the real mutation.
export function ApprovalBar({ store, mesh, agent, pending, disabled }: { store: Store; mesh: string; agent: string; pending: PermissionReq[]; disabled: boolean }) {
  const { busy, run } = useBusy();
  if (pending.length === 0) return null;
  const oldest = pending[0]; // store keeps pending in arrival order (FIFO)
  return (
    <div data-bnw-approval className="flex flex-col gap-1.5 border-t border-border bg-surface-raised px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-muted">⚠ 待授权（最早一条）</span>
        {pending.length > 1 ? <span data-bnw-approval-queue className="rounded-full bg-warning-subtle px-2 py-0.5 text-xs font-medium text-warning">还有 {pending.length - 1} 个待授权</span> : null}
      </div>
      <div className="max-h-44 overflow-auto text-sm text-text-primary">{oldest.question}</div>
      <div className="flex flex-wrap gap-2">
        {oldest.options.map((o) => (
          <Button key={o.id} size="sm" variant={/allow|approve|yes/i.test(o.id + o.name) ? "primary" : "secondary"} busy={busy} disabled={disabled}
            aria-label={`resolve ${o.id}`} onClick={() => void run(store.resolvePermission(mesh, oldest.requestId, o.id))}>{o.name || o.id}</Button>
        ))}
      </div>
    </div>
  );
}

// #13 — pending-turn queue: list + remove (real removeQueuedTurn). Nav is reading the list.
export function QueueList({ store, mesh, agent, queue, disabled }: { store: Store; mesh: string; agent: string; queue?: QueueSummary; disabled: boolean }) {
  const { busy, run } = useBusy();
  const items = queue?.items ?? [];
  if (!queue?.count) return <p className="text-xs text-text-muted">无排队 prompt。</p>;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-xs text-text-muted"><span aria-hidden="true">↕</span> queued · {queue.count}</div>
      {items.length === 0 ? (
        <p className="truncate text-xs text-text-secondary">下一条：{queue.latestPreview}</p>
      ) : items.map((it) => (
        <div key={it.id} className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">{it.preview}</span>
          <Button size="sm" variant="ghost" iconOnly busy={busy} disabled={disabled} aria-label={`remove queued ${it.id}`}
            onClick={() => void run(store.removeQueuedTurn(mesh, agent, it.id))}>×</Button>
        </div>
      ))}
    </div>
  );
}

// #18 — mesh lifecycle: start (resume/fresh) / stop / new-all-sessions (real mutations).
export function LifecycleControls({ store, mesh, status }: { store: Store; mesh: string; status: MeshSummary["status"] }) {
  const { busy, run } = useBusy();
  const [strategy, setStrategy] = useState<StartSessionStrategy>("resume");
  const running = status === "running" || status === "starting";
  return (
    <div data-bnw-lifecycle className="flex flex-wrap items-center gap-2">
      {!running ? (
        <>
          <label className="inline-flex items-center gap-1 text-xs text-text-muted">start
            <Select aria-label="start strategy" value={strategy} className="w-24" onChange={(e) => setStrategy(e.target.value as StartSessionStrategy)}>
              <option value="resume">resume</option><option value="fresh">fresh</option>
            </Select>
          </label>
          <Button size="sm" variant="primary" busy={busy} aria-label={`start ${mesh}`} onClick={() => void run(store.startMesh(mesh, strategy))}>Start</Button>
        </>
      ) : (
        <>
          <ConfirmButton size="sm" variant="danger" confirmLabel="停止?" aria-label={`stop ${mesh}`} onConfirm={() => void run(store.stopMesh(mesh))}>Stop</ConfirmButton>
          <ConfirmButton size="sm" variant="secondary" confirmLabel="重置所有会话?" aria-label={`new all sessions ${mesh}`} onConfirm={() => void run(store.newAllSessions(mesh))}>新建全部会话</ConfirmButton>
        </>
      )}
    </div>
  );
}

// #17 — live add agent / add edge to a running mesh (real addAgent / addEdge mutations).
export function TopologyEditor({ store, mesh, agentIds, disabled }: { store: Store; mesh: string; agentIds: string[]; disabled: boolean }) {
  const { busy, run } = useBusy();
  const [tab, setTab] = useState<"agent" | "edge" | null>(null);
  // add-agent fields
  const [id, setId] = useState(""); const [harness, setHarness] = useState<HarnessId>("claude");
  const [project, setProject] = useState(""); const [role, setRole] = useState<AgentRole>("member");
  // add-edge fields
  const [from, setFrom] = useState(agentIds[0] ?? ""); const [to, setTo] = useState(agentIds[1] ?? agentIds[0] ?? "");
  const [steer, setSteer] = useState(false);

  const addAgent = async () => {
    if (!id.trim() || !project.trim() || busy) return;
    await run(store.addAgent(mesh, { id: id.trim(), harness, project: project.trim(), role }));
    setId(""); setProject("");
  };
  const addEdge = async () => {
    if (!from || !to || from === to || busy) return;
    await run(store.addEdge(mesh, { from, to, steer }));
  };

  return (
    <div data-bnw-topology className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" disabled={disabled} aria-label="add agent" onClick={() => setTab((t) => (t === "agent" ? null : "agent"))}>+ agent</Button>
        <Button size="sm" variant="secondary" disabled={disabled} aria-label="add edge" onClick={() => setTab((t) => (t === "edge" ? null : "edge"))}>+ edge</Button>
      </div>
      {tab === "agent" ? (
        <div data-bnw-add-agent className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-surface-sunken p-2">
          <Input aria-label="new agent id" placeholder="agent id" value={id} disabled={disabled} className="w-32" onChange={(e) => setId(e.target.value)} />
          <Select aria-label="new agent harness" value={harness} disabled={disabled} className="w-28" onChange={(e) => setHarness(e.target.value as HarnessId)}>{HARNESSES.map((h) => <option key={h} value={h}>{h}</option>)}</Select>
          <Input aria-label="new agent project" placeholder="project path" value={project} disabled={disabled} className="w-40" onChange={(e) => setProject(e.target.value)} />
          <Select aria-label="new agent role" value={role} disabled={disabled} className="w-24" onChange={(e) => setRole(e.target.value as AgentRole)}><option value="member">member</option><option value="router">router</option></Select>
          <Button size="sm" variant="primary" busy={busy} disabled={disabled || !id.trim() || !project.trim()} aria-label="confirm add agent" onClick={() => void addAgent()}>添加</Button>
        </div>
      ) : null}
      {tab === "edge" ? (
        <div data-bnw-add-edge className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-surface-sunken p-2">
          <Select aria-label="new edge from" value={from} disabled={disabled} className="w-28" onChange={(e) => setFrom(e.target.value)}>{agentIds.map((a) => <option key={a} value={a}>{a}</option>)}</Select>
          <span aria-hidden="true" className="text-text-muted">→</span>
          <Select aria-label="new edge to" value={to} disabled={disabled} className="w-28" onChange={(e) => setTo(e.target.value)}>{agentIds.map((a) => <option key={a} value={a}>{a}</option>)}</Select>
          <label className="inline-flex items-center gap-1 text-xs text-text-secondary"><input type="checkbox" className="accent-accent" aria-label="new edge steer" checked={steer} disabled={disabled} onChange={(e) => setSteer(e.target.checked)} /> steer</label>
          <Button size="sm" variant="primary" busy={busy} disabled={disabled || from === to} aria-label="confirm add edge" onClick={() => void addEdge()}>添加</Button>
        </div>
      ) : null}
    </div>
  );
}
