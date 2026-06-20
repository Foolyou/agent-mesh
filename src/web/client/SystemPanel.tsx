// System health / process panel (mesh-ps-doctor commit 3). Renders the SHARED diagnostics model
// fetched from the device-auth-gated `/api/diagnostics/{doctor,ps}` endpoints — it derives no
// diagnostic logic of its own, it only displays. The API responses are already secret-free (the
// builders emit counts/booleans/redacted detail), so this view never has a raw credential to leak.
import { useEffect, useState } from "react";
import type { Store } from "./store";
import type { AgentDetail, DoctorReport, MeshProcDetail, ProcLeak, PsDetail, Severity } from "../types";
import { Btn } from "./ui";

// Severity is conveyed by a text label (not colour alone) for accessibility; the glyph is decorative.
const SEV_GLYPH: Record<Severity, string> = { ok: "✓", info: "·", warning: "!", error: "✗" };
const SEV_WORD: Record<Severity, string> = { ok: "ok", info: "info", warning: "warning", error: "error" };

export function SystemPanel({ store, open, onClose }: { store: Store; open: boolean; onClose: () => void }) {
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [ps, setPs] = useState<PsDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [d, p] = await Promise.all([store.fetchDoctor(), store.fetchPsDetail()]);
      setDoctor(d);
      setPs(p);
    } catch (e: any) {
      setError(e?.message ? String(e.message) : "failed to load system status");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  if (!open) return null;

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal system-modal" role="dialog" aria-modal="true" aria-label="System health and processes" onClick={(e) => e.stopPropagation()}>
        <div className="mhead">
          <span>System health</span>
          <span className="spacer" />
          <Btn small kind="ghost" onClick={() => void refresh()} ariaLabel="Refresh system status">refresh</Btn>
          <Btn small kind="ghost" onClick={onClose} ariaLabel="Close system health">close</Btn>
        </div>
        <div className="mbody" aria-busy={loading}>
          {error ? <div className="system-error" role="alert">{error}</div> : null}
          <DoctorSection report={doctor} />
          <ProcessSection ps={ps} />
          {!doctor && !ps && !error ? <div className="system-empty">loading…</div> : null}
        </div>
      </div>
    </div>
  );
}

export function DoctorSection({ report }: { report: DoctorReport | null }) {
  if (!report) return null;
  const s = report.summary;
  return (
    <section className="system-section" aria-label="Health checks">
      <div className="system-section-head">
        <span className="system-section-title">checks</span>
        <span className={`system-summary sev-${s.worst}`}>
          {s.total} checks · {s.ok} ok · {s.warnings} warning · {s.errors} error · worst: {SEV_WORD[s.worst]}
        </span>
      </div>
      <div className="system-checks">
        {report.checks.map((c) => (
          <div className={`system-check sev-${c.severity}`} key={c.id}>
            <span className={`sev-mark sev-${c.severity}`} aria-hidden="true">{SEV_GLYPH[c.severity]}</span>
            <span className="system-check-body">
              <span className="system-check-id">{c.id}</span>
              <span className="sev-tag">{SEV_WORD[c.severity]}</span>
              <span className="system-check-detail">{c.detail}</span>
              {c.fixHint ? <span className="system-check-fix">fix: {c.fixHint}</span> : null}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ProcessSection({ ps }: { ps: PsDetail | null }) {
  if (!ps) return null;
  return (
    <section className="system-section" aria-label="Processes">
      <div className="system-section-head">
        <span className="system-section-title">processes</span>
        <span className="system-summary">{ps.running.length} running · {ps.leaks.length} leak{ps.leaks.length === 1 ? "" : "s"}</span>
      </div>
      {ps.running.length === 0 ? <div className="system-empty">no running meshes</div> : null}
      {ps.running.map((m) => <MeshRow key={m.name} mesh={m} />)}
      {ps.leaks.map((l) => <LeakRow key={`${l.kind}:${l.name}`} leak={l} />)}
    </section>
  );
}

function MeshRow({ mesh }: { mesh: MeshProcDetail }) {
  return (
    <div className="system-mesh">
      <div className="system-mesh-head">
        <span className="system-mesh-name">{mesh.name}</span>
        <span className="system-mesh-meta">pid {mesh.pid}</span>
      </div>
      <div className="system-mesh-sock" title={mesh.socketPath}>{mesh.socketPath}</div>
      {mesh.agents.length ? (
        <div className="system-agents">
          {mesh.agents.map((a) => <AgentRow key={a.id} agent={a} />)}
        </div>
      ) : (
        <div className="system-agents-empty">agent detail unavailable</div>
      )}
    </div>
  );
}

function AgentRow({ agent }: { agent: AgentDetail }) {
  const ctx = agent.contextPercent !== undefined ? `${agent.contextPercent}%` : null;
  return (
    <div className="system-agent">
      <span className="system-agent-id">{agent.id}</span>
      {agent.harness ? <span className="system-agent-tag">{agent.harness}</span> : null}
      {agent.role ? <span className="system-agent-tag">{agent.role}</span> : null}
      <span className={`system-agent-activity act-${agent.activity}`}>{agent.activity}</span>
      {ctx ? <span className="system-agent-ctx" title={`context ${agent.contextUsed}/${agent.contextSize} tokens`}>ctx {ctx}</span> : null}
    </div>
  );
}

function LeakRow({ leak }: { leak: ProcLeak }) {
  return (
    <div className="system-leak sev-warning">
      <span className="sev-mark sev-warning" aria-hidden="true">!</span>
      <span className="system-leak-body">
        <span className="system-leak-name">{leak.name}</span>
        <span className="sev-tag">{leak.kind === "stale_record" ? "stale record" : "orphan socket"}</span>
        <span className="system-check-detail">{leak.detail}</span>
      </span>
    </div>
  );
}
