// Step 7.1-A/B — new `/bnw/` Runtime A views (overview + focus), wired to the REAL store.
// Independent view layer: this file does NOT import or mutate the old runtime components
// (MeshDetail/ChatPane/Transcript/Topology/MeshCanvas) — it reads the same store/per-mesh
// state and renders fresh views from the C5–C8 component library + v2 tokens.
//
// 7.1-A = read + nav + transcript load. 7.1-B adds the real interactions (mode/model/
// effort/kimi selectors, wake, queue remove, transcript expand toggles, jump-to-bottom,
// composer send/steer/interrupt/new-session, C2 docked approval bar, mesh lifecycle) —
// every one a real store mutation, no fakes (see runtime-controls.tsx). Canvas (#16) and
// live add-agent/edge (#17) remain deferred to 7.1-C.
import { useEffect, useRef, useState } from "react";
import {
  Badge, Cluster, EmptyState, PanelFrame, ProgressBar, RouteLink, Spinner,
  StatusChip, type Status,
} from "../ui/index";
import type { Store } from "../store";
import type { GatewayState, MeshSummary, PerMeshState, TranscriptItem } from "../../types";
import type { AgentStatus, AgentActivity } from "../../../acp/types";
import { bnwHref } from "../router";
import { ApprovalBar, FocusComposer, LifecycleControls, QueueList, RuntimeSelectors, WakeButton } from "./runtime-controls";

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
export function RuntimeOverview({ store, state, mesh }: { store: Store; state: GatewayState; mesh: string }) {
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
      actions={<Cluster className="flex-wrap">
        <StatusChip status={meshDot(summary.status)} variant="soft" label={summary.status} />
        <LifecycleControls store={store} mesh={mesh} status={summary.status} />
        <RouteLink href={bnwHref({ k: "runtime", mesh, canvas: true })} className="text-sm whitespace-nowrap">画布 ↗</RouteLink>
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
                {cold ? <div><WakeButton store={store} mesh={mesh} agent={a.id} /></div> : null}
              </div>
            );
            // cold agents have no live session to focus → no focus link (wake lands in 7.1-B).
            return cold
              ? <div key={a.id}>{inner}</div>
              : <RouteLink key={a.id} href={bnwHref({ k: "runtime", mesh, agent: a.id })} unstyled className="block">{inner}</RouteLink>;
          })}
        </div>
      )}
      <p className="mt-3 text-xs text-text-muted">实时加 agent / 加 edge（#17）接线于 7.1-C。</p>
    </PanelFrame>
  );
}

// ── transcript item rendering (fresh, minimal; not the old Transcript.tsx) ─────
// #14: thought / tool-call / mail / attachment are collapsible (expand toggles).
const clip = (s: string, n = 140) => (s.length > n ? s.slice(0, n) + "…" : s);

