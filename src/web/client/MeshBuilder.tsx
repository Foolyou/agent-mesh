// Modal form to compose a MeshConfig and POST it. Client-side validation mirrors
// src/mesh-validate.ts; the server re-validates and any error is shown inline.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Store } from "./store";
import type { HarnessId, AgentRole, MeshConfig, ThinkingEffort } from "../types";
import { Btn } from "./ui";
import { useI18n } from "./i18n";

interface AgentDraft {
  key: string;
  id: string;
  harness: HarnessId;
  role: AgentRole;
  project: string;
  effort?: ThinkingEffort;
  lazy?: boolean;
  instructions?: string;
}
interface EdgeDraft {
  from: string;
  to: string;
  steer?: boolean;
}
type TextEditTarget =
  | { kind: "agent"; key: string; title: string; value: string }
  | { kind: "charter"; title: string; value: string };
type BuilderPage = { kind: "overview" } | { kind: "agent"; key: string };

const HARNESSES: HarnessId[] = ["claude", "codex", "opencode", "kimi"];
let agentDraftSeq = 0;

function agentKey() {
  agentDraftSeq += 1;
  return `agent-draft-${agentDraftSeq}`;
}

function nextAgentId(agents: AgentDraft[]) {
  const existing = new Set(agents.map((a) => a.id));
  for (let i = agents.length; ; i += 1) {
    const id = `agent-${i}`;
    if (!existing.has(id)) return id;
  }
}

function visibleFocusables(root: HTMLElement) {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null);
}

