// Right column = the TUI "mesh context" + the PoC three-pane intent, web-enhanced:
// topology, router chat, per-member panels, permission cards, and activity/mail/
// permission-history timelines for the selected mesh.
import { useEffect, useState } from "react";
import type { Store } from "./store";
import type { GatewayState, MeshSummary, PerMeshState, ActivityEntry, MailEntry, ResolvedPermission, PermissionReq } from "../types";
import { Dot, Btn, Composer, Empty, ConfirmButton, fmtTime } from "./ui";
import { Transcript } from "./Transcript";
import { Topology } from "./Topology";

function Header({ m, store, onDeleted, onEdit }: { m: MeshSummary; store: Store; onDeleted: () => void; onEdit: () => void }) {
  const live = m.status === "running" || m.status === "starting";
  return (
    <div className="detail-head">
      <span className="mtitle">{m.name}</span>
      <span className="row">
        <Dot status={m.status} />
        <span className="meta">{m.status}</span>
      </span>
      <span className="meta">router = {m.router}</span>
      <span className="meta">{m.agents.length} agents</span>
      <span style={{ flex: 1 }} />
      {live ? (
        <Btn kind="stop" onClick={() => void store.stopMesh(m.name)}>
          stop mesh
        </Btn>
      ) : (
        <>
          <Btn kind="go" onClick={() => void store.startMesh(m.name)}>
            start mesh
          </Btn>
          <Btn kind="ghost" title="edit this mesh definition" onClick={onEdit}>
            edit
          </Btn>
          <ConfirmButton
            kind="stop"
            confirmLabel="delete?"
            title="delete this mesh definition"
            onConfirm={() => {
              void store.deleteMesh(m.name).then(onDeleted, () => {});
            }}
          >
            delete
          </ConfirmButton>
        </>
      )}
    </div>
  );
}

