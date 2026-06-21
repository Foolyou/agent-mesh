// Step 7.3 — new /bnw Mesh Assistant B, wired to the REAL store: state.assistant
// (status/transcript/working) + promptAssistant / interruptAssistant. Independent view layer;
// shares the store only; does NOT import the old assistant/chat view. Mirrors mockup 05 +
// coverage/05. Parity #21: assistant fullscreen (?full=1, URL-driven).
import { useEffect, useRef, useState } from "react";
import { Button, Cluster, Composer, EmptyState, PanelFrame, RouteLink, StatusChip, Textarea, type Status } from "../ui/index";
import type { Store } from "../store";
import type { GatewayState } from "../../types";
import type { AssistantStatus } from "../../types";
import { bnwHref } from "../router";
import { TranscriptItemView } from "./runtime";

function asstDot(s: AssistantStatus, working?: boolean): Status {
  if (s === "ready") return working ? "working" : "ready";
  if (s === "starting") return "attention";
  if (s === "absent") return "blocked";
  return "idle"; // stopped
}

export function BnwAssistant({ store, state, full }: { store: Store; state: GatewayState; full: boolean }) {
  const asst = state.assistant;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const working = !!asst.working;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const itemCount = asst.transcript.length;
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [itemCount]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try { await store.promptAssistant(t); setText(""); } finally { setBusy(false); }
  };

  const column = (
    <PanelFrame
      title="Mesh Assistant"
      description={asst.status}
      actions={<Cluster>
        <StatusChip status={asstDot(asst.status, working)} variant="dot" />
        <RouteLink href={bnwHref({ k: "assistant", full: !full })} className="text-sm" aria-label={full ? "exit fullscreen" : "fullscreen"}>{full ? "⊟ 退出全屏" : "⊞ 全屏"}</RouteLink>
      </Cluster>}
      className="h-full" bodyClassName="flex min-h-0 flex-1 flex-col gap-2"
    >
      <p className="text-xs text-text-muted">全局构建助手：描述目标，助手用 mesh-build 工具帮你搭/调 mesh。</p>
      <div ref={scrollRef} data-bnw-assistant-transcript className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
        {asst.transcript.length === 0 ? (
          <EmptyState title="开始对话" description="例如：建一个 router(claude) + codex 成员的 app mesh。" />
        ) : asst.transcript.map((it) => <TranscriptItemView key={it.id} it={it} />)}
      </div>
      <Composer
        ariaLabel="Assistant composer"
        actions={<div className="flex items-center gap-2">
          {working ? <Button size="sm" variant="ghost" aria-label="interrupt assistant" onClick={() => void store.interruptAssistant()}>打断</Button> : null}
          <Button size="sm" variant="secondary" busy={busy} disabled={!text.trim()} aria-label="send" onClick={() => void send()}>Send</Button>
        </div>}
        hint={working ? "assistant 正在工作…" : undefined}
      >
        <Textarea aria-label="assistant input" rows={2} value={text} placeholder="给 Mesh Assistant 发消息…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
      </Composer>
    </PanelFrame>
  );

  if (full) return <div data-bnw-assistant="full" className="fixed inset-0 z-40 bg-surface p-3">{column}</div>;
  return <div data-bnw-assistant="panel" className="h-full">{column}</div>;
}
