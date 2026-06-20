// Right column = the TUI "mesh context" + the PoC three-pane intent, web-enhanced:
// topology, unified conversation tabs, permission cards, and activity/mail/
// permission-history timelines for the selected mesh.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Store } from "./store";
import { shouldLoadInitialTranscript } from "./store";
import type { GatewayState, MeshSummary, PerMeshState, ActivityEntry, MailEntry, ResolvedPermission, PermissionReq, AgentModes, AgentModels, HarnessId, StartSessionStrategy, HarnessProbeRow } from "../types";
import { effortOptionsForHarness, supportsRuntimeEffort, supportsThinkingToggle, kimiThinkingEnabled, kimiModelForThinking } from "../../harness-utils";
import { Dot, Btn, Empty, ConfirmButton, InfoIcon, fmtTime } from "./ui";
import { ChatPane } from "./ChatPane";
import { BoardPanel } from "./BoardPanel";
import { MeshCanvas } from "./MeshCanvas";
import { Topology } from "./Topology";
import { ContextUsageChip, ContextWaterline } from "./health";
import { useI18n, tStatus } from "./i18n";
import { VirtualList } from "./VirtualList";

function Header({ m, store, onDeleted, onEdit }: { m: MeshSummary; store: Store; onDeleted: () => void; onEdit: () => void }) {
  const { t } = useI18n();
  const [sessionStrategy, setSessionStrategy] = useState<StartSessionStrategy>("resume");
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLSpanElement | null>(null);
  const live = m.status === "running" || m.status === "starting";

  useEffect(() => {
    if (!actionsOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!actionsRef.current?.contains(e.target as Node)) setActionsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActionsOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [actionsOpen]);

  const renderNewSessionsAction = () => (
    <ConfirmButton
      kind="ghost"
      confirmLabel={t("new sessions all.confirm")}
      title={t("new sessions all.hint")}
      onConfirm={() => void store.newAllSessions(m.name)}
    >
      {t("new sessions all")}
    </ConfirmButton>
  );
  const renderEditAction = () => (
    <Btn kind="ghost" title={t("edit")} onClick={onEdit}>
      {t("edit")}
    </Btn>
  );
  const renderDeleteAction = () => (
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
  );

  return (
    <div className="detail-head">
      <span className="mtitle">{m.name}</span>
      <span className="row">
        <Dot status={m.status} />
        <span className="meta">{tStatus(t, m.status)}</span>
      </span>
      <span className="meta">{t("router")} = {m.router}</span>
      <span className="meta">{t("agents", { n: m.agents.length })}</span>
      <span className="detail-spacer" />
      {live ? (
        <span className="detail-actions">
          <span className="detail-secondary-actions">{renderNewSessionsAction()}</span>
          <ConfirmButton
            kind="stop"
            confirmLabel={t("stop.confirm")}
            ariaLabel={t("stop mesh")}
            onConfirm={() => void store.stopMesh(m.name)}
          >
            {t("stop mesh")}
          </ConfirmButton>
          <span className="detail-overflow" ref={actionsRef}>
            <Btn kind="ghost" title={t("actions")} ariaLabel={t("actions")} onClick={() => setActionsOpen((o) => !o)}>
              ⋯
            </Btn>
            {actionsOpen ? <span className="detail-overflow-menu">{renderNewSessionsAction()}</span> : null}
          </span>
        </span>
      ) : (
        <span className="detail-actions">
          <span className="row start-strategy" title={t("start.strategy.hint")}>
            <span className="sub">{t("start.strategy")}</span>
            <select
              className="select-control start-session-sel"
              value={sessionStrategy}
              aria-label={t("start.strategy")}
              onChange={(e) => setSessionStrategy(e.target.value as StartSessionStrategy)}
            >
              <option value="resume">{t("start.strategy.resume")}</option>
              <option value="fresh">{t("start.strategy.fresh")}</option>
            </select>
          </span>
          <Btn kind="go" onClick={() => void store.startMesh(m.name, sessionStrategy)}>
            {t("start mesh")}
          </Btn>
          <span className="detail-secondary-actions">
            {renderEditAction()}
            {renderDeleteAction()}
          </span>
          <span className="detail-overflow" ref={actionsRef}>
            <Btn kind="ghost" title={t("actions")} ariaLabel={t("actions")} onClick={() => setActionsOpen((o) => !o)}>
              ⋯
            </Btn>
            {actionsOpen ? (
              <span className="detail-overflow-menu">
                {renderEditAction()}
                {renderDeleteAction()}
              </span>
            ) : null}
          </span>
        </span>
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
        className="mode-sel select-control"
        value={modes.current}
        aria-label={t("mode")}
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
        className="model-sel select-control"
        value={models.current}
        aria-label={t("model")}
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

function StaleHarnessNotice({
  mesh,
  agent,
  row,
  store,
  pending,
  onPending,
}: {
  mesh: string;
  agent: string;
  row: HarnessProbeRow;
  store: Store;
  pending: boolean;
  onPending: (pending: boolean) => void;
}) {
  const running = row.version ? `running ${row.id} v${row.version}` : `running ${row.id} version unknown`;
  const newer = row.latest ? `newer v${row.latest} installed` : "newer installed version detected";
  return (
    <span className="stale-harness-note" role="status">
      {pending ? (
        <>
          <span>restart pending (after current turn)</span>
          <Btn small kind="ghost" onClick={() => void store.respawnAgent(mesh, agent, "cancel").then(() => onPending(false))} ariaLabel={`Cancel pending restart for ${agent}`}>
            cancel
          </Btn>
        </>
      ) : (
        <>
          <span>{running}</span>
          <span>({newer})</span>
          <Btn small kind="go" onClick={() => void store.respawnAgent(mesh, agent, "after-idle").then(() => onPending(true))} ariaLabel={`Restart ${agent} after current turn`}>
            Restart agent
          </Btn>
          <ConfirmButton
            small
            kind="stop"
            confirmLabel="Force restart agent will lose current ACP session context (mailbox preserved). Continue?"
            ariaLabel={`Force restart ${agent}`}
            onConfirm={() => void store.respawnAgent(mesh, agent, "force").then(() => onPending(false))}
          >
            force
          </ConfirmButton>
        </>
      )}
    </span>
  );
}

// Per-agent reasoning-effort picker. Claude switches effort at runtime (ACP config option);
// Codex is spawn-time only. Kimi has NO reasoning effort (its thinking is a model-variant
// toggle — rendered separately), and OpenCode has no effort entry at all; both report an
// empty capability set, so this control renders nothing for them.
function EffortControl({ m, agent, store }: { m: MeshSummary; agent: string; store: Store }) {
  const { t } = useI18n();
  const a = m.agents.find((x) => x.id === agent);
  if (!a) return null;
  const advertised = store.getState().perMesh[m.name]?.efforts?.[agent];
  const efforts = advertised?.available.length ? advertised.available.map((o) => o.id) : effortOptionsForHarness(a.harness);
  if (efforts.length === 0) return null; // codex/claude only — kimi & opencode hidden here
  const live = m.status === "running" || m.status === "starting";
  const runtime = supportsRuntimeEffort(a.harness);
  return (
    <span className="row" style={{ gap: 5 }}>
      <span className="sub" style={{ fontSize: 10 }}>
        {t("effort")}
      </span>
      <select
        className="effort-sel select-control"
        value={a.effort ?? advertised?.current ?? ""}
        disabled={live && !runtime}
        aria-label={t("effort")}
        title={live && runtime ? t("effort.hint.runtime") : live ? t("effort.hint.live") : t("effort.hint")}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => void store.setEffort(m.name, agent, e.target.value || undefined)}
      >
        <option value="">{t("effort.default")}</option>
        {efforts.map((eff) => (
          <option key={eff} value={eff}>
            {advertised?.available.find((o) => o.id === eff)?.name ?? t(`effort.${eff}`)}
          </option>
        ))}
      </select>
    </span>
  );
}

// Kimi's "thinking" is a binary mode, NOT a reasoning effort: it is toggled by switching the
// session MODEL between the base id and its `,thinking` variant via the existing setModel
// path (independent of the effort capability). Runtime-only; needs a known current model to
// derive the variant from.
function KimiThinkingControl({ m, agent, store, models }: { m: MeshSummary; agent: string; store: Store; models?: AgentModels }) {
  const { t } = useI18n();
  const a = m.agents.find((x) => x.id === agent);
  if (!a || !supportsThinkingToggle(a.harness)) return null;
  const current = models?.current; // runtime-advertised current model id (may carry the ,thinking variant)
  if (!current) return null; // no base model known yet → nothing to toggle against
  const on = kimiThinkingEnabled(current);
  return (
    <span className="row" style={{ gap: 5 }}>
      <span className="sub" style={{ fontSize: 10 }}>
        {t("thinking")}
      </span>
      <select
        className="thinking-sel select-control"
        value={on ? "on" : "off"}
        aria-label={t("thinking")}
        title={t("thinking.hint")}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => void store.setModel(m.name, agent, kimiModelForThinking(current, e.target.value === "on"))}
      >
        <option value="off">{t("thinking.off")}</option>
        <option value="on">{t("thinking.on")}</option>
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
  const [harnessRows, setHarnessRows] = useState<HarnessProbeRow[]>([]);
  const [pendingRespawn, setPendingRespawn] = useState(false);

  const refreshHarnesses = async () => {
    setHarnessRows(await store.listHarnesses().catch(() => []));
  };
  const transcript = pm.transcripts[activeId];
  const transcriptInitialLoaded = store.isTranscriptInitialLoaded(m.name, activeId);
  const canLoadInitialTranscript = shouldLoadInitialTranscript(cur?.status, transcript?.items.length ?? 0);
  const loadingTranscript = !!transcript?.hasMore && !transcriptInitialLoaded && (transcript.items?.length ?? 0) === 0;

  useEffect(() => {
    if (activeId === m.router) return;
    tabRefs.current[activeId]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, m.router]);

  useEffect(() => {
    if (!canLoadInitialTranscript) return;
    if (!transcript?.hasMore || transcriptInitialLoaded) return;
    void store.loadInitialTranscript(m.name, activeId);
  }, [activeId, m.name, store, transcript?.hasMore, transcriptInitialLoaded, canLoadInitialTranscript]);

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

  useEffect(() => {
    void refreshHarnesses();
    return store.subscribe(() => void refreshHarnesses());
  }, [store]);

  if (!cur) return <Empty>{t("empty.members")}</Empty>;
  const statusOf = (id: string) => (live ? (m.agents.find((a) => a.id === id)?.status ?? "stopped") : "stopped");
  const working = live && cur.activity === "working";
  const staleHarness = harnessRows.find((row) => row.id === cur.harness && row.runningAgentsUsingOldVersion.includes(`${m.name}/${cur.id}`));
  const canWake = live && cur.lazy === true && cur.status === "cold";
  const self = pm.selfAwareness?.[cur.id];
  const silentCount = self?.silentTaskCompletes?.count ?? 0;
  const nearLimit = self?.nearLimit;
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
          <ContextUsageChip usage={pm.usage?.[cur.id]} />
          {silentCount > 0 ? (
            <span className="silent-stop-badge" title={`last silent stop: ${self?.silentTaskCompletes?.lastAt ?? "unknown"}`}>
              silent stop ×{silentCount}
            </span>
          ) : null}
          <span className="control-spacer" />
          {live ? <EffortControl m={m} agent={cur.id} store={store} /> : null}
          {live ? (
            <ModeControl mesh={m.name} agent={cur.id} store={store} modes={pm.modes?.[cur.id]} />
          ) : null}
          {live ? (
            <ModelControl mesh={m.name} agent={cur.id} store={store} models={pm.models?.[cur.id]} />
          ) : null}
          {live ? (
            <KimiThinkingControl m={m} agent={cur.id} store={store} models={pm.models?.[cur.id]} />
          ) : null}
          {canWake ? (
            <Btn small kind="go" onClick={() => void store.wakeAgent(m.name, cur.id)} title={t("wake.hint")}>
              {t("wake")}
            </Btn>
          ) : null}
          {live ? (
            <ConfirmButton
              small
              kind="ghost"
              confirmLabel={t("new session.confirm")}
              title={t("new session.hint")}
              onConfirm={() => void store.newAgentSession(m.name, cur.id)}
            >
              {t("new session")}
            </ConfirmButton>
          ) : null}
          {staleHarness ? (
            <StaleHarnessNotice
              mesh={m.name}
              agent={cur.id}
              row={staleHarness}
              store={store}
              pending={pendingRespawn}
              onPending={setPendingRespawn}
            />
          ) : null}
          {nearLimit ? (
            <span className="near-limit-warning" role="status" title="This agent does not advertise /compact">
              Context near limit ({Math.round(nearLimit.usagePercent * 100)}%); /compact unavailable.
            </span>
          ) : null}
          {!mobile ? (
            <Btn small kind="ghost" onClick={onToggleFull} title={fullscreen ? t("exit") : t("full")} ariaLabel={`${fullscreen ? t("exit") : t("full")} ${t("conversation")}`} >
              {fullscreen ? `⊟ ${t("exit")}` : `⊞ ${t("full")}`}
            </Btn>
          ) : null}
        </div>
        <ChatPane
          items={transcript?.items ?? []}
          hasMore={transcript?.hasMore}
          loadingTranscript={loadingTranscript}
          activeId={activeId}
          onLoadOlder={() => store.loadOlderTranscript(m.name, activeId)}
          queue={pm.queues?.[activeId]}
          author={{ meshId: m.name, agent: activeId }}
          placeholder={isRouter ? t("router.placeholder") : t("agent.placeholder", { id: activeId })}
          imageEnabled={!!pm.capabilities?.[cur.id]?.image}
          imageDisabledReason="This agent does not advertise image input support"
          onUploadImages={(files) => store.uploadImages(m.name, files)}
          onRemoveQueued={(item) => store.removeQueuedTurn(m.name, activeId, item.id)}
          working={working}
          onInterrupt={live ? () => store.interruptAgent(m.name, cur.id) : undefined}
          onSend={(msg, images, opts) =>
            isRouter
              ? void store.promptRouter(m.name, msg, images)
              : opts?.steer
                ? void store.steerAgent(m.name, activeId, msg, images)
                : void store.promptAgent(m.name, activeId, msg, images)
          }
        />
      </div>
    </div>
  );
}

function Timeline({ activity, className, style }: { activity: ActivityEntry[]; className?: string; style?: CSSProperties }) {
  const { t } = useI18n();
  const rows = activity.slice().reverse();
  return (
    <VirtualList
      items={rows}
      className={`tl ${className ?? ""}`}
      style={style}
      empty={<Empty>{t("empty.activity")}</Empty>}
      render={(e) => (
        <div className="ent" key={e.id}>
          <span className="ts">{fmtTime(e.ts)}</span>
          <span className={`k ${e.kind}`}>{e.kind === "permission_resolved" ? "perm" : e.kind}</span>
          <span className="tx">{e.text}</span>
        </div>
      )}
    />
  );
}

function Mailbox({ mail, className, style }: { mail: MailEntry[]; className?: string; style?: CSSProperties }) {
  const { t } = useI18n();
  const rows = mail.slice().reverse();
  return (
    <VirtualList
      items={rows}
      className={`tl ${className ?? ""}`}
      style={style}
      empty={<Empty>{t("empty.mail")}</Empty>}
      render={(e) => (
        <div className="ent" key={e.id}>
          <span className="ts">{fmtTime(e.ts)}</span>
          <span className="k mail">
            {e.from} → {e.to}
          </span>
          <span className="tx">{e.body}</span>
        </div>
      )}
    />
  );
}

function History({ history, className, style }: { history: ResolvedPermission[]; className?: string; style?: CSSProperties }) {
  const { t } = useI18n();
  const rows = history.slice().reverse();
  return (
    <VirtualList
      items={rows}
      className={`tl ${className ?? ""}`}
      style={style}
      empty={<Empty>{t("empty.history")}</Empty>}
      render={(e) => (
        <div className="ent" key={e.requestId + e.ts}>
          <span className="ts">{fmtTime(e.ts)}</span>
          <span className="k permission_resolved">{e.by}</span>
          <span className="tx">
            {e.agent} · {e.requestId.slice(0, 8)} → {e.optionId}
          </span>
        </div>
      )}
    />
  );
}

// The desktop rail's reference logs as one compact segmented card.
function RailLogs({ pm, mesh, running, agents, store }: { pm: PerMeshState; mesh: string; running: boolean; agents: string[]; store: Store }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"activity" | "mail" | "board" | "history">("activity");
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
          <button className={`seg-tab ${tab === "board" ? "sel" : ""}`} onClick={() => setTab("board")}>
            {t("tab.board")} {pm.board && pm.board.tasks.length ? `· ${pm.board.tasks.length}` : ""}
          </button>
          <button className={`seg-tab ${tab === "history" ? "sel" : ""}`} onClick={() => setTab("history")}>
            {t("tab.history")} {pm.history.length ? `· ${pm.history.length}` : ""}
          </button>
        </span>
      </div>
      {tab === "activity" ? (
        <Timeline activity={pm.activity} className="body-scroll" />
      ) : tab === "mail" ? (
        <Mailbox mail={pm.mail} className="body-scroll" />
      ) : tab === "board" ? (
        <BoardPanel mesh={mesh} board={pm.board} running={running} agents={agents} store={store} className="body-scroll" />
      ) : (
        <History history={pm.history} className="body-scroll" />
      )}
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
      models: {},
      capabilities: {},
      usage: {},
      health: {},
      selfAwareness: {},
      queues: {},
      board: null,
    };
  // interrupt flash: highlight a node briefly when a new interrupt activity arrives
  const { t } = useI18n();
  const [flashId, setFlashId] = useState<string | null>(null);
  const [seg, setSeg] = useState<"chat" | "map" | "log">("chat");
  const [topoOpen, setTopoOpen] = useState(false);
  const [topologyManageOpen, setTopologyManageOpen] = useState(false);
  const [edgeFrom, setEdgeFrom] = useState("");
  const [edgeTo, setEdgeTo] = useState("");
  const [agentId, setAgentId] = useState("");
  const [agentHarness, setAgentHarness] = useState<HarnessId>("codex");
  const lastInterrupt = pm.activity.filter((a) => a.kind === "interrupt").slice(-1)[0];
  useEffect(() => {
    if (!lastInterrupt) return;
    const target = lastInterrupt.text.split("→")[1]?.trim().split(":")[0]?.trim();
    if (!target) return;
    setFlashId(target);
    const timer = setTimeout(() => setFlashId(null), 1000);
    return () => clearTimeout(timer);
  }, [lastInterrupt?.id]);
  const agentIds = m?.agents.map((a) => a.id) ?? [];
  const routerId = m?.router ?? "";
  useEffect(() => {
    if (!agentIds.length) return;
    setEdgeFrom((v) => (agentIds.includes(v) ? v : (routerId || agentIds[0] || "")));
    setEdgeTo((v) => (agentIds.includes(v) ? v : (agentIds.find((id) => id !== (routerId || agentIds[0])) || agentIds[0] || "")));
    setAgentId((v) => {
      const next = v.trim() || `agent-${agentIds.length}`;
      return agentIds.includes(next) ? `agent-${agentIds.length}` : next;
    });
  }, [agentIds.join("\u0000"), routerId]);

  if (!m) return <Empty>{t("empty.select")}</Empty>;

  const activeAgent = selectedAgent && m.agents.some((a) => a.id === selectedAgent) ? selectedAgent : m.router;
  const live = m.status === "running" || m.status === "starting";
  const addEdgeDisabled =
    !edgeFrom ||
    !edgeTo ||
    edgeFrom === edgeTo ||
    m.edges.some((e) => e.from === edgeFrom && e.to === edgeTo);
  const submitEdge = () => {
    if (addEdgeDisabled) return;
    void store.addEdge(m.name, { from: edgeFrom, to: edgeTo });
  };
  const addAgentDisabled = !agentId.trim() || agentIds.includes(agentId.trim());
  const submitAgent = () => {
    const id = agentId.trim();
    if (addAgentDisabled) return;
    void store.addAgent(m.name, { id, harness: agentHarness, project: "test_mesh_0", role: "member" }).then(() => {
      setAgentId(`agent-${agentIds.length + 1}`);
      onSelectAgent(id);
    }, () => {});
  };
  const agentAddControl = live ? (
    <span className="row agent-add" style={{ gap: 5 }}>
      <input className="inp compact" value={agentId} aria-label={t("agent.id")} onChange={(e) => setAgentId(e.target.value)} />
      <select className="mode-sel select-control" value={agentHarness} aria-label={t("agent.harness")} onChange={(e) => setAgentHarness(e.target.value as HarnessId)}>
        <option value="codex">codex</option>
        <option value="claude">claude</option>
        <option value="kimi">kimi</option>
        <option value="opencode">opencode</option>
      </select>
      <Btn small kind="go" disabled={addAgentDisabled} title={t("agent.add")} onClick={submitAgent}>
        {t("agent.add")}
      </Btn>
    </span>
  ) : null;
  const edgeAddControl =
    live && agentIds.length >= 2 ? (
      <span className="row edge-add" style={{ gap: 5 }}>
        <select className="mode-sel select-control" value={edgeFrom} aria-label={t("edge.from")} onChange={(e) => setEdgeFrom(e.target.value)}>
          {agentIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <span className="sub">→</span>
        <select className="mode-sel select-control" value={edgeTo} aria-label={t("edge.to")} onChange={(e) => setEdgeTo(e.target.value)}>
          {agentIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <Btn small kind="go" disabled={addEdgeDisabled} title={t("edge.add")} onClick={submitEdge}>
          {t("edge.add")}
        </Btn>
      </span>
    ) : null;
  const hasTopologyControls = !!agentAddControl || !!edgeAddControl;
  const topologyManageButton = hasTopologyControls ? (
    <Btn small kind="ghost" title={t("topology.manage")} ariaLabel={t("topology.manage")} onClick={() => setTopologyManageOpen((o) => !o)}>
      {topologyManageOpen ? "−" : "+"} {t("manage")}
    </Btn>
  ) : null;
  const topologyControls = hasTopologyControls ? (
    <div className={`topology-controls ${topologyManageOpen ? "open" : ""}`}>
      {agentAddControl}
      {edgeAddControl}
    </div>
  ) : null;
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
          <span className="topology-inline-controls">
            {agentAddControl}
            {edgeAddControl}
          </span>
          <span className="topology-manage-toggle">{topologyManageButton}</span>
          <InfoIcon text={t("topology.sub")} />
          <Btn small kind="ghost" title={t("topology")} onClick={() => setTopoOpen(true)}>
            ⤢
          </Btn>
        </span>
      </div>
      <div className="body-scroll">
        {topologyControls}
        <ContextWaterline agents={m.agents.map((a) => a.id)} usage={pm.usage} />
        <Topology summary={m} selectedAgent={activeAgent} onSelect={onSelectAgent} flashId={flashId} health={pm.health} />
      </div>
    </div>
  );
  const canvasOverlay = topoOpen ? <MeshCanvas m={m} pm={pm} store={store} onClose={() => setTopoOpen(false)} onEdit={onEdit} onDeleted={onDeleted} /> : null;
  const activityPanel = (
    <div className="panel">
      <div className="head">
        <span className="ttl">{t("activity")}</span>
        <span className="right">
          <InfoIcon text={t("activity.sub")} />
        </span>
      </div>
      <Timeline activity={pm.activity} className="body-scroll" style={{ maxHeight: mobile ? undefined : 240 }} />
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
      <Mailbox mail={pm.mail} className="body-scroll" style={{ maxHeight: mobile ? undefined : 240 }} />
    </div>
  );
  const historyPanel = (
    <div className="panel">
      <div className="head">
        <span className="ttl">{t("permission history")}</span>
        <span className="sub">{pm.history.length}</span>
      </div>
      <History history={pm.history} className="body-scroll" style={{ maxHeight: mobile ? undefined : 200 }} />
    </div>
  );
  const boardPanel = (
    <div className="panel">
      <div className="head">
        <span className="ttl">{t("tab.board")}</span>
        <span className="sub">{pm.board ? pm.board.tasks.length : 0}</span>
      </div>
      <BoardPanel mesh={meshName} board={pm.board} running={m.status === "running"} agents={m.agents.map((a) => a.id)} store={store} className="body-scroll" />
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
              {boardPanel}
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
        <span className="ttl">{t("topology")}</span>
        <span className="right">
          <span className="topology-inline-controls">
            {agentAddControl}
            {edgeAddControl}
          </span>
          <span className="topology-manage-toggle">{topologyManageButton}</span>
          <InfoIcon text={t("topology.sub")} />
          <Btn small kind="ghost" title="expand topology" onClick={() => setTopoOpen(true)}>
            ⤢
          </Btn>
        </span>
      </div>
      <div className="body-scroll">
        {topologyControls}
        <ContextWaterline agents={m.agents.map((a) => a.id)} usage={pm.usage} />
        <Topology summary={m} selectedAgent={activeAgent} onSelect={onSelectAgent} flashId={flashId} health={pm.health} maxHeight={230} />
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
            <RailLogs pm={pm} mesh={meshName} running={m.status === "running"} agents={m.agents.map((a) => a.id)} store={store} />
          </div>
        </div>
      )}
    </div>
  );
}
