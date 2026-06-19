import { useEffect, useMemo, useState } from "react";
import type { Store } from "./store";
import type { FeishuChannelStatus, FeishuMeshChatEnsureResult, FeishuProvisionJobPublic, MeshSummary } from "../types";
import { Btn, Dot } from "./ui";

type Job = FeishuProvisionJobPublic | null;

export function FeishuPanel({ store, open, meshes, onClose }: { store: Store; open: boolean; meshes: MeshSummary[]; onClose: () => void }) {
  const [status, setStatus] = useState<FeishuChannelStatus | null>(null);
  const [job, setJob] = useState<Job>(null);
  const [syncing, setSyncing] = useState(false);
  const [results, setResults] = useState<FeishuMeshChatEnsureResult[]>([]);
  const [err, setErr] = useState("");

  const bindings = useMemo(() => new Map((status?.bindings ?? []).map((b) => [b.mesh, b])), [status]);
  const busy = job?.state === "starting" || job?.state === "waiting";

  async function refresh() {
    setErr("");
    try {
      setStatus(await store.getFeishuStatus());
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open]);

  useEffect(() => {
    if (!open || !busy || !job?.id) return;
    const timer = window.setInterval(() => {
      void store.getFeishuProvision(job.id).then((next) => {
        setJob(next);
        if (next.state === "complete") void refresh();
      }).catch((e) => setErr(String(e?.message ?? e)));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [open, busy, job?.id]);

  if (!open) return null;

  async function startProvision() {
    setErr("");
    setResults([]);
    const next = await store.startFeishuProvision({
      enable: true,
      botName: "Legion",
      requireMention: false,
      appName: "Legion",
      appDescription: "Agent Mesh Feishu gateway bot",
      createOnly: true,
      autoCreateMeshChats: true,
      replaceExisting: true,
    });
    setJob(next);
  }

  async function cancelProvision() {
    if (!job?.id) return;
    setJob(await store.cancelFeishuProvision(job.id));
  }

  async function syncAll() {
    setSyncing(true);
    setErr("");
    try {
      const rows = await store.syncFeishuMeshChats();
      setResults(rows);
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSyncing(false);
    }
  }

  async function createGroup(mesh: string) {
    setErr("");
    try {
      const row = await store.ensureFeishuMeshChat(mesh);
      setResults((cur) => [row, ...cur.filter((x) => x.mesh !== mesh)]);
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal feishu-modal" role="dialog" aria-modal="true" aria-label="Feishu settings" onClick={(e) => e.stopPropagation()}>
        <div className="mhead">
          <span>Feishu</span>
          <span className="spacer" />
          <Btn small kind="ghost" onClick={() => void refresh()} ariaLabel="Refresh Feishu status">refresh</Btn>
          <Btn small kind="ghost" onClick={onClose} ariaLabel="Close Feishu settings">close</Btn>
        </div>
        <div className="mbody feishu-body">
          <div className="feishu-status-row">
            <Dot status={dotStatus(status)} />
            <div>
              <div className="feishu-title">{statusLabel(status)}</div>
              <div className="feishu-meta">{status?.appId ?? status?.reason ?? "not configured"}</div>
            </div>
            <span className="spacer" />
            <Btn kind="go" disabled={busy} onClick={() => void startProvision()}>
              {status?.appId ? "Bind new bot" : "Bind bot"}
            </Btn>
          </div>

          {job ? (
            <div className={`feishu-job ${job.state}`}>
              <div className="feishu-job-head">
                <span>{job.state}</span>
                <span className="spacer" />
                {busy ? <Btn small kind="ghost" onClick={() => void cancelProvision()}>cancel</Btn> : null}
              </div>
              {job.qrCodeDataUrl ? <img className="feishu-qr" src={job.qrCodeDataUrl} alt="Feishu authorization QR code" /> : null}
              {job.verificationUrl ? <a className="feishu-link" href={job.verificationUrl} target="_blank" rel="noreferrer">open authorization link</a> : null}
              {job.error ? <div className="inline-err">{job.error}</div> : null}
            </div>
          ) : null}

          <div className="feishu-section-head">
            <span>Mesh groups</span>
            <span className="spacer" />
            <Btn small kind="ghost" disabled={!status?.enabled || syncing} onClick={() => void syncAll()}>
              {syncing ? "syncing" : "sync all"}
            </Btn>
          </div>

          <div className="feishu-grid">
            {meshes.map((mesh) => {
              const binding = bindings.get(mesh.name);
              const result = results.find((r) => r.mesh === mesh.name);
              return (
                <div className="feishu-mesh-row" key={mesh.name}>
                  <div>
                    <div className="feishu-title">{mesh.name}</div>
                    <div className="feishu-meta">{binding?.chatId ?? result?.error ?? "no group"}</div>
                  </div>
                  <span className={`harness-badge ${binding ? "ok" : result?.ok === false ? "bad" : "off"}`}>
                    {binding ? "bound" : result?.ok === false ? "failed" : "missing"}
                  </span>
                  {!binding ? (
                    <Btn small kind="ghost" disabled={!status?.enabled || busy} onClick={() => void createGroup(mesh.name)}>
                      create group
                    </Btn>
                  ) : null}
                </div>
              );
            })}
          </div>
          {err ? <div className="inline-err" role="alert">{err}</div> : null}
        </div>
      </div>
    </div>
  );
}

function statusLabel(status: FeishuChannelStatus | null): string {
  if (!status) return "loading";
  if (status.state === "running") return `running · ${status.bindings?.length ?? 0} groups`;
  if (status.enabled) return status.state;
  return "disabled";
}

function dotStatus(status: FeishuChannelStatus | null): string {
  if (!status) return "starting";
  if (status.state === "running") return "ready";
  if (status.state === "error") return "dead";
  return "stopped";
}
