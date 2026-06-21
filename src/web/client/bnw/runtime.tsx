// Step 7.1-A — new `/bnw/` Runtime A views (overview + focus), wired to the REAL store.
// Independent view layer: this file does NOT import or mutate the old runtime components
// (MeshDetail/ChatPane/Transcript/Topology/MeshCanvas) — it reads the same store/per-mesh
// state and renders fresh views from the C5–C8 component library + v2 tokens.
//
// 7.1-A is READ + navigation + the transcript load path (real). All MUTATIONS
// (start/stop, mode/model/effort, wake, interrupt, new-session, queue remove, approvals,
// canvas physics) are deferred to 7.1-B/C — they are surfaced read-only or marked, never
// faked. See docs/design/ui/step7-routing-plan.md §2 7.1.
import { useEffect } from "react";
import {
  Badge, Cluster, EmptyState, PanelFrame, ProgressBar, RouteLink, Spinner,
  StatusChip, type Status,
} from "../ui/index";
import type { Store } from "../store";
import type { GatewayState, MeshSummary, PerMeshState, TranscriptItem } from "../../types";
import type { AgentStatus, AgentActivity } from "../../../acp/types";
import { bnwHref } from "../router";

// ── status mapping (gateway vocab → C5 StatusChip vocab) ──────────────────────
function agentDot(status: AgentStatus, activity: AgentActivity): Status {
  switch (status) {
    case "ready": return activity === "working" ? "working" : "ready";
    case "spawning": return "attention";
    case "dead": return "blocked";
    case "cold": case "stopped": default: return "idle";
  }
}
function meshDot(s: MeshSummary["status"]): Status {
  switch (s) {
    case "running": return "working";
    case "starting": return "attention";
    case "dead": return "blocked";
    case "stopped": default: return "idle";
  }
}

function pendingFor(pm: PerMeshState | undefined, agent: string): number {
  return pm?.pending.filter((p) => p.agent === agent).length ?? 0;
}

// Context/cost waterline (#12) — read-only from usage_update fold.
function UsageLine({ pm, agent }: { pm: PerMeshState | undefined; agent: string }) {
  const u = pm?.usage[agent];
  if (!u?.used || !u.size) return null;
  const pct = Math.round((u.used / u.size) * 100);
  return (
    <div className="flex flex-col gap-0.5">
      <ProgressBar value={u.used} max={u.size} label={`context ${pct}%`} />
      <span className="text-xs tabular-nums text-text-muted">{pct}% context{u.cost != null ? ` · $${u.cost.toFixed(2)}` : ""}</span>
    </div>
  );
}

// ── overview: /bnw/mesh/<id> ──────────────────────────────────────────────────
export function RuntimeOverview({ state, mesh }: { store: Store; state: GatewayState; mesh: string }) {
  const summary = state.meshes.find((m) => m.name === mesh);
  const pm = state.perMesh[mesh];
  if (!summary) {
    return <PanelFrame title="运行态 A"><EmptyState title="mesh 不存在" description={`没有名为 “${mesh}” 的 mesh。`} action={<RouteLink href={bnwHref({ k: "home" })}>返回</RouteLink>} /></PanelFrame>;
  }
  const pending = pm?.pending.length ?? 0;
  return (
    <PanelFrame
      title={`运行态 · ${summary.name}`}
      description={`${summary.agents.length} agents · ${pending} 待审批`}
      actions={<Cluster>
        <StatusChip status={meshDot(summary.status)} variant="soft" label={summary.status} />
        <RouteLink href={bnwHref({ k: "runtime", mesh, canvas: true })} className="text-sm">画布 ↗</RouteLink>
      </Cluster>}
    >
      {summary.agents.length === 0 ? (
        <EmptyState title="无 agent" description="这个 mesh 还没有 agent。" />
      ) : (
        <div data-bnw-agents className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {summary.agents.map((a) => {
            const cold = a.status === "cold";
            const np = pendingFor(pm, a.id);
            const health = pm?.health[a.id];
            const sa = pm?.selfAwareness[a.id];
            const inner = (
              <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-raised p-2.5">
                <div className="flex items-center gap-1.5">
                  <StatusChip status={agentDot(a.status, a.activity)} variant="dot" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{a.id}</span>
                  {np > 0 ? <Badge count={np} tone="urgent" /> : null}
                </div>
                <div className="text-xs text-text-muted">{a.harness} · {a.role} · {a.status}{a.activity === "working" ? " · working" : ""}</div>
                <UsageLine pm={pm} agent={a.id} />
                {health?.signal && health.signal !== "compact_done" ? <span className="text-xs text-warning">⚠ {health.signal}</span> : null}
                {sa?.silentTaskCompletes?.count ? <span className="text-xs text-warning">静默完成 ×{sa.silentTaskCompletes.count}</span> : null}
                {cold ? <span className="text-xs text-text-muted">cold — 唤醒控件接线于 7.1-B</span> : null}
              </div>
            );
            // cold agents have no live session to focus → no focus link (wake lands in 7.1-B).
            return cold
              ? <div key={a.id}>{inner}</div>
              : <RouteLink key={a.id} href={bnwHref({ k: "runtime", mesh, agent: a.id })} unstyled className="block">{inner}</RouteLink>;
          })}
        </div>
      )}
      <p className="mt-3 text-xs text-text-muted">启停 / 启动策略 / 加 agent·edge 等变更控件接线于 7.1-B（本切片只读，不伪造 store 变更）。</p>
    </PanelFrame>
  );
}

