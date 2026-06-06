// Renders an aggregated TranscriptItem[] as message bubbles, collapsible thought
// blocks, and tool-call cards that update in place. The aggregation already happened
// upstream (transcript reducer); this is pure presentation.
import { useEffect, useRef, useState } from "react";
import type { TranscriptItem } from "../types";
import { Empty } from "./ui";

function Msg({ item }: { item: Extract<TranscriptItem, { kind: "message" }> }) {
  return (
    <div className={`msg ${item.role}`}>
      <div className="who">{item.role === "user" ? "you" : "agent"}</div>
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
  const hasOut = !!item.output;
  return (
    <div className="tool">
      <div className="thead" onClick={() => hasOut && setOpen((o) => !o)} style={{ cursor: hasOut ? "pointer" : "default" }}>
        <span className="ico">{TOOL_ICONS[item.toolKind ?? "other"] ?? "▪"}</span>
        <span className="ttitle">{item.title}</span>
        {hasOut ? <span className="kbd">{open ? "−" : "+"}</span> : null}
        <span className={`badge ${item.status}`}>{item.status.replace("_", " ")}</span>
      </div>
      {open && hasOut ? <div className="tout">{item.output}</div> : null}
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
        ) : (
          <ToolCard key={it.id} item={it} />
        ),
      )}
      <div ref={endRef} />
    </div>
  );
}
