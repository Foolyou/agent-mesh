// Step 7.3 — new /bnw New/Edit-mesh builder, wired to REAL data: defineMesh (POST /api/meshes,
// raw validation surfaced), GET /api/meshes/<id>/config (edit), listHarnesses, and per-harness
// model probe (GET /api/harnesses/<h>/models[?refresh=1]). Independent view layer: shares the
// store/API only; does NOT import or modify the old MeshBuilder. Mirrors mockup 04 + coverage/04.
//
// Parity #1–#8: per-agent instructions (≤4000) + expanded focus-trapped editor (#2), model +
// probe/retry (#3), effort (#4), lazy (#5), opencode permission (#6), auto-compact (#7), edge
// steer (#8). C3 long-form: sticky desktop action bar + mobile fixed Save footer + add-agent
// auto-scroll-into-view & focus-first-field + no nested agent-list overflow trap.
import { useEffect, useRef, useState } from "react";
import { Button, Cluster, EmptyState, ErrorBanner, Input, PanelFrame, Select, Spinner, Textarea } from "../ui/index";
import type { Store } from "../store";
import type { GatewayState } from "../../types";
import type { AgentConfig, HarnessId, AgentRole, MeshConfig, MeshEdge, ThinkingEffort } from "../../../acp/types";
import { authHeaders } from "../device-auth";
import { effortOptionsForHarness, supportsRuntimeEffort, supportsThinkingToggle } from "../../../harness-utils";
import { bnwHref, navigate } from "../router";

const HARNESSES: HarnessId[] = ["claude", "codex", "opencode", "kimi"];
const MAX_INSTR = 4000;
type AgentRow = { id: string; harness: HarnessId; project: string; role: AgentRole; model?: string; effort?: string; lazy?: boolean; opencodePermission?: "ask" | "allow"; instructions?: string };
type EdgeRow = { from: string; to: string; steer?: boolean };
type ModelProbe = { status: "idle" | "loading" | "ready" | "error"; models: { id: string; name: string }[]; message?: string };
type EditorState = { kind: "charter" } | { kind: "instructions"; idx: number } | null;

const blankAgent = (role: AgentRole = "member"): AgentRow => ({ id: "", harness: "claude", project: "", role });

// #2 — expanded text editor with a REAL focus trap (Tab cycles within, Esc closes) + char count.
function TextEditorDialog({ title, value, onApply, onClose }: { title: string; value: string; onApply: (v: string) => void; onClose: () => void }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => { ref.current?.querySelector("textarea")?.focus(); }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key !== "Tab") return;
    const f = ref.current?.querySelectorAll<HTMLElement>('button, textarea, [href], input, [tabindex]:not([tabindex="-1"])');
    if (!f || f.length === 0) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const over = text.length > MAX_INSTR;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }} onKeyDown={onKeyDown}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={`${title} editor`} data-bnw-editor
        className="flex max-h-[88%] w-[640px] max-w-full flex-col gap-3 rounded-xl border border-border-strong bg-surface-raised p-4 text-text-primary shadow-sm">
        <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{title}</h2><Button variant="ghost" size="sm" iconOnly aria-label="close editor" onClick={onClose}>✕</Button></div>
        <Textarea value={text} aria-label={`${title} full editor`} rows={12} error={over} className="flex-1" onChange={(e) => setText(e.target.value)} />
        <div className="flex items-center justify-between">
          <span className={`text-xs tabular-nums ${over ? "text-danger" : "text-text-muted"}`}>{text.length} / {MAX_INSTR}</span>
          <Cluster><Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button variant="primary" size="sm" disabled={over} aria-label="apply editor" onClick={() => { onApply(text); onClose(); }}>Apply</Button></Cluster>
        </div>
      </div>
    </div>
  );
}