function PermissionCards({ pending, mesh, store }: { pending: PermissionReq[]; mesh: string; store: Store }) {
  if (!pending.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {pending.map((p) => (
        <div className="perm" key={p.requestId}>
          <div className="ph">
            <span className="warn">⚠ permission</span>
            <span className="meta">{p.agent}</span>
            <span className="q">{p.question}</span>
          </div>
          <div className="opts">
            {p.options.map((o, i) => (
              <span className="opt" key={o.id}>
                <button className="btn sm" onClick={() => void store.resolvePermission(mesh, p.requestId, o.id)}>
                  <span className="num">{i + 1}</span> {o.name}
                </button>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ModeControl({ mesh, agent, store }: { mesh: string; agent: string; store: Store }) {
  const [v, setV] = useState("");
  return (
    <span className="row" style={{ gap: 5 }}>
      <span className="sub" style={{ fontSize: 10 }}>
        mode
      </span>
      <input
        className="inp"
        style={{ width: 110, padding: "1px 6px", fontSize: 11 }}
        value={v}
        placeholder="mode id"
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && v.trim()) {
            void store.setMode(mesh, agent, v.trim());
            setV("");
          }
        }}
      />
    </span>
  );
}

function AgentPanels({
  m,
  pm,
  store,
  active,
  onActivate,
}: {
  m: MeshSummary;
  pm: PerMeshState;
  store: Store;
  active: string | null;
  onActivate: (id: string) => void;
}) {
  const members = m.agents.filter((a) => a.id !== m.router);
  if (!members.length) return <Empty>no member agents</Empty>;
  const cur = members.find((a) => a.id === active) ?? members[0];
  const setTab = onActivate;
  return (
    <div className="panel">
      <div className="head" style={{ padding: 0 }}>
        <div className="tabs">
          {members.map((a) => (
            <span className={`tab ${a.id === cur.id ? "sel" : ""}`} key={a.id} onClick={() => setTab(a.id)}>
              <Dot status={m.status === "running" || m.status === "starting" ? a.status : "stopped"} />
              {a.id}
            </span>
          ))}
        </div>
      </div>
      <div className="scroll-pane">
        <div className="row" style={{ padding: "5px 10px", borderBottom: "1px solid var(--line)" }}>
          <span className="sub">{cur.harness}</span>
          <span style={{ flex: 1 }} />
          {m.status === "running" || m.status === "starting" ? (
            <Btn small kind="stop" title="cancel this agent's current turn" onClick={() => void store.interruptAgent(m.name, cur.id)}>
              interrupt
            </Btn>
          ) : null}
          <ModeControl mesh={m.name} agent={cur.id} store={store} />
        </div>
        <div className="chat">
          <Transcript items={pm.transcripts[cur.id] ?? []} />
          <Composer placeholder={`message ${cur.id}…`} onSend={(t) => void store.promptAgent(m.name, cur.id, t)} />
        </div>
      </div>
    </div>
  );
}

function Timeline({ activity }: { activity: ActivityEntry[] }) {
  if (!activity.length) return <Empty>no activity yet</Empty>;
  return (
    <div className="tl">
      {activity
        .slice()
        .reverse()
        .map((e) => (
          <div className="ent" key={e.id}>
            <span className="ts">{fmtTime(e.ts)}</span>
            <span className={`k ${e.kind}`}>{e.kind === "permission_resolved" ? "perm" : e.kind}</span>
            <span className="tx">{e.text}</span>
          </div>
        ))}
    </div>
  );
}

function Mailbox({ mail }: { mail: MailEntry[] }) {
  if (!mail.length) return <Empty>no mail yet</Empty>;
  return (
    <div className="tl">
      {mail
        .slice()
        .reverse()
        .map((e) => (
          <div className="ent" key={e.id}>
            <span className="ts">{fmtTime(e.ts)}</span>
            <span className="k mail">
              {e.from} → {e.to}
            </span>
            <span className="tx">{e.body}</span>
          </div>
        ))}
    </div>
  );
}

function History({ history }: { history: ResolvedPermission[] }) {
  if (!history.length) return <Empty>no resolved permissions</Empty>;
  return (
    <div className="tl">
      {history
        .slice()
        .reverse()
        .map((e) => (
          <div className="ent" key={e.requestId + e.ts}>
            <span className="ts">{fmtTime(e.ts)}</span>
            <span className="k permission_resolved">{e.by}</span>
            <span className="tx">
              {e.agent} · {e.requestId.slice(0, 8)} → {e.optionId}
            </span>
          </div>
        ))}
    </div>
  );
}

export function MeshDetail({
  state,
  store,
  meshName,
  selectedAgent,
  onSelectAgent,
  fullscreen,
  onToggleFull,
  onDeleted,
  onEdit,
  mobile,
}: {
  state: GatewayState;
  store: Store;
  meshName: string;
  selectedAgent: string | null;
  onSelectAgent: (id: string) => void;
  fullscreen: boolean;
  onToggleFull: () => void;
  onDeleted: () => void;
  onEdit: () => void;
  mobile?: boolean;
}) {
  const m = state.meshes.find((x) => x.name === meshName);
  // a mesh defined after the initial snapshot may not have a perMesh entry yet;
  // synthesize an empty one so its console (topology + empty panels) still renders.
  const pm: PerMeshState =
    state.perMesh[meshName] ?? {
      config: { name: meshName, agents: [], edges: [] },
      transcripts: {},
      activity: [],
      mail: [],
      pending: [],
      history: [],
    };
  // interrupt flash: highlight a node briefly when a new interrupt activity arrives
  const [flashId, setFlashId] = useState<string | null>(null);
  const [seg, setSeg] = useState<"chat" | "agents" | "map" | "log">("chat");
  const lastInterrupt = pm.activity.filter((a) => a.kind === "interrupt").slice(-1)[0];
  useEffect(() => {
    if (!lastInterrupt) return;
    const target = lastInterrupt.text.split("→")[1]?.trim().split(":")[0]?.trim();
    if (!target) return;
    setFlashId(target);
    const t = setTimeout(() => setFlashId(null), 1000);
    return () => clearTimeout(t);
  }, [lastInterrupt?.id]);

  if (!m) return <Empty>select a mesh from the list</Empty>;

  const live = m.status === "running" || m.status === "starting";
  const routerItems = pm.transcripts[m.router] ?? [];
  const routerChat = (
    <div className="panel">
      <div className="head">
        <span className="ttl">router chat</span>
        <span className="sub">{m.router}</span>
        <span className="right">
          {live ? (
            <Btn small kind="stop" title="cancel the router's current turn" onClick={() => void store.interruptAgent(m.name, m.router)}>
              interrupt
            </Btn>
          ) : null}
          {!mobile ? (
            <Btn small kind="ghost" onClick={onToggleFull} title="fullscreen (Ctrl-F)">
              {fullscreen ? "⊟ exit" : "⊞ full"}
            </Btn>
          ) : null}
        </span>
      </div>
      <div className="scroll-pane">
        <div className="chat">
          <Transcript items={routerItems} />
          <Composer placeholder="talk to the router…" onSend={(t) => void store.promptRouter(m.name, t)} />
        </div>
      </div>
    </div>
  );
  const agentPanels = <AgentPanels m={m} pm={pm} store={store} active={selectedAgent} onActivate={onSelectAgent} />;
  const topologyPanel = (
    <div className="panel">
      <div className="head">
        <span className="ttl">topology</span>
        <span className="sub">agents · mail edges</span>
      </div>
      <div className="body-scroll">
        <Topology summary={m} selectedAgent={selectedAgent} onSelect={onSelectAgent} flashId={flashId} />
      </div>
    </div>
  );
  const activityPanel = (
    <div className="panel">
      <div className="head">
        <span className="ttl">activity</span>
        <span className="sub">mail · interrupt · permission · log</span>
      </div>
      <div className="body-scroll" style={{ maxHeight: mobile ? undefined : 240 }}>
        <Timeline activity={pm.activity} />
      </div>
    </div>
  );
  const mailboxPanel = (
    <div className="panel">
      <div className="head">
        <span className="ttl">mailbox</span>
        <span className="sub">inter-agent mail</span>
      </div>
      <div className="body-scroll" style={{ maxHeight: mobile ? undefined : 240 }}>
        <Mailbox mail={pm.mail} />
      </div>
    </div>
  );
  const historyPanel = (
    <div className="panel">
      <div className="head">
        <span className="ttl">permission history</span>
        <span className="sub">{pm.history.length}</span>
      </div>
      <div className="body-scroll" style={{ maxHeight: mobile ? undefined : 200 }}>
        <History history={pm.history} />
      </div>
    </div>
  );
  const permissionEl = <PermissionCards pending={pm.pending} mesh={m.name} store={store} />;

  // ── Mobile: a focused segment switcher (Chat / Agents / Map / Log) with the
  //    permission cards pinned, since they are action-required. ────────────────
  if (mobile) {
    const tab = (key: typeof seg, label: string, badge?: number) => (
      <button className={`mtab ${seg === key ? "sel" : ""}`} onClick={() => setSeg(key)}>
        {label}
        {badge ? <span className="mtab-badge">{badge}</span> : null}
      </button>
    );
    return (
      <div className="mdetail">
        <Header m={m} store={store} onDeleted={onDeleted} onEdit={onEdit} />
        {pm.pending.length ? <div className="mperm">{permissionEl}</div> : null}
        <div className="mseg">
          {seg === "chat" ? routerChat : null}
          {seg === "agents" ? agentPanels : null}
          {seg === "map" ? topologyPanel : null}
          {seg === "log" ? (
            <div className="mlog">
              {activityPanel}
              {mailboxPanel}
              {historyPanel}
            </div>
          ) : null}
        </div>
        <div className="mtabs">
          {tab("chat", "Chat")}
          {tab("agents", "Agents")}
          {tab("map", "Map")}
          {tab("log", "Log")}
        </div>
      </div>
    );
  }

  // ── Desktop ─────────────────────────────────────────────────────────────────
  return (
    <>
      <Header m={m} store={store} onDeleted={onDeleted} onEdit={onEdit} />
      {fullscreen ? (
        <div style={{ flex: 1, minHeight: 360, display: "flex" }}>{routerChat}</div>
      ) : (
        <>
          {topologyPanel}
          {permissionEl}
          <div className="split">
            <div style={{ display: "flex", minHeight: 320 }}>{routerChat}</div>
            <div style={{ display: "flex", minHeight: 320 }}>{agentPanels}</div>
          </div>
          <div className="split">
            {activityPanel}
            {mailboxPanel}
          </div>
          {historyPanel}
        </>
      )}
    </>
  );
}