export function TranscriptItemView({ it }: { it: TranscriptItem }) {
  const [open, setOpen] = useState(false);
  const Toggle = ({ label }: { label: string }) => (
    <button type="button" data-bnw-expand aria-expanded={open} onClick={() => setOpen((v) => !v)}
      className="inline-flex items-center gap-1 rounded-sm text-left hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring">
      <span aria-hidden="true">{open ? "▾" : "▸"}</span>{label}
    </button>
  );
  switch (it.kind) {
    case "message":
      return (
        <div className={`flex ${it.role === "user" ? "justify-end" : "justify-start"}`}>
          <div className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${it.role === "user" ? "bg-accent-subtle text-text-primary" : "bg-surface-raised text-text-primary"}`}>{it.text}{!it.complete ? <span className="text-text-muted"> ▍</span> : null}</div>
        </div>
      );
    case "thought":
      return (
        <div className="px-1 text-xs italic text-text-muted">
          <Toggle label={`💭 ${open ? "思考" : clip(it.text, 80)}`} />
          {open ? <div className="mt-0.5 whitespace-pre-wrap">{it.text}</div> : null}
        </div>
      );
    case "tool_call":
      return (
        <div className="rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-xs">
          <div className="flex items-center gap-1.5 text-text-secondary"><Toggle label={`🔧 ${it.title}`} /><span className="text-text-muted">· {it.status}</span></div>
          {open ? (
            <div className="mt-1 flex flex-col gap-1">
              {it.input ? <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-text-muted">in: {it.input}</pre> : null}
              {it.output ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-text-muted">out: {it.output}</pre> : null}
              {it.locations?.length ? <div className="text-text-muted">files: {it.locations.join(", ")}</div> : null}
            </div>
          ) : null}
        </div>
      );
    case "mail":
      return (
        <div className="rounded border border-border px-2 py-1 text-xs text-text-secondary">
          <Toggle label={`✉ ${it.from} → ${it.to}`} />
          <div className="mt-0.5 whitespace-pre-wrap text-text-muted">{open ? it.body : clip(it.body)}</div>
        </div>
      );
    case "plan":
      return <div className="rounded border border-border px-2 py-1 text-xs text-text-secondary">📋 plan · {it.entries.length} 步</div>;
    case "attachment":
      return (
        <div className="rounded border border-border px-2 py-1 text-xs text-text-secondary">
          <Toggle label={`📎 ${it.name ?? it.path}`} />
          {open ? <div className="mt-0.5 text-text-muted">{it.path}{it.caption ? ` · ${it.caption}` : ""}</div> : null}
        </div>
      );
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
  const snap = pm?.transcripts[agent];
  const itemCount = snap?.items.length ?? 0;

  // real transcript load path: fetch the initial page once per agent.
  useEffect(() => {
    if (summary && a && !store.isTranscriptInitialLoaded(mesh, agent)) void store.loadInitialTranscript(mesh, agent);
  }, [store, mesh, agent, summary, a]);

  // #15 — jump-to-bottom: track whether the scroll region is pinned to the bottom; keep it
  // pinned as new items arrive, and expose a button to return when scrolled up.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };
  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) { el.scrollTop = el.scrollHeight; setAtBottom(true); }
  };
  useEffect(() => { if (atBottom) scrollToBottom(); }, [itemCount, atBottom]);

  if (!summary || !a) {
    return <PanelFrame title="运行态 · focus"><EmptyState title="agent 不存在" description={`mesh “${mesh}” 没有 agent “${agent}”。`} action={<RouteLink href={bnwHref({ k: "runtime", mesh })}>返回概览</RouteLink>} /></PanelFrame>;
  }

  const loaded = store.isTranscriptInitialLoaded(mesh, agent);
  const queue = pm?.queues[agent];
  const myPending = pm?.pending.filter((p) => p.agent === agent) ?? [];
  const working = a.activity === "working";
  const cold = a.status === "cold";
  const editable = a.status !== "dead"; // can't mutate a dead agent

  const focusColumn = (
    <PanelFrame
      title={`${agent}`}
      description={`${a.harness} · ${a.role} · ${a.status}`}
      actions={<Cluster className="flex-wrap">
        <StatusChip status={agentDot(a.status, a.activity)} variant="dot" />
        {cold ? <WakeButton store={store} mesh={mesh} agent={agent} /> : null}
        <RouteLink href={bnwHref({ k: "runtime", mesh, agent, full: !full })} className="text-sm whitespace-nowrap">{full ? "⊟ 退出全屏" : "⊞ 全屏"}</RouteLink>
        <RouteLink href={bnwHref({ k: "runtime", mesh })} className="text-sm whitespace-nowrap">‹ 概览</RouteLink>
      </Cluster>}
      className="h-full"
      bodyClassName="flex min-h-0 flex-1 flex-col gap-2"
    >
      {/* #10 — real runtime selectors (mode/model/effort/kimi thinking) */}
      <RuntimeSelectors store={store} mesh={mesh} agent={agent} harness={a.harness}
        modes={pm?.modes[agent]} models={pm?.models[agent]} efforts={pm?.efforts[agent]} disabled={!editable} />
      <UsageLine pm={pm} agent={agent} />
      {/* #13 — pending-turn queue is a compact `queued · N` chip at the transcript top
          (not a separate right column); expands inline for prev/next + remove. */}
      {queue?.count ? <div data-bnw-queue-chip className="rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5"><QueueList store={store} mesh={mesh} agent={agent} queue={queue} disabled={!editable} /></div> : null}
      {/* transcript scroll region (relative for the jump-to-bottom affordance) */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} onScroll={onScroll} data-bnw-transcript className="flex flex-1 flex-col gap-2 overflow-auto">
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
        {loaded && !atBottom ? (
          <button type="button" data-bnw-jump onClick={scrollToBottom}
            className="absolute bottom-2 right-2 rounded-full border border-border-strong bg-surface-raised px-3 py-1 text-xs text-text-primary shadow-sm hover:bg-hover">跳到底部 ↓</button>
        ) : null}
      </div>
      {/* C2 — docked approval bar + composer, adjacent at the bottom (never scrolls away) */}
      <ApprovalBar store={store} mesh={mesh} agent={agent} pending={myPending} disabled={!editable} />
      <FocusComposer store={store} mesh={mesh} agent={agent} working={working} disabled={!editable} />
    </PanelFrame>
  );

  if (full) {
    return <div data-bnw-focus="full" className="h-full">{focusColumn}</div>;
  }

  // split: focus column + a SINGLE right context panel `<agent> · activity` (ACTIVITY + MAIL),
  // matching /__ui-mockup?surface=runtime&runtime=focus + coverage/02-runtime.md. Queue lives
  // in the transcript-top chip; the C2 approval is docked above the composer.
  return (
    <div data-bnw-focus="split" className="flex h-full min-h-0 gap-3">
      <div className="min-w-0 flex-1">{focusColumn}</div>
      <aside data-bnw-context className="hidden w-[288px] shrink-0 overflow-auto lg:block">
        <PanelFrame title={`${agent} · activity`} className="h-full" bodyClassName="flex flex-col gap-3">
          <div>
            <div className="mb-1 text-xs uppercase tracking-wider text-text-muted">activity</div>
            <div className="flex flex-col gap-1">
              {(pm?.activity ?? []).slice(-8).reverse().map((e) => (
                <div key={e.id} className="truncate text-xs text-text-muted"><span className="text-text-secondary">{e.kind}</span> · {e.text}</div>
              ))}
              {!pm?.activity?.length ? <p className="text-xs text-text-muted">暂无活动。</p> : null}
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs uppercase tracking-wider text-text-muted">mail</div>
            <div className="flex flex-col gap-1">
              {(pm?.mail ?? []).slice(-8).reverse().map((m) => (
                <div key={m.id} className="truncate text-xs text-text-muted">{m.from} → {m.to}: {m.body}</div>
              ))}
              {!pm?.mail?.length ? <p className="text-xs text-text-muted">暂无邮件。</p> : null}
            </div>
          </div>
        </PanelFrame>
      </aside>
    </div>
  );
}