function TextEditorDialog({
  title,
  value,
  onApply,
  onClose,
}: {
  title: string;
  value: string;
  onApply: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Tab") {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = visibleFocusables(dialog);
      if (!focusables.length) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (active && !dialog.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  return (
    <div className="text-editor-layer" role="presentation" onClick={onClose} onKeyDown={onKeyDown}>
      <div ref={dialogRef} className="text-editor-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="mhead">
          <span style={{ flex: 1 }}>{title}</span>
          <span className="char-count">{draft.length}/4000</span>
          <Btn small kind="ghost" onClick={onClose}>
            ✕ {t("esc")}
          </Btn>
        </div>
        <div className="text-editor-body">
          <textarea
            ref={ref}
            className="inp text-editor-textarea"
            value={draft}
            aria-label={title}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="row text-editor-actions">
            <Btn kind="ghost" onClick={onClose}>
              {t("cancel")}
            </Btn>
            <Btn kind="go" onClick={() => onApply(draft)}>
              {t("apply")}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

function validate(name: string, agents: AgentDraft[], edges: EdgeDraft[]): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return "mesh name must match [A-Za-z0-9._-] and be non-empty";
  if (agents.length === 0) return "at least one agent is required";
  const ids = agents.map((a) => a.id);
  if (ids.some((id) => !id.trim())) return "every agent needs an id";
  if (new Set(ids).size !== ids.length) return "agent ids must be unique";
  const routers = agents.filter((a) => a.role === "router");
  if (routers.length !== 1) return "exactly one agent must be the router";
  if (routers.some((a) => a.lazy === true)) return "router agents cannot be lazy";
  for (const a of agents) {
    if (!a.project.trim()) return `agent "${a.id}" needs a project (working dir)`;
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
      ? initial.agents.map((a) => ({
          key: agentKey(),
          id: a.id,
          harness: a.harness,
          role: a.role,
          project: a.project,
          effort: a.effort,
          lazy: a.lazy,
          instructions: a.instructions,
        }))
      : [{ key: agentKey(), id: "router", harness: "claude", role: "router", project: "test_mesh_0" }],
  );
  const [edges, setEdges] = useState<EdgeDraft[]>(initial ? initial.edges.map((e) => ({ from: e.from, to: e.to, steer: e.steer === true })) : []);
  const [charter, setCharter] = useState(initial?.charter ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [textEdit, setTextEdit] = useState<TextEditTarget | null>(null);
  const [page, setPage] = useState<BuilderPage>({ kind: "overview" });
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Array<HTMLElement | null>>([]);
  const activeIdInputRef = useRef<HTMLInputElement>(null);
  const pendingAgentFocusRef = useRef<string | null>(null);
  const pendingTabFocusRef = useRef<number | null>(null);

  const setAgent = (i: number, patch: Partial<AgentDraft>) =>
    setAgents((as) => as.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const addAgent = () => {
    const key = agentKey();
    setAgents((as) => [...as, { key, id: nextAgentId(as), harness: "codex", role: "member", project: "test_mesh_0" }]);
    pendingAgentFocusRef.current = key;
    setPage({ kind: "agent", key });
  };
  const delAgent = (i: number) => {
    const removed = agents[i]?.id;
    const removedKey = agents[i]?.key;
    if (!removedKey) return;
    setAgents((as) => as.filter((_, j) => j !== i));
    if (removed) setEdges((es) => es.filter((edge) => edge.from !== removed && edge.to !== removed));
    if (textEdit?.kind === "agent" && textEdit.key === removedKey) closeExpandedText();
    setPage((current) => {
      if (current.kind === "overview") return current;
      if (current.key !== removedKey) return current;
      if (agents.length <= 2) return { kind: "overview" };
      const nextIndex = Math.max(0, Math.min(i, agents.length - 2));
      return { kind: "agent", key: agents[nextIndex]!.key };
    });
  };

  const ids = agents.map((a) => a.id);
  const addEdge = () => setEdges((e) => [...e, { from: ids[0] ?? "", to: ids[1] ?? ids[0] ?? "" }]);
  const setEdge = (i: number, which: 0 | 1, v: string) =>
    setEdges((e) => e.map((edge, j) => (j === i ? (which === 0 ? { ...edge, from: v } : { ...edge, to: v }) : edge)));
  const setEdgeSteer = (i: number, steer: boolean) => setEdges((e) => e.map((edge, j) => (j === i ? { ...edge, steer } : edge)));
  const delEdge = (i: number) => setEdges((e) => e.filter((_, j) => j !== i));
  const closeExpandedText = () => {
    const target = restoreFocusRef.current;
    restoreFocusRef.current = null;
    target?.focus({ preventScroll: true });
    setTextEdit(null);
    setTimeout(() => target?.focus({ preventScroll: true }), 0);
  };
  const openExpandedText = (target: TextEditTarget) => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTextEdit(target);
  };
  const applyExpandedText = (value: string) => {
    if (!textEdit) return;
    if (textEdit.kind === "agent") {
      setAgents((as) => as.map((a) => (a.key === textEdit.key ? { ...a, instructions: value } : a)));
    }
    else setCharter(value);
    closeExpandedText();
  };

  async function submit() {
    const v = validate(name, agents, edges) ?? (charter.length > 4000 ? "charter is too long (max 4000 chars)" : null);
    if (v) {
      setErr(v);
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const normalizedAgents = agents.map(({ key: _key, ...a }) => ({
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

  const activeIndex = page.kind === "agent" ? agents.findIndex((a) => a.key === page.key) : -1;
  const activeAgent = activeIndex >= 0 ? agents[activeIndex] : undefined;
  const activeTabIndex = page.kind === "overview" ? 0 : Math.max(0, agents.findIndex((a) => a.key === page.key) + 1);
  const activePanelId = page.kind === "overview" ? "mesh-builder-panel-overview" : `mesh-builder-panel-${activeAgent?.key ?? "missing"}`;
  const activeTabId = page.kind === "overview" ? "mesh-builder-tab-overview" : `mesh-builder-tab-${activeAgent?.key ?? "missing"}`;

  useLayoutEffect(() => {
    if (page.kind !== "agent" || pendingAgentFocusRef.current !== page.key) return;
    pendingAgentFocusRef.current = null;
    activeIdInputRef.current?.focus({ preventScroll: true });
  }, [page]);

  useLayoutEffect(() => {
    const index = pendingTabFocusRef.current;
    if (index === null) return;
    pendingTabFocusRef.current = null;
    tabRefs.current[index]?.focus({ preventScroll: true });
  }, [page, agents.length]);

  function selectTab(index: number) {
    pendingTabFocusRef.current = index;
    if (index === 0) setPage({ kind: "overview" });
    else {
      const agent = agents[index - 1];
      if (agent) setPage({ kind: "agent", key: agent.key });
    }
  }

  function onTabKeyDown(index: number, e: KeyboardEvent<HTMLElement>) {
    const count = agents.length + 1;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (index + 1) % count;
    else if (e.key === "ArrowLeft") next = (index - 1 + count) % count;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = count - 1;
    else if (e.key === "Enter" || e.key === " ") next = index;
    if (next === null) return;
    e.preventDefault();
    selectTab(next);
  }

  function onModalKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const modal = modalRef.current;
    if (!modal) return;
    const focusables = visibleFocusables(modal);
    if (!focusables.length) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    } else if (active && !modal.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="scrim" onClick={() => onClose()}>
      <div
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mesh-builder-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onModalKeyDown}
      >
        <div className="mhead">
          <span id="mesh-builder-title" style={{ flex: 1 }}>
            {editing ? t("build.edit", { name: initial!.name }) : t("build.define")}
          </span>
          <Btn small kind="ghost" onClick={() => onClose()}>
            ✕ esc
          </Btn>
        </div>
        <div className="mbody">
          <div className="builder-tabs" role="tablist" aria-label="mesh editor pages">
            <button
              type="button"
              className="builder-tab"
              role="tab"
              id="mesh-builder-tab-overview"
              ref={(el) => {
                tabRefs.current[0] = el;
              }}
              aria-selected={page.kind === "overview"}
              aria-controls="mesh-builder-panel-overview"
              tabIndex={page.kind === "overview" ? 0 : -1}
              onClick={() => setPage({ kind: "overview" })}
              onKeyDown={(e) => onTabKeyDown(0, e)}
            >
              <span>{t("build.overview")}</span>
            </button>
            {agents.map((a, i) => (
              <div
                className="builder-tab"
                role="tab"
                id={`mesh-builder-tab-${a.key}`}
                ref={(el) => {
                  tabRefs.current[i + 1] = el;
                }}
                aria-selected={page.kind === "agent" && page.key === a.key}
                aria-controls={`mesh-builder-panel-${a.key}`}
                tabIndex={page.kind === "agent" && page.key === a.key ? 0 : -1}
                onClick={() => setPage({ kind: "agent", key: a.key })}
                onKeyDown={(e) => onTabKeyDown(i + 1, e)}
                key={a.key}
              >
                <span className="builder-tab-label">{a.id || `agent-${i}`}</span>
                <button
                  type="button"
                  disabled={agents.length === 1}
                  aria-label={`remove ${a.id || `agent-${i}`}`}
                  className="builder-tab-remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (agents.length > 1) delAgent(i);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            <Btn small onClick={addAgent}>
              {t("build.addAgent")}
            </Btn>
          </div>

          {page.kind === "overview" ? (
            <div id={activePanelId} role="tabpanel" aria-labelledby={activeTabId} tabIndex={0}>
              <section className="builder-section">
                <div className="builder-section-head">{t("build.basic")}</div>
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
              </section>

              <section className="builder-section">
                <div className="builder-section-head">{t("build.edges")}</div>
                <div className="field">
                  <label>{t("build.edges")}</label>
                  {edges.map((edge, i) => (
                    <div className="row" key={i}>
                      <select className="inp select-control" value={edge.from} onChange={(e) => setEdge(i, 0, e.target.value)}>
                        {ids.map((id) => (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        ))}
                      </select>
                      <span className="sub">→</span>
                      <select className="inp select-control" value={edge.to} onChange={(e) => setEdge(i, 1, e.target.value)}>
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
              </section>

              <section className="builder-section">
                <div className="builder-section-head">{t("build.charter")}</div>
                <div className="field">
                  <div className="field-label-row">
                    <label className="sr-only" htmlFor="mesh-charter">
                      {t("build.charter")}
                    </label>
                    <Btn small kind="ghost" onClick={() => openExpandedText({ kind: "charter", title: t("build.charter"), value: charter })}>
                      {t("expand")}
                    </Btn>
                  </div>
                  <textarea
                    id="mesh-charter"
                    className="inp mesh-charter"
                    rows={4}
                    value={charter}
                    placeholder={"e.g. Goal: build a tiny wordcount CLI.\nNorms: keep it one file, write a test, hand off via send_mail when done."}
                    onChange={(e) => setCharter(e.target.value)}
                    style={{ resize: "vertical", fontFamily: "var(--mono)" }}
                  />
                </div>
              </section>
            </div>
          ) : activeAgent ? (
            <section id={activePanelId} role="tabpanel" aria-labelledby={activeTabId} tabIndex={0} className="builder-section">
              <div className="builder-section-head">
                <span>{t("build.agentPage", { id: activeAgent.id || `agent-${activeIndex}` })}</span>
                <Btn small kind="ghost" onClick={() => delAgent(activeIndex)} disabled={agents.length === 1}>
                  {t("build.deleteAgent")}
                </Btn>
              </div>
              <div className="field">
                <div className="agent-block">
                  <div className="agrow">
                    <input
                      ref={activeIdInputRef}
                      className="inp"
                      value={activeAgent.id}
                      placeholder="id"
                      onChange={(e) => setAgent(activeIndex, { id: e.target.value })}
                    />
                    <select className="inp select-control" value={activeAgent.harness} onChange={(e) => setAgent(activeIndex, { harness: e.target.value as HarnessId })}>
                      {HARNESSES.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                    <select
                      className="inp select-control"
                      value={activeAgent.role}
                      onChange={(e) => {
                        const role = e.target.value as AgentRole;
                        setAgent(activeIndex, { role, lazy: role === "router" ? undefined : activeAgent.lazy });
                      }}
                    >
                      <option value="router">router</option>
                      <option value="member">member</option>
                    </select>
                    <input className="inp" value={activeAgent.project} placeholder="project dir" onChange={(e) => setAgent(activeIndex, { project: e.target.value })} />
                  </div>
                  <div className="agrow-adv">
                    <span className="adv-label">{t("effort")}</span>
                    <select
                      className="inp adv-sel select-control"
                      value={activeAgent.effort ?? ""}
                      title={t("effort.hint")}
                      onChange={(e) => setAgent(activeIndex, { effort: (e.target.value || undefined) as ThinkingEffort | undefined })}
                    >
                      <option value="">{t("effort.default")}</option>
                      <option value="minimal">{t("effort.minimal")}</option>
                      <option value="low">{t("effort.low")}</option>
                      <option value="medium">{t("effort.medium")}</option>
                      <option value="high">{t("effort.high")}</option>
                    </select>
                    <label className="check-inline" title={t("build.lazy.tooltip")}>
                      <input
                        type="checkbox"
                        checked={activeAgent.lazy === true}
                        disabled={activeAgent.role === "router"}
                        onChange={(e) => setAgent(activeIndex, { lazy: e.target.checked || undefined })}
                      />
                      {t("build.lazy")}
                    </label>
                  </div>
                  <div className="agent-instructions-field">
                    <div className="field-label-row">
                      <label className="adv-label" htmlFor={`agent-${activeIndex}-instructions`}>
                        {t("build.instructions")}
                      </label>
                      <Btn
                        small
                        kind="ghost"
                        onClick={() => openExpandedText({ kind: "agent", key: activeAgent.key, title: t("build.instructions"), value: activeAgent.instructions ?? "" })}
                      >
                        {t("expand")}
                      </Btn>
                    </div>
                    <textarea
                      id={`agent-${activeIndex}-instructions`}
                      className="inp agent-instructions"
                      rows={3}
                      value={activeAgent.instructions ?? ""}
                      placeholder={t("build.instructions.placeholder")}
                      onChange={(e) => setAgent(activeIndex, { instructions: e.target.value })}
                    />
                  </div>
                </div>
              </div>
            </section>
          ) : null}

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
        {textEdit ? (
          <TextEditorDialog
            title={textEdit.title}
            value={textEdit.value}
            onApply={applyExpandedText}
            onClose={closeExpandedText}
          />
        ) : null}
      </div>
    </div>
  );
}
