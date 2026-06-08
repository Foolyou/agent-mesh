// Right column = the TUI "mesh context" + the PoC three-pane intent, web-enhanced:
// topology, unified conversation tabs, permission cards, and activity/mail/
// permission-history timelines for the selected mesh.
import { useEffect, useRef, useState } from "react";
import type { Store } from "./store";
import type { GatewayState, MeshSummary, PerMeshState, ActivityEntry, MailEntry, ResolvedPermission, PermissionReq, AgentModes, AgentModels, ThinkingEffort } from "../types";
import { Dot, Btn, Empty, ConfirmButton, InfoIcon, fmtTime } from "./ui";
import { ChatPane } from "./ChatPane";
import { MeshCanvas } from "./MeshCanvas";
import { Topology } from "./Topology";
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

function ModelControl({ mesh, agent, store, models }: { mesh: string; agent: string; store: Store; models?: AgentModels }) {
  const { t } = useI18n();
  if (!models || models.available.length === 0) return null;
  return (
    <span className="row" style={{ gap: 5 }}>
      <span className="sub" style={{ fontSize: 10 }}>
        {t("model")}
      </span>
      <select
        className="model-sel"
        value={models.current}
        title={t("model.hint")}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => void store.setModel(mesh, agent, e.target.value)}
      >
        {models.available.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </span>
  );
}

const EFFORTS: ThinkingEffort[] = ["minimal", "low", "medium", "high"];

