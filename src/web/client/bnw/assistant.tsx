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
import { useI18n, tStatus } from "../i18n";

function asstDot(s: AssistantStatus, working?: boolean): Status {
  if (s === "ready") return working ? "working" : "ready";
  if (s === "starting") return "attention";
  if (s === "absent") return "blocked";
  return "idle"; // stopped
}

export function BnwAssistant({ store, state, full }: { store: Store; state: GatewayState; full: boolean }) {
  const { t } = useI18n();
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
      title={t("bnw.assistantFull")}
      description={tStatus(t, asst.status)}
      actions={<Cluster>
        <StatusChip status={asstDot(asst.status, working)} variant="dot" />
        <RouteLink href={bnwHref({ k: "assistant", full: !full })} className="text-sm" aria-label={full ? "exit fullscreen" : "fullscreen"}>{full ? `⊟ ${t("bnw.as.exitFull")}` : `⊞ ${t("bnw.as.full")}`}</RouteLink>
      </Cluster>}
      className="h-full" bodyClassName="flex min-h-0 flex-1 flex-col gap-2"
    >
      <p className="text-xs text-text-muted">{t("bnw.as.intro")}</p>
      <div ref={scrollRef} data-bnw-assistant-transcript className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
        {asst.transcript.length === 0 ? (
          <EmptyState title={t("bnw.as.emptyTitle")} description={t("bnw.as.emptyDesc")} />
        ) : asst.transcript.map((it) => <TranscriptItemView key={it.id} it={it} />)}
      </div>
      <Composer
        ariaLabel="Assistant composer"
        actions={<div className="flex items-center gap-2">
          {working ? <Button size="sm" variant="ghost" aria-label="interrupt assistant" onClick={() => void store.interruptAssistant()}>{t("bnw.rt.interrupt")}</Button> : null}
          <Button size="sm" variant="primary" busy={busy} disabled={!text.trim()} aria-label="send" onClick={() => void send()}>{t("bnw.rt.send")}</Button>
        </div>}
        hint={working ? t("bnw.as.working") : undefined}
      >
        <Textarea aria-label="assistant input" rows={2} value={text} placeholder={t("bnw.as.placeholder")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
      </Composer>
    </PanelFrame>
  );

  if (full) return <div data-bnw-assistant="full" className="fixed inset-0 z-40 bg-surface p-3">{column}</div>;
  return <div data-bnw-assistant="panel" className="h-full">{column}</div>;
}
