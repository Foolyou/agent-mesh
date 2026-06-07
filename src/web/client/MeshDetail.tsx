// Right column = the TUI "mesh context" + the PoC three-pane intent, web-enhanced:
// topology, router chat, per-member panels, permission cards, and activity/mail/
// permission-history timelines for the selected mesh.
import { useEffect, useState } from "react";
import type { Store } from "./store";
import type { GatewayState, MeshSummary, PerMeshState, ActivityEntry, MailEntry, ResolvedPermission, PermissionReq, AgentModes, ThinkingEffort } from "../types";
import { Dot, Btn, Empty, ConfirmButton, InfoIcon, fmtTime } from "./ui";
import { ChatPane } from "./ChatPane";
import { Topology, TopologyModal } from "./Topology";
import { useI18n, tStatus } from "./i18n";

function Header({ m, store, onDeleted, onEdit }: { m: MeshSummary; store: Store; onDeleted: () => void; onEdit: () => void }) {
  const { t } = useI18n();
  const live = m.status === "running" || m.status === "starting";
  return (
    <div className="detail-head">
      <span className="mtitle">{m.name}</span>
      <span className="row">
        <Dot status={m.status} />
        <span className="meta">{tStatus(t, m.status)}</span>
      </span>
      <span className="meta">{t("router")} = {m.router}</span>
      <span className="meta">{t("agents", { n: m.agents.length })}</span>
      <span style={{ flex: 1 }} />
      {live ? (
        <Btn kind="stop" onClick={() => void store.stopMesh(m.name)}>
          {t("stop mesh")}
        </Btn>
      ) : (
        <>
          <Btn kind="go" onClick={() => void store.startMesh(m.name)}>
            {t("start mesh")}
          </Btn>
          <Btn kind="ghost" title={t("edit")} onClick={onEdit}>
            {t("edit")}
          </Btn>
          <ConfirmButton
            kind="stop"
            confirmLabel={t("del.confirm")}
            title={t("del")}
            onConfirm={() => {
              void store.deleteMesh(m.name).then(onDeleted, () => {});
            }}
          >
            {t("del")}
          </ConfirmButton>
        </>
      )}
    </div>
  );
}