// ── transcript item rendering (fresh, minimal; not the old Transcript.tsx) ─────
function TranscriptItemView({ it }: { it: TranscriptItem }) {
  switch (it.kind) {
    case "message":
      return (
        <div className={`flex ${it.role === "user" ? "justify-end" : "justify-start"}`}>
          <div className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${it.role === "user" ? "bg-accent-subtle text-text-primary" : "bg-surface-raised text-text-primary"}`}>{it.text}{!it.complete ? <span className="text-text-muted"> ▍</span> : null}</div>
        </div>
      );
    case "thought":
      return <div className="px-1 text-xs italic text-text-muted">💭 {it.text}</div>;
    case "tool_call":
      return (
        <div className="rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-xs">
          <div className="flex items-center gap-1.5"><span className="font-medium text-text-secondary">🔧 {it.title}</span><span className="text-text-muted">· {it.status}</span></div>
          {it.output ? <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-text-muted">{it.output}</pre> : null}
        </div>
      );
    case "mail":
      return <div className="rounded border border-border px-2 py-1 text-xs text-text-secondary">✉ {it.from} → {it.to}: <span className="text-text-muted">{it.body}</span></div>;
    case "plan":
      return <div className="rounded border border-border px-2 py-1 text-xs text-text-secondary">📋 plan · {it.entries.length} 步</div>;
    case "attachment":
      return <div className="rounded border border-border px-2 py-1 text-xs text-text-secondary">📎 {it.name ?? it.path}</div>;
    case "compact":
      return <div className="text-center text-xs text-text-muted">— compact {it.status} —</div>;
    case "divider":
      return <div className="text-center text-xs text-text-muted">— {it.label} —</div>;
    default:
      return null;
  }
}

// ── focus: /bnw/mesh/<id>/agent/<agentId> (?full=1) ───────────────────────────
export function RuntimeFocus({ store, state, mesh, agent, full }: { store: Store; state: GatewayState; mesh: string; agent: string; full: boolean }) {
  const summary = state.meshes.find((m) => m.name === mesh);
  const pm = state.perMesh[mesh];
  const a = summary?.agents.find((x) => x.id === agent);

  // real transcript load path (read-only): fetch the initial page once per agent.
  useEffect(() => {
    if (summary && a && !store.isTranscriptInitialLoaded(mesh, agent)) void store.loadInitialTranscript(mesh, agent);
  }, [store, mesh, agent, summary, a]);

  if (!summary || !a) {
    return <PanelFrame title="运行态 · focus"><EmptyState title="agent 不存在" description={`mesh “${mesh}” 没有 agent “${agent}”。`} action={<RouteLink href={bnwHref({ k: "runtime", mesh })}>返回概览</RouteLink>} /></PanelFrame>;
  }

  const snap = pm?.transcripts[agent];
  const loaded = store.isTranscriptInitialLoaded(mesh, agent);
  const model = pm?.models[agent]?.current;
  const mode = pm?.modes[agent]?.current;
  const effort = pm?.efforts[agent]?.current;
  const queue = pm?.queues[agent];
  const myPending = pm?.pending.filter((p) => p.agent === agent) ?? [];

  const transcript = (
    <PanelFrame
      title={`${agent}`}
      description={`${a.harness} · ${a.role} · ${a.status}`}
      actions={<Cluster>
        <StatusChip status={agentDot(a.status, a.activity)} variant="dot" />
        <RouteLink href={bnwHref({ k: "runtime", mesh, agent, full: !full })} className="text-sm">{full ? "⊟ 退出全屏" : "⊞ 全屏"}</RouteLink>
        <RouteLink href={bnwHref({ k: "runtime", mesh })} className="text-sm">‹ 概览</RouteLink>
      </Cluster>}
      bodyClassName="flex flex-col gap-2"
    >
      {/* read-only runtime selectors (mutation wiring lands in 7.1-B) */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        {model ? <span className="rounded border border-border px-1.5 py-0.5">model: {model}</span> : null}
        {mode ? <span className="rounded border border-border px-1.5 py-0.5">mode: {mode}</span> : null}
        {effort ? <span className="rounded border border-border px-1.5 py-0.5">effort: {effort}</span> : null}
        <span className="text-text-muted">· 选择器/唤醒/打断/新会话接线于 7.1-B</span>
      </div>
      <UsageLine pm={pm} agent={agent} />
      <div data-bnw-transcript className="flex flex-1 flex-col gap-2 overflow-auto">
        {!loaded ? (
          <div className="flex items-center gap-2 text-sm text-text-muted"><Spinner size={14} label="loading transcript" /> 载入转写…</div>
        ) : !snap || snap.items.length === 0 ? (
          <EmptyState title="暂无消息" description="该 agent 还没有转写记录。" />
        ) : (
          <>
            {snap.hasMore ? <button type="button" onClick={() => void store.loadOlderTranscript(mesh, agent)} className="self-center rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-xs text-text-primary hover:bg-hover">载入更早</button> : null}
            {snap.items.map((it) => <TranscriptItemView key={it.id} it={it} />)}
          </>
        )}
      </div>
      <p className="border-t border-border pt-2 text-xs text-text-muted">输入框 / 审批条（C2）/ 展开切换 / 跳到底部接线于 7.1-B（不伪造发送）。</p>
    </PanelFrame>
  );

  if (full) {
    return <div data-bnw-focus="full" className="h-full">{transcript}</div>;
  }

  // split: transcript + side summaries (activity / mail / pending / queue), all real reads.
  return (
    <div data-bnw-focus="split" className="flex h-full min-h-0 gap-3">
      <div className="min-w-0 flex-1">{transcript}</div>
      <aside className="hidden w-[300px] shrink-0 flex-col gap-3 overflow-auto lg:flex">
        <PanelFrame title="待审批" description={myPending.length ? undefined : "无"}>
          {myPending.length === 0 ? <p className="text-xs text-text-muted">没有待处理的审批。</p> : myPending.map((p) => (
            <div key={p.requestId} className="mb-1 rounded border border-border px-2 py-1 text-xs text-text-secondary">{p.question}</div>
          ))}
          {myPending.length ? <p className="mt-1 text-xs text-text-muted">就地批准接线于 7.1-B（C2 docked bar）。</p> : null}
        </PanelFrame>
        <PanelFrame title="队列" description={queue?.count ? `${queue.count} 排队` : "空"}>
          {queue?.latestPreview ? <p className="truncate text-xs text-text-secondary">下一条：{queue.latestPreview}</p> : <p className="text-xs text-text-muted">无排队 prompt。</p>}
        </PanelFrame>
        <PanelFrame title="活动">
          <div className="flex flex-col gap-1">
            {(pm?.activity ?? []).slice(-6).reverse().map((e) => (
              <div key={e.id} className="truncate text-xs text-text-muted"><span className="text-text-secondary">{e.kind}</span> · {e.text}</div>
            ))}
            {!pm?.activity?.length ? <p className="text-xs text-text-muted">暂无活动。</p> : null}
          </div>
        </PanelFrame>
        <PanelFrame title="邮件">
          <div className="flex flex-col gap-1">
            {(pm?.mail ?? []).slice(-6).reverse().map((m) => (
              <div key={m.id} className="truncate text-xs text-text-muted">{m.from} → {m.to}: {m.body}</div>
            ))}
            {!pm?.mail?.length ? <p className="text-xs text-text-muted">暂无邮件。</p> : null}
          </div>
        </PanelFrame>
      </aside>
    </div>
  );
}