export function BnwNewMesh({ store, state, route }: { store: Store; state: GatewayState; route: { editOf?: string; nmEditor?: "charter" | "instructions" } }) {
  const editing = !!route.editOf;
  const [name, setName] = useState(route.editOf ?? "");
  const [agents, setAgents] = useState<AgentRow[]>([blankAgent("router")]);
  const [edges, setEdges] = useState<EdgeRow[]>([]);
  const [charter, setCharter] = useState("");
  const [autoCompact, setAutoCompact] = useState<{ enabled: boolean; threshold: string }>({ enabled: true, threshold: "85%" });
  const [probes, setProbes] = useState<Partial<Record<HarnessId, ModelProbe>>>({});
  const [editor, setEditor] = useState<EditorState>(route.nmEditor === "charter" ? { kind: "charter" } : route.nmEditor === "instructions" ? { kind: "instructions", idx: 0 } : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [loadingCfg, setLoadingCfg] = useState(editing);
  const justAdded = useRef<number | null>(null);

  // listHarnesses (availability) — probed lazily per harness for models.
  useEffect(() => { void store.listHarnesses().catch(() => {}); }, [store]);

  // edit: load the existing mesh config (GET /api/meshes/<id>/config)
  useEffect(() => {
    if (!route.editOf) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/meshes/${encodeURIComponent(route.editOf!)}/config`, { headers: authHeaders() });
        if (!res.ok) throw new Error("config unavailable");
        const c = (await res.json()) as MeshConfig;
        if (cancelled) return;
        setName(c.name);
        setAgents(c.agents.map((a) => ({ id: a.id, harness: a.harness, project: a.project, role: a.role, model: a.model, effort: a.effort, lazy: a.lazy, opencodePermission: a.opencodePermission, instructions: a.instructions })));
        setEdges(c.edges.map((e) => ({ from: e.from, to: e.to, steer: e.steer })));
        setCharter(c.charter ?? "");
        if (c.autoCompact) setAutoCompact(c.autoCompact);
      } catch (e: any) { if (!cancelled) setError(`load config failed: ${String(e?.message ?? e)}`); }
      finally { if (!cancelled) setLoadingCfg(false); }
    })();
    return () => { cancelled = true; };
  }, [route.editOf]);

  // #3 — per-harness model probe (loading/error/retry)
  const probe = async (h: HarnessId, refresh = false) => {
    setProbes((p) => ({ ...p, [h]: { status: "loading", models: p[h]?.models ?? [] } }));
    try {
      const res = await fetch(`/api/harnesses/${encodeURIComponent(h)}/models${refresh ? "?refresh=1" : ""}`, { headers: authHeaders() });
      const body = await res.json();
      if (!res.ok || !Array.isArray(body?.models)) throw new Error(body?.error?.message ?? "bad model probe");
      setProbes((p) => ({ ...p, [h]: { status: "ready", models: body.models } }));
    } catch (e: any) {
      setProbes((p) => ({ ...p, [h]: { status: "error", models: p[h]?.models ?? [], message: String(e?.message ?? e) } }));
    }
  };
  useEffect(() => { for (const h of new Set(agents.map((a) => a.harness))) if (!probes[h]) void probe(h); }, [agents]);

  // C3 — add agent: append, scroll the new row into view, focus its id field.
  useEffect(() => {
    if (justAdded.current == null) return;
    const i = justAdded.current; justAdded.current = null;
    const row = document.querySelectorAll<HTMLElement>("[data-bnw-agent-row]")[i];
    row?.scrollIntoView({ block: "center" });
    row?.querySelector<HTMLInputElement>("input")?.focus();
  }, [agents.length]);

  const setAgent = (i: number, patch: Partial<AgentRow>) => setAgents((a) => a.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const addAgent = () => { justAdded.current = agents.length; setAgents((a) => [...a, blankAgent("member")]); };
  const removeAgent = (i: number) => setAgents((a) => a.filter((_, j) => j !== i));

  const buildConfig = (): MeshConfig => ({
    name: name.trim(),
    agents: agents.map((a): AgentConfig => ({ id: a.id.trim(), harness: a.harness, project: a.project.trim(), role: a.role, lazy: a.lazy, effort: a.effort as ThinkingEffort | undefined, opencodePermission: a.opencodePermission, model: a.model, instructions: a.instructions?.trim() || undefined })),
    edges: edges.filter((e) => e.from && e.to).map((e): MeshEdge => ({ from: e.from, to: e.to, steer: e.steer })),
    charter: charter.trim() || undefined,
    autoCompact,
  });
  const save = async () => {
    setBusy(true); setError(undefined);
    try {
      const res = await store.defineMesh(buildConfig());
      if (res && res.error) throw new Error(res.error.message ?? "validation failed");
      navigate({ k: "runtime", mesh: name.trim() });
    } catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  };

  // Save/Create stays primary to match the approved mockup; Button's disabled-primary state
  // neutralizes its fill in the component layer for a11y.
  const actions = <Cluster><Button variant="ghost" size="sm" aria-label="cancel" onClick={() => navigate(name.trim() && editing ? { k: "runtime", mesh: name.trim() } : { k: "home" })}>Cancel</Button><Button variant="primary" size="sm" busy={busy} disabled={!name.trim() || agents.some((a) => !a.id.trim() || !a.project.trim())} aria-label="save mesh" onClick={() => void save()}>{editing ? "Save" : "Create"}</Button></Cluster>;

  if (loadingCfg) return <PanelFrame title={editing ? `编辑 mesh · ${route.editOf}` : "新建 mesh"}><div className="flex items-center gap-2 text-sm text-text-muted"><Spinner size={14} label="loading" /> 载入配置…</div></PanelFrame>;

  return (
    <div data-bnw-newmesh className="flex h-full min-h-0 flex-col">
      {/* C3: sticky desktop action bar (name echo + Cancel/Save) — reachable while scrolling */}
      <div data-bnw-newmesh-actionbar className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-surface-raised px-3 py-2">
        <span className="text-sm font-semibold">{editing ? "编辑 mesh" : "新建 mesh"}</span>
        {name ? <span className="max-w-[260px] truncate text-sm text-text-muted">· {name}</span> : null}
        <span className="flex-1" aria-hidden="true" />
        {actions}
      </div>
      {/* body scrolls normally — NO nested fixed-height overflow trap on the agent list */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="mx-auto flex max-w-[820px] flex-col gap-5">
          {error ? <ErrorBanner title="无法保存">{error}</ErrorBanner> : null}
          <section className="flex flex-col gap-1.5">
            <label className="text-xs uppercase tracking-wider text-text-muted">mesh name</label>
            <Input value={name} placeholder="my-mesh" aria-label="mesh name" className="max-w-sm" disabled={editing} onChange={(e) => setName(e.target.value)} />
            <span className="text-xs text-text-muted">{editing ? "name is fixed when editing" : "unique; lowercase recommended"}</span>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wider text-text-muted">agents · {agents.length}</span>
              <Button variant="secondary" size="sm" aria-label="add agent" className="whitespace-nowrap" onClick={addAgent}>+ Add agent</Button>
            </div>
            <div className="flex flex-col gap-2">
              {agents.map((a, i) => {
                const pr = probes[a.harness];
                const showEffort = supportsRuntimeEffort(a.harness) && effortOptionsForHarness(a.harness).length > 0;
                return (
                  <div key={i} data-bnw-agent-row className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-raised p-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Input value={a.id} aria-label={`agent ${i + 1} id`} placeholder="agent id" className="w-40" onChange={(e) => setAgent(i, { id: e.target.value })} />
                      <Select value={a.harness} aria-label={`agent ${i + 1} harness`} className="w-32" onChange={(e) => setAgent(i, { harness: e.target.value as HarnessId })}>{HARNESSES.map((h) => <option key={h}>{h}</option>)}</Select>
                      <Select value={a.role} aria-label={`agent ${i + 1} role`} className="w-28" onChange={(e) => setAgent(i, { role: e.target.value as AgentRole, lazy: e.target.value === "router" ? false : a.lazy })}><option value="router">router</option><option value="member">member</option></Select>
                      <span className="flex-1" aria-hidden="true" />
                      <Button variant="ghost" size="sm" iconOnly aria-label={`remove agent ${i + 1}`} disabled={a.role === "router"} onClick={() => removeAgent(i)}>×</Button>
                    </div>
                    <Input value={a.project} aria-label={`agent ${i + 1} project`} placeholder="project path" className="w-full" onChange={(e) => setAgent(i, { project: e.target.value })} />
                    <div className="flex flex-wrap items-center gap-2">
                      {/* #3 model + probe/retry */}
                      <label className="inline-flex items-center gap-1 text-xs text-text-muted">model
                        <Select value={a.model ?? ""} aria-label={`agent ${i + 1} model`} className="w-36" disabled={pr?.status === "loading"} onChange={(e) => setAgent(i, { model: e.target.value || undefined })}>
                          <option value="">(default)</option>
                          {(pr?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                          {a.model && !(pr?.models ?? []).some((m) => m.id === a.model) ? <option value={a.model}>{a.model} (not advertised)</option> : null}
                        </Select>
                      </label>
                      {pr?.status === "loading" ? <Spinner size={12} label="probing models" /> : null}
                      {pr?.status === "error" ? <Button variant="ghost" size="sm" aria-label={`retry models ${a.harness}`} onClick={() => void probe(a.harness, true)}>↻ retry</Button> : null}
                      {/* #4 effort */}
                      {showEffort ? <label className="inline-flex items-center gap-1 text-xs text-text-muted">effort
                        <Select value={a.effort ?? ""} aria-label={`agent ${i + 1} effort`} className="w-24" onChange={(e) => setAgent(i, { effort: e.target.value || undefined })}><option value="">(default)</option>{effortOptionsForHarness(a.harness).map((ef) => <option key={ef} value={ef}>{ef}</option>)}</Select>
                      </label> : null}
                      {/* #5 lazy (router disallowed) */}
                      <label className="inline-flex items-center gap-1.5 text-xs text-text-secondary"><input type="checkbox" className="accent-accent" aria-label={`agent ${i + 1} lazy`} checked={!!a.lazy} disabled={a.role === "router"} onChange={(e) => setAgent(i, { lazy: e.target.checked })} /> lazy</label>
                      {/* #6 opencode permission */}
                      {a.harness === "opencode" ? <label className="inline-flex items-center gap-1 text-xs text-text-muted">permission
                        <Select value={a.opencodePermission ?? "ask"} aria-label={`agent ${i + 1} opencode permission`} className="w-20" onChange={(e) => setAgent(i, { opencodePermission: e.target.value as "ask" | "allow" })}><option>ask</option><option>allow</option></Select>
                      </label> : null}
                      {supportsThinkingToggle(a.harness) ? <span className="text-xs text-text-muted">（kimi thinking 在运行态切换）</span> : null}
                    </div>
                    {/* #1 instructions (≤4000) + #2 expand */}
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-text-muted">instructions (max {MAX_INSTR})</span>
                      <Button variant="ghost" size="sm" aria-label={`expand agent ${i + 1} instructions`} onClick={() => setEditor({ kind: "instructions", idx: i })}>⤢ expand</Button>
                    </div>
                    <Textarea value={a.instructions ?? ""} rows={2} aria-label={`agent ${i + 1} instructions`} placeholder="per-agent instructions…" error={(a.instructions?.length ?? 0) > MAX_INSTR} onChange={(e) => setAgent(i, { instructions: e.target.value })} />
                  </div>
                );
              })}
            </div>
          </section>

          {/* #7 auto-compact */}
          <section className="flex flex-col gap-2">
            <span className="text-xs uppercase tracking-wider text-text-muted">auto-compact</span>
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-1.5 text-sm text-text-secondary"><input type="checkbox" className="accent-accent" aria-label="auto-compact enabled" checked={autoCompact.enabled} onChange={(e) => setAutoCompact((s) => ({ ...s, enabled: e.target.checked }))} /> enable auto-compact</label>
              <label className="inline-flex items-center gap-1 text-xs text-text-muted">threshold<Input value={autoCompact.threshold} aria-label="auto-compact threshold" className="w-20" onChange={(e) => setAutoCompact((s) => ({ ...s, threshold: e.target.value }))} /></label>
            </div>
          </section>

          {/* #8 mail edges + steer */}
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wider text-text-muted">mail edges · {edges.length}</span>
              <Button variant="secondary" size="sm" aria-label="add edge" className="whitespace-nowrap" disabled={agents.length < 2} onClick={() => setEdges((e) => [...e, { from: agents[0]?.id ?? "", to: agents[1]?.id ?? "" }])}>+ Add edge</Button>
            </div>
            <div className="flex flex-col gap-1.5">
              {edges.length === 0 ? <span className="text-xs text-text-muted">no edges yet</span> : edges.map((e, i) => {
                const toRouter = agents.find((a) => a.id === e.to)?.role === "router";
                return (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <Select value={e.from} aria-label={`edge ${i + 1} from`} className="flex-1" onChange={(ev) => setEdges((x) => x.map((y, j) => (j === i ? { ...y, from: ev.target.value } : y)))}>{agents.map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}</Select>
                    <span aria-hidden="true" className="text-text-muted">→</span>
                    <Select value={e.to} aria-label={`edge ${i + 1} to`} className="flex-1" onChange={(ev) => setEdges((x) => x.map((y, j) => (j === i ? { ...y, to: ev.target.value, steer: toRouterId(agents, ev.target.value) ? false : y.steer } : y)))}>{agents.map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}</Select>
                    <label className="inline-flex shrink-0 items-center gap-1 text-xs text-text-secondary"><input type="checkbox" className="accent-accent" aria-label={`edge ${i + 1} steer`} checked={!!e.steer} disabled={toRouter} onChange={(ev) => setEdges((x) => x.map((y, j) => (j === i ? { ...y, steer: ev.target.checked } : y)))} /> steer</label>
                    <Button variant="ghost" size="sm" iconOnly aria-label={`remove edge ${i + 1}`} onClick={() => setEdges((x) => x.filter((_, j) => j !== i))}>×</Button>
                  </div>
                );
              })}
            </div>
          </section>

          {/* charter (optional) + #2 expand */}
          <section className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs uppercase tracking-wider text-text-muted">charter (optional)</label>
              <Button variant="ghost" size="sm" aria-label="expand charter" onClick={() => setEditor({ kind: "charter" })}>⤢ expand</Button>
            </div>
            <Textarea value={charter} rows={2} aria-label="charter" placeholder="shared goal + working norms…" onChange={(e) => setCharter(e.target.value)} />
          </section>
        </div>
      </div>
      {/* C3 mobile: fixed Save footer (the whole screen scrolls above) */}
      <div data-bnw-newmesh-footer className="sticky bottom-0 z-10 flex shrink-0 items-center justify-between gap-2 border-t border-border bg-surface-raised px-3 py-2 lg:hidden">
        <span className="min-w-0 flex-1 truncate text-xs text-text-muted">{name || "未命名 mesh"}</span>
        {actions}
      </div>

      {editor ? (
        <TextEditorDialog
          title={editor.kind === "charter" ? "Charter" : `${agents[editor.idx]?.id || `agent ${editor.idx + 1}`} · instructions`}
          value={editor.kind === "charter" ? charter : (agents[editor.idx]?.instructions ?? "")}
          onApply={(v) => editor.kind === "charter" ? setCharter(v) : setAgent(editor.idx, { instructions: v })}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </div>
  );
}
function toRouterId(agents: AgentRow[], id: string) { return agents.find((a) => a.id === id)?.role === "router"; }