// Per-agent thinking-effort picker. Effort is a launch-time setting, so it's editable only while
// the mesh is STOPPED (the choice persists and applies on next start); while running it's shown
// read-only. opencode/kimi have no mechanism, so the control is hidden for them.
function EffortControl({ m, agent, store }: { m: MeshSummary; agent: string; store: Store }) {
  const { t } = useI18n();
  const a = m.agents.find((x) => x.id === agent);
  if (!a || a.harness === "opencode" || a.harness === "kimi") return null;
  const live = m.status === "running" || m.status === "starting";
  return (
    <span className="row" style={{ gap: 5 }}>
      <span className="sub" style={{ fontSize: 10 }}>
        {t("effort")}
      </span>
      <select
        className="effort-sel"
        value={a.effort ?? ""}
        disabled={live}
        title={live ? t("effort.hint.live") : t("effort.hint")}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => void store.setEffort(m.name, agent, (e.target.value || undefined) as ThinkingEffort | undefined)}
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

function ConversationPanel({
  m,
  pm,
  store,
  active,
  onActivate,
  fullscreen,
  onToggleFull,
  mobile,
}: {
  m: MeshSummary;
  pm: PerMeshState;
  store: Store;
  active: string | null;
  onActivate: (id: string) => void;
  fullscreen: boolean;
  onToggleFull: () => void;
  mobile?: boolean;
}) {
  const { t } = useI18n();
  const live = m.status === "running" || m.status === "starting";
  const router = m.agents.find((a) => a.id === m.router) ?? m.agents[0];
  const members = m.agents.filter((a) => a.id !== m.router);
  const cur = m.agents.find((a) => a.id === active) ?? router;
  const activeId = cur?.id ?? m.router;
  const isRouter = activeId === m.router;
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (activeId === m.router) return;
    tabRefs.current[activeId]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, m.router]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  if (!cur) return <Empty>{t("empty.members")}</Empty>;
  const statusOf = (id: string) => (live ? (m.agents.find((a) => a.id === id)?.status ?? "stopped") : "stopped");
  const activate = (id: string) => {
    onActivate(id);
    setMenuOpen(false);
  };
  return (
    <div className="panel conv-panel">
      <div className="head conv-head">
        <span className="ttl">{t("conversation")}</span>
        <span className="sub">{activeId}</span>
      </div>
      <div className="tabs conv-tabs">
        <button className={`tab conv-router-tab ${isRouter ? "sel" : ""}`} onClick={() => activate(m.router)}>
          <span className="pin">📌</span>
          <Dot status={statusOf(m.router)} />
          <span>{m.router}</span>
        </button>
        <div className="conv-member-strip">
          {members.map((a) => (
            <button
              className={`tab conv-member-tab ${a.id === activeId ? "sel" : ""}`}
              key={a.id}
              ref={(el) => {
                tabRefs.current[a.id] = el;
              }}
              onClick={() => activate(a.id)}
            >
              <Dot status={statusOf(a.id)} />
              {a.id}
            </button>
          ))}
        </div>
        <div className="conv-overflow" ref={menuRef}>
          <button className="tab conv-overflow-btn" onClick={() => setMenuOpen((o) => !o)} title={t("tabs.allMembers", { n: members.length })}>
            ⋯{members.length} ▾
          </button>
          {menuOpen ? (
            <div className="conv-overflow-menu">
              {members.map((a) => (
                <button className="conv-overflow-item" key={a.id} onClick={() => activate(a.id)}>
                  <Dot status={statusOf(a.id)} />
                  <span>{a.id}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="scroll-pane">
        <div className="row conv-control">
          <span className="sub">{cur.harness}</span>
          <span style={{ flex: 1 }} />
          <EffortControl m={m} agent={cur.id} store={store} />
          {live ? (
            <Btn small kind="stop" title={t("interrupt")} onClick={() => void store.interruptAgent(m.name, cur.id)}>
              {t("interrupt")}
            </Btn>
          ) : null}
          {live ? (
            <ModeControl mesh={m.name} agent={cur.id} store={store} modes={pm.modes?.[cur.id]} />
          ) : null}
          {live ? (
            <ModelControl mesh={m.name} agent={cur.id} store={store} models={pm.models?.[cur.id]} />
          ) : null}
          {!mobile ? (
            <Btn small kind="ghost" onClick={onToggleFull} title={t("full")}>
              {fullscreen ? `⊟ ${t("exit")}` : `⊞ ${t("full")}`}
            </Btn>
          ) : null}
        </div>
        <ChatPane
          items={pm.transcripts[activeId] ?? []}
          placeholder={isRouter ? t("router.placeholder") : t("agent.placeholder", { id: activeId })}
          imageEnabled={!!pm.capabilities?.[cur.id]?.image}
          imageDisabledReason="This agent does not advertise image input support"
          onUploadImages={(files) => store.uploadImages(m.name, files)}
          onSend={(msg, images) => (isRouter ? void store.promptRouter(m.name, msg, images) : void store.promptAgent(m.name, activeId, msg, images))}
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
  const [seg, setSeg] = useState<"chat" | "map" | "log">("chat");
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

  const activeAgent = selectedAgent && m.agents.some((a) => a.id === selectedAgent) ? selectedAgent : m.router;
  const conversationPanel = (
    <ConversationPanel
      m={m}
      pm={pm}
      store={store}
      active={activeAgent}
      onActivate={onSelectAgent}
      fullscreen={fullscreen}
      onToggleFull={onToggleFull}
      mobile={mobile}
    />
  );
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
        <Topology summary={m} selectedAgent={activeAgent} onSelect={onSelectAgent} flashId={flashId} />
      </div>
    </div>
  );
  const canvasOverlay = topoOpen ? <MeshCanvas m={m} pm={pm} store={store} onClose={() => setTopoOpen(false)} /> : null;
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

  // ── Mobile: a focused segment switcher (Chat / Map / Log) with the
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
        {canvasOverlay}
        {pm.pending.length ? <div className="mperm">{permissionEl}</div> : null}
        <div className="mseg">
          {seg === "chat" ? conversationPanel : null}
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
        <Topology summary={m} selectedAgent={activeAgent} onSelect={onSelectAgent} flashId={flashId} maxHeight={230} />
      </div>
    </div>
  );
  return (
    <div className="dgrid">
      <Header m={m} store={store} onDeleted={onDeleted} onEdit={onEdit} />
      {canvasOverlay}
      {pm.pending.length ? <div className="dperm">{permissionEl}</div> : null}
      {fullscreen ? (
        <div className="dmain full">{conversationPanel}</div>
      ) : (
        <div className="dmain">
          <div className="dchat">{conversationPanel}</div>
          <div className="drail">
            {railTopology}
            <RailLogs pm={pm} />
          </div>
        </div>
      )}
    </div>
  );
}