function PermissionCards({ pending, mesh, store }: { pending: PermissionReq[]; mesh: string; store: Store }) {
  const { t } = useI18n();
  if (!pending.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {pending.map((p) => (
        <div className="perm" key={p.requestId}>
          <div className="ph">
            <span className="warn">⚠ {t("permission")}</span>
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

// Picker for the agent's ACP session mode (e.g. read-only / full-access / plan). The
// options are exactly the modes the agent advertised; switching calls setSessionMode.
// Renders nothing when the agent exposes no modes — most have none.
function ModeControl({ mesh, agent, store, modes }: { mesh: string; agent: string; store: Store; modes?: AgentModes }) {
  const { t } = useI18n();
  if (!modes || modes.available.length === 0) return null;
  const desc = modes.available.find((m) => m.id === modes.current)?.description;
  return (
    <span className="row" style={{ gap: 5 }}>
      <span className="sub" style={{ fontSize: 10 }}>
        {t("mode")}
      </span>
      <select
        className="mode-sel"
        value={modes.current}
        title={desc ?? t("mode.hint")}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => void store.setMode(mesh, agent, e.target.value)}
      >
        {modes.available.map((m) => (
          <option key={m.id} value={m.id} title={m.description}>
            {m.name}
          </option>
        ))}
      </select>
    </span>
  );
}

const EFFORTS: ThinkingEffort[] = ["minimal", "low", "medium", "high"];

// Per-agent thinking-effort picker. Effort is a launch-time setting (codex flag / claude env),
// so changing it while the mesh runs restarts the mesh to apply; while stopped it just updates
// the persisted config. opencode has no effort mechanism, so the control is hidden for it.
function EffortControl({ m, pm, agent, store }: { m: MeshSummary; pm: PerMeshState; agent: string; store: Store }) {
  const { t } = useI18n();
  const cfg = pm.config;
  const a = cfg.agents.find((x) => x.id === agent);
  if (!a || a.harness === "opencode") return null;
  const live = m.status === "running" || m.status === "starting";
  async function change(value: string) {
    const effort = (value || undefined) as ThinkingEffort | undefined;
    const patched = { ...cfg, agents: cfg.agents.map((x) => (x.id === agent ? { ...x, effort } : x)) };
    if (live) {
      // effort only takes hold at process start — restart the mesh so the new value applies
      await store.stopMesh(m.name);
      await store.defineMesh(patched);
      await store.startMesh(m.name);
    } else {
      await store.defineMesh(patched);
    }
  }
  return (
    <span className="row" style={{ gap: 5 }}>
      <span className="sub" style={{ fontSize: 10 }}>
        {t("effort")}
      </span>
      <select
        className="effort-sel"
        value={a.effort ?? ""}
        title={t("effort.hint")}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => void change(e.target.value)}
      >
        <option value="">{t("effort.default")}</option>
        {EFFORTS.map((eff) => (
          <option key={eff} value={eff}>
            {t(`effort.${eff}`)}
          </option>
        ))}
      </select>
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
  const { t } = useI18n();
  const members = m.agents.filter((a) => a.id !== m.router);
  if (!members.length) return <Empty>{t("empty.members")}</Empty>;
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
          <EffortControl m={m} pm={pm} agent={cur.id} store={store} />
          {m.status === "running" || m.status === "starting" ? (
            <Btn small kind="stop" title={t("interrupt")} onClick={() => void store.interruptAgent(m.name, cur.id)}>
              {t("interrupt")}
            </Btn>
          ) : null}
          {m.status === "running" || m.status === "starting" ? (
            <ModeControl mesh={m.name} agent={cur.id} store={store} modes={pm.modes?.[cur.id]} />
          ) : null}
        </div>
        <ChatPane
          items={pm.transcripts[cur.id] ?? []}
          placeholder={t("agent.placeholder", { id: cur.id })}
          imageEnabled={!!pm.capabilities?.[cur.id]?.image}
          imageDisabledReason="This agent does not advertise image input support"
          onUploadImages={(files) => store.uploadImages(m.name, files)}
          onSend={(msg, images) => void store.promptAgent(m.name, cur.id, msg, images)}
        />
      </div>
    </div>
  );
}

function Timeline({ activity }: { activity: ActivityEntry[] }) {
  const { t } = useI18n();
  if (!activity.length) return <Empty>{t("empty.activity")}</Empty>;
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
  const { t } = useI18n();
  if (!mail.length) return <Empty>{t("empty.mail")}</Empty>;
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
  const { t } = useI18n();
  if (!history.length) return <Empty>{t("empty.history")}</Empty>;
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

// The desktop rail's reference logs as one compact segmented card.
function RailLogs({ pm }: { pm: PerMeshState }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"activity" | "mail" | "history">("activity");
  return (
    <div className="panel">
      <div className="head">
        <span className="seg-tabs">
          <button className={`seg-tab ${tab === "activity" ? "sel" : ""}`} onClick={() => setTab("activity")}>
            {t("tab.activity")}
          </button>
          <button className={`seg-tab ${tab === "mail" ? "sel" : ""}`} onClick={() => setTab("mail")}>
            {t("tab.mail")}
          </button>
          <button className={`seg-tab ${tab === "history" ? "sel" : ""}`} onClick={() => setTab("history")}>
            {t("tab.history")} {pm.history.length ? `· ${pm.history.length}` : ""}
          </button>
        </span>
      </div>
      <div className="body-scroll">
        {tab === "activity" ? <Timeline activity={pm.activity} /> : tab === "mail" ? <Mailbox mail={pm.mail} /> : <History history={pm.history} />}
      </div>
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
      modes: {},
      capabilities: {},
    };
  // interrupt flash: highlight a node briefly when a new interrupt activity arrives
  const { t } = useI18n();
  const [flashId, setFlashId] = useState<string | null>(null);
  const [seg, setSeg] = useState<"chat" | "agents" | "map" | "log">("chat");
  const [topoOpen, setTopoOpen] = useState(false);
  const lastInterrupt = pm.activity.filter((a) => a.kind === "interrupt").slice(-1)[0];
  useEffect(() => {
    if (!lastInterrupt) return;
    const target = lastInterrupt.text.split("→")[1]?.trim().split(":")[0]?.trim();
    if (!target) return;
    setFlashId(target);
    const timer = setTimeout(() => setFlashId(null), 1000);
    return () => clearTimeout(timer);
  }, [lastInterrupt?.id]);

  if (!m) return <Empty>{t("empty.select")}</Empty>;

  const live = m.status === "running" || m.status === "starting";
  const routerItems = pm.transcripts[m.router] ?? [];
  const routerChat = (
    <div className="panel">
      <div className="head">
        <span className="ttl">{t("router chat")}</span>
        <span className="sub">{m.router}</span>
        <span className="right">
          <EffortControl m={m} pm={pm} agent={m.router} store={store} />
          {live ? <ModeControl mesh={m.name} agent={m.router} store={store} modes={pm.modes?.[m.router]} /> : null}
          {live ? (
            <Btn small kind="stop" title={t("interrupt")} onClick={() => void store.interruptAgent(m.name, m.router)}>
              {t("interrupt")}
            </Btn>
          ) : null}
          {!mobile ? (
            <Btn small kind="ghost" onClick={onToggleFull} title={t("full")}>
              {fullscreen ? `⊟ ${t("exit")}` : `⊞ ${t("full")}`}
            </Btn>
          ) : null}
        </span>
      </div>
      <div className="scroll-pane">
        <ChatPane
          items={routerItems}
          placeholder={t("router.placeholder")}
          imageEnabled={!!pm.capabilities?.[m.router]?.image}
          imageDisabledReason="This agent does not advertise image input support"
          onUploadImages={(files) => store.uploadImages(m.name, files)}
          onSend={(msg, images) => void store.promptRouter(m.name, msg, images)}
        />
      </div>
    </div>
  );
  const agentPanels = <AgentPanels m={m} pm={pm} store={store} active={selectedAgent} onActivate={onSelectAgent} />;
  const topologyPanel = (
    <div className="panel">
      <div className="head">
        <span className="ttl">{t("topology")}</span>
        <span className="right">
          <InfoIcon text={t("topology.sub")} />
          <Btn small kind="ghost" title={t("topology")} onClick={() => setTopoOpen(true)}>
            ⤢
          </Btn>
        </span>
      </div>
      <div className="body-scroll">
        <Topology summary={m} selectedAgent={selectedAgent} onSelect={onSelectAgent} flashId={flashId} />
      </div>
    </div>
  );
  const topoModal = topoOpen ? (
    <TopologyModal summary={m} selectedAgent={selectedAgent} onSelect={onSelectAgent} onClose={() => setTopoOpen(false)} />
  ) : null;
  const activityPanel = (
    <div className="panel">
      <div className="head">
        <span className="ttl">{t("activity")}</span>
        <span className="right">
          <InfoIcon text={t("activity.sub")} />
        </span>
      </div>
      <div className="body-scroll" style={{ maxHeight: mobile ? undefined : 240 }}>
        <Timeline activity={pm.activity} />
      </div>
    </div>
  );
  const mailboxPanel = (
    <div className="panel">
      <div className="head">
        <span className="ttl">{t("mailbox")}</span>
        <span className="right">
          <InfoIcon text={t("mailbox.sub")} />
        </span>
      </div>
      <div className="body-scroll" style={{ maxHeight: mobile ? undefined : 240 }}>
        <Mailbox mail={pm.mail} />
      </div>
    </div>
  );
  const historyPanel = (
    <div className="panel">
      <div className="head">
        <span className="ttl">{t("permission history")}</span>
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
        {topoModal}
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
          {tab("chat", t("seg.chat"))}
          {tab("agents", t("seg.agents"))}
          {tab("map", t("seg.map"))}
          {tab("log", t("seg.log"))}
        </div>
      </div>
    );
  }

  // ── Desktop: fixed-viewport grid — chat dominant (left), glance + logs (right
  //    rail), permissions span above. The page never scrolls; regions do. ──────
  const railTopology = (
    <div className="panel">
      <div className="head">
        <span className="ttl">topology</span>
        <span className="sub">agents · mail edges</span>
        <span className="right">
          <Btn small kind="ghost" title="expand topology" onClick={() => setTopoOpen(true)}>
            ⤢
          </Btn>
        </span>
      </div>
      <div className="body-scroll">
        <Topology summary={m} selectedAgent={selectedAgent} onSelect={onSelectAgent} flashId={flashId} maxHeight={230} />
      </div>
    </div>
  );
  return (
    <div className="dgrid">
      <Header m={m} store={store} onDeleted={onDeleted} onEdit={onEdit} />
      {topoModal}
      {pm.pending.length ? <div className="dperm">{permissionEl}</div> : null}
      {fullscreen ? (
        <div className="dmain full">{routerChat}</div>
      ) : (
        <div className="dmain">
          <div className="dchat">
            {routerChat}
            {agentPanels}
          </div>
          <div className="drail">
            {railTopology}
            <RailLogs pm={pm} />
          </div>
        </div>
      )}
    </div>
  );
}
