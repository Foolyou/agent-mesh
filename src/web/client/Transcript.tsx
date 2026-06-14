// Renders an aggregated TranscriptItem[] as message bubbles, collapsible thought
// blocks, and tool-call cards that update in place. The aggregation already happened
// upstream (transcript reducer); this is pure presentation.
import { useLayoutEffect, useRef, useState } from "react";
import type { TranscriptItem } from "../types";
import { Empty, fmtTime } from "./ui";
import { useI18n } from "./i18n";
import { Markdown } from "./Markdown";
import { AuthorContext, type AuthorRef } from "./AuthorContext";
import { VirtualTranscript } from "./VirtualTranscript";
import type { TranscriptMeasurementCacheScope } from "./transcript-measurement-cache";

export const VIRTUAL_THRESHOLD = 200;

function Msg({ item, author }: { item: Extract<TranscriptItem, { kind: "message" }>; author?: AuthorRef }) {
  const { t } = useI18n();
  const [lightbox, setLightbox] = useState<{ url: string; name: string } | null>(null);
  const markdown = item.role === "agent" ? (
    <AuthorContext.Provider value={author}>
      <Markdown text={item.text} />
    </AuthorContext.Provider>
  ) : (
    <Markdown text={item.text} />
  );
  return (
    <div className={`msg ${item.role}`}>
      <div className="who">
        {item.role === "user" ? t("you") : t("agent")} <span className="t">{fmtTime(item.ts)}</span>
      </div>
      <div className="bubble">
        {markdown}
        {item.images?.length ? (
          <div className="sent-images">
            {item.images.map((img) => (
              <button className="sent-image" key={img.url ?? img.id} type="button" title={img.name} onClick={() => setLightbox({ url: img.url ?? "", name: img.name })}>
                <img src={img.url} alt={img.name} loading="lazy" />
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {lightbox ? (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <button className="lightbox-close" type="button" title="close" onClick={() => setLightbox(null)}>
            ×
          </button>
          <img src={lightbox.url} alt={lightbox.name} />
        </div>
      ) : null}
    </div>
  );
}

function Thought({ item, author }: { item: Extract<TranscriptItem, { kind: "thought" }>; author?: AuthorRef }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="thought">
      <span className="label" onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} {t("thinking")}
        {!item.complete ? "…" : ""}
      </span>
      {open ? (
        <div className="txt">
          <AuthorContext.Provider value={author}>
            <Markdown text={item.text} />
          </AuthorContext.Provider>
        </div>
      ) : null}
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
  const { t } = useI18n();
  const hasDetail = !!(item.output || item.input || item.locations?.length);
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? false;
  return (
    <div className="tool">
      <div className="thead" onClick={() => hasDetail && setOverride(!open)} style={{ cursor: hasDetail ? "pointer" : "default" }}>
        <span className="ico">{TOOL_ICONS[item.toolKind ?? "other"] ?? "▪"}</span>
        <span className="ttitle">{item.title}</span>
        {item.locations?.length ? <span className="tloc">{item.locations[0]}</span> : null}
        {hasDetail ? <span className="kbd">{open ? "−" : "+"}</span> : null}
        <span className={`badge ${item.status}`}>{item.status.replace("_", " ")}</span>
      </div>
      {open && hasDetail ? (
        <div className="tdetail">
          {item.input ? (
            <>
              <div className="tlabel">{t("tool.input")}</div>
              <div className="tout">{item.input}</div>
            </>
          ) : null}
          {item.locations?.length ? (
            <>
              <div className="tlabel">{t("tool.files")}</div>
              <div className="tout">{item.locations.join("\n")}</div>
            </>
          ) : null}
          {item.output ? (
            <>
              <div className="tlabel">{t("tool.output")}</div>
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
  const { t } = useI18n();
  const done = item.entries.filter((e) => e.status === "completed").length;
  return (
    <div className="plan">
      <div className="plan-head">
        {t("plan")} <span className="sub">{done}/{item.entries.length}</span>
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

function Divider() {
  const { t } = useI18n();
  return (
    <div className="session-divider" role="separator">
      <span>{t("session.reset.divider")}</span>
    </div>
  );
}

function CompactEntry({ item }: { item: Extract<TranscriptItem, { kind: "compact" }> }) {
  const detail = item.status === "failed" ? item.error : item.reason;
  return (
    <details className={`compact-entry ${item.status}`}>
      <summary>
        <span>--- Context Compacted ---</span>
        <span className="compact-status">{item.status}</span>
      </summary>
      {detail ? <div className="compact-meta">{detail}</div> : null}
    </details>
  );
}

const MAIL_COLLAPSED_LINES = 3;

export function mailFoldInitialLineCount(body: string): number {
  return Math.max(1, body.split(/\r\n|\r|\n/).length);
}

export function nextMailExpanded(expanded: boolean): boolean {
  return !expanded;
}

export function mailFoldButtonLabel(expanded: boolean, hiddenLines: number, lang: "en" | "zh" = "en"): string {
  if (expanded) return lang === "zh" ? "收起邮件" : "show less";
  return lang === "zh" ? `展开邮件 (+${hiddenLines} 行)` : `show more (+${hiddenLines} lines)`;
}

function measuredLineHeight(el: HTMLElement): number {
  const styles = window.getComputedStyle(el);
  const parsed = Number.parseFloat(styles.lineHeight);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const fontSize = Number.parseFloat(styles.fontSize);
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.45 : 18;
}

function MailBubble({ item, meshId }: { item: Extract<TranscriptItem, { kind: "mail" }>; meshId?: string }) {
  const { t, lang } = useI18n();
  const author = meshId ? { meshId, agent: item.from } : undefined;
  const bodyId = `mail-body-${item.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [lineCount, setLineCount] = useState(() => mailFoldInitialLineCount(item.body));
  const [lineHeight, setLineHeight] = useState<number | null>(null);
  const foldable = lineCount > MAIL_COLLAPSED_LINES;
  const collapsed = foldable && !expanded;
  const hiddenLines = Math.max(0, lineCount - MAIL_COLLAPSED_LINES);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof window === "undefined") return;
    const measure = () => {
      const lh = measuredLineHeight(el);
      const fullHeight = Math.max(el.scrollHeight, el.clientHeight);
      setLineHeight(lh);
      setLineCount(Math.max(1, Math.ceil(fullHeight / lh)));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [item.body, expanded]);

  return (
    <div className="msg mail">
      <div className="who">
        ✉ {t("mail.from", { from: item.from })} <span className="t">{fmtTime(item.ts)}</span>
      </div>
      <div className="bubble">
        <div
          id={bodyId}
          ref={bodyRef}
          className={`mail-fold ${collapsed ? "collapsed" : "expanded"}`}
          style={collapsed && lineHeight ? { maxHeight: `${lineHeight * MAIL_COLLAPSED_LINES}px` } : undefined}
        >
          <AuthorContext.Provider value={author}>
            <Markdown text={item.body} />
          </AuthorContext.Provider>
          {collapsed ? <span className="mail-fade-gradient" aria-hidden="true" /> : null}
        </div>
        {foldable ? (
          <button className="mail-expand-btn" type="button" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded((open) => nextMailExpanded(open))}>
            <span aria-hidden="true">{expanded ? "▴" : "▾"}</span> {mailFoldButtonLabel(expanded, hiddenLines, lang)}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function TranscriptRow({ item, author }: { item: TranscriptItem; author?: AuthorRef }) {
  return item.kind === "message" ? (
    <Msg item={item} author={author} />
  ) : item.kind === "thought" ? (
    <Thought item={item} author={author} />
  ) : item.kind === "tool_call" ? (
    <ToolCard item={item} />
  ) : item.kind === "mail" ? (
    <MailBubble item={item} meshId={author?.meshId} />
  ) : item.kind === "compact" ? (
    <CompactEntry item={item} />
  ) : item.kind === "divider" ? (
    <Divider />
  ) : (
    <PlanCard item={item} />
  );
}

export function isTranscriptAtBottom(
  scroll: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  threshold = 40,
): boolean {
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= threshold;
}

export const TRANSCRIPT_SCROLL_DIR_THRESHOLD = 4;

export function didTranscriptScrollUp(currentScrollTop: number, previousScrollTop: number, threshold = TRANSCRIPT_SCROLL_DIR_THRESHOLD): boolean {
  return currentScrollTop < previousScrollTop - threshold;
}

export function nextTranscriptStickState(current: boolean, atBottom: boolean, userInitiatedScroll: boolean, wentUp: boolean): boolean {
  if (atBottom) return true;
  if (userInitiatedScroll && wentUp) return false;
  return current;
}

export function isTranscriptScrollIntentKey(key: string): boolean {
  return ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(key);
}

export function Transcript({
  items,
  author,
  cacheScope,
  hasMore,
  onLoadOlder,
}: {
  items: TranscriptItem[];
  author?: AuthorRef;
  cacheScope?: TranscriptMeasurementCacheScope;
  hasMore?: boolean;
  onLoadOlder?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const endRef = useRef<HTMLDivElement>(null);
  // autoscroll to bottom when content changes, unless the user scrolled up
  const wrapRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimerRef = useRef<number | undefined>(undefined);
  const lastScrollTopRef = useRef(0);
  const [stick, setStick] = useState(true);
  function syncLastScrollTop() {
    const el = wrapRef.current;
    if (el) lastScrollTopRef.current = el.scrollTop;
  }
  function markUserScrollIntent() {
    syncLastScrollTop();
    userScrollIntentRef.current = true;
    if (userScrollIntentTimerRef.current !== undefined) window.clearTimeout(userScrollIntentTimerRef.current);
    userScrollIntentTimerRef.current = window.setTimeout(() => {
      userScrollIntentRef.current = false;
      userScrollIntentTimerRef.current = undefined;
    }, 350);
  }
  useLayoutEffect(() => {
    if (stickRef.current) {
      endRef.current?.scrollIntoView({ block: "end" });
      syncLastScrollTop();
    }
    const raf = requestAnimationFrame(() => {
      if (stickRef.current) {
        endRef.current?.scrollIntoView({ block: "end" });
        syncLastScrollTop();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [items, stick]);
  useLayoutEffect(() => {
    const tail = endRef.current?.previousElementSibling;
    if (!tail || !stick || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) {
        endRef.current?.scrollIntoView({ block: "end" });
        syncLastScrollTop();
      }
    });
    ro.observe(tail);
    return () => ro.disconnect();
  }, [items, stick]);
  useLayoutEffect(() => {
    return () => {
      if (userScrollIntentTimerRef.current !== undefined) window.clearTimeout(userScrollIntentTimerRef.current);
    };
  }, []);

  function onScroll() {
    const el = wrapRef.current;
    if (!el) return;
    const scrollTop = el.scrollTop;
    const wentUp = didTranscriptScrollUp(scrollTop, lastScrollTopRef.current);
    lastScrollTopRef.current = scrollTop;
    const atBottom = isTranscriptAtBottom(el);
    const nextStick = nextTranscriptStickState(stickRef.current, atBottom, userScrollIntentRef.current, wentUp);
    stickRef.current = nextStick;
    setStick(nextStick);
  }

  function jumpToBottom() {
    stickRef.current = true;
    setStick(true);
    wrapRef.current?.focus({ preventScroll: true });
    syncLastScrollTop();
  }

  if (!items.length) return <Empty>{t("empty.messages")}</Empty>;
  if (items.length > VIRTUAL_THRESHOLD) {
    return <VirtualTranscript items={items} cacheScope={cacheScope} hasMore={hasMore} onLoadOlder={onLoadOlder} renderItem={(item) => <TranscriptRow item={item} author={author} />} />;
  }
  return (
    <div className="stream-shell">
      <div
        className="stream"
        ref={wrapRef}
        onScroll={onScroll}
        onWheel={markUserScrollIntent}
        onTouchMove={markUserScrollIntent}
        onKeyDown={(e) => {
          if (isTranscriptScrollIntentKey(e.key)) markUserScrollIntent();
        }}
        tabIndex={-1}
      >
        {items.map((it) => <TranscriptRow key={it.id} item={it} author={author} />)}
        <div ref={endRef} />
      </div>
      {!stick ? (
        <button className="jump-bottom" type="button" title={t("transcript.jumpBottom")} aria-label={t("transcript.jumpBottom")} onClick={jumpToBottom}>
          <span aria-hidden="true">↓</span>
        </button>
      ) : null}
    </div>
  );
}
