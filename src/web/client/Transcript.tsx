// Renders an aggregated TranscriptItem[] as message bubbles, collapsible thought
// blocks, and tool-call cards that update in place. The aggregation already happened
// upstream (transcript reducer); this is pure presentation.
import { useEffect, useRef, useState } from "react";
import type { TranscriptItem } from "../types";
import { Empty, fmtTime } from "./ui";

function Msg({ item }: { item: Extract<TranscriptItem, { kind: "message" }> }) {
  return (
    <div className={`msg ${item.role}`}>
      <div className="who">
        {item.role === "user" ? "you" : "agent"} <span className="t">{fmtTime(item.ts)}</span>
      </div>
      <div className="bubble">
        {item.text}
        {!item.complete && item.role === "agent" ? <span className="cursor" /> : null}
      </div>
    </div>
  );
}

function Thought({ item }: { item: Extract<TranscriptItem, { kind: "thought" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thought">
      <span className="label" onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} thinking{!item.complete ? "…" : ""}
      </span>
      {open ? <div className="txt">{item.text}</div> : null}
    </div>
  );
}

const TOOL_ICONS: Record<string, string> = {
  read: "◎",
  edit: "✎",
  delete: "✕",
  move: "→",
  search: "⌕",
  execute: "❯",
  think: "✻",
  fetch: "↧",
  switch_mode: "⇄",
  other: "▪",
};

function ToolCard({ item }: { item: Extract<TranscriptItem, { kind: "tool_call" }> }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!(item.output || item.input || item.locations?.length);
  return (
    <div className="tool">
      <div className="thead" onClick={() => hasDetail && setOpen((o) => !o)} style={{ cursor: hasDetail ? "pointer" : "default" }}>
        <span className="ico">{TOOL_ICONS[item.toolKind ?? "other"] ?? "▪"}</span>
        <span className="ttitle">{item.title}</span>
        {hasDetail ? <span className="kbd">{open ? "−" : "+"}</span> : null}
        <span className={`badge ${item.status}`}>{item.status.replace("_", " ")}</span>
      </div>
      {open && hasDetail ? (
        <div className="tdetail">
          {item.input ? (
            <>
              <div className="tlabel">input</div>
              <div className="tout">{item.input}</div>
            </>
          ) : null}
          {item.locations?.length ? (
            <>
              <div className="tlabel">files</div>
              <div className="tout">{item.locations.join("\n")}</div>
            </>
          ) : null}
          {item.output ? (
            <>
              <div className="tlabel">output</div>
              <div className="tout">{item.output}</div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const PLAN_MARK: Record<string, string> = { completed: "✓", in_progress: "▸", pending: "○" };

function PlanCard({ item }: { item: Extract<TranscriptItem, { kind: "plan" }> }) {
  const done = item.entries.filter((e) => e.status === "completed").length;
  return (
    <div className="plan">
      <div className="plan-head">
        plan <span className="sub">{done}/{item.entries.length}</span>
      </div>
      {item.entries.map((e, i) => (
        <div className={`plan-row ${e.status}`} key={i}>
          <span className="mark">{PLAN_MARK[e.status] ?? "○"}</span>
          <span className="ptext">{e.content}</span>
        </div>
      ))}
    </div>
  );
}

export function Transcript({ items }: { items: TranscriptItem[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  // autoscroll to bottom when content changes, unless the user scrolled up
  const wrapRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  useEffect(() => {
    if (stick) endRef.current?.scrollIntoView({ block: "end" });
  }, [items, stick]);

  function onScroll() {
    const el = wrapRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setStick(atBottom);
  }

  if (!items.length) return <Empty>no messages yet</Empty>;
  return (
    <div className="stream" ref={wrapRef} onScroll={onScroll}>
      {items.map((it) =>
        it.kind === "message" ? (
          <Msg key={it.id} item={it} />
        ) : it.kind === "thought" ? (
          <Thought key={it.id} item={it} />
        ) : it.kind === "tool_call" ? (
          <ToolCard key={it.id} item={it} />
        ) : (
          <PlanCard key={it.id} item={it} />
        ),
      )}
      <div ref={endRef} />
    </div>
  );
}
