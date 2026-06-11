// A chat pane = transcript + composer, where clicking anywhere in the pane focuses
// the input (so you don't have to hit the small textarea exactly). Text selection and
// interactive elements (buttons, tool/thought toggles) are preserved.
import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import type { PromptImageRef, TranscriptItem } from "../types";
import type { QueueItem, QueueSummary } from "../types";
import { Composer } from "./ui";
import { Transcript } from "./Transcript";
import type { AuthorRef } from "./AuthorContext";
import { useI18n } from "./i18n";

const INTERACTIVE = "button, a, input, textarea, select, .thought .label, .tool .thead";

export function queueNavState(items: QueueItem[], selectedId?: string, selectedIndex?: number, defaultId?: string): { item?: QueueItem; index: number; canPrev: boolean; canNext: boolean } {
  if (!items.length) return { index: -1, canPrev: false, canNext: false };
  const found = selectedId ? items.findIndex((item) => item.id === selectedId) : -1;
  const defaultIndex = defaultId ? items.findIndex((item) => item.id === defaultId) : -1;
  const fallbackIndex = selectedIndex === undefined ? (defaultIndex >= 0 ? defaultIndex : items.length - 1) : Math.min(Math.max(selectedIndex, 0), items.length - 1);
  const index = found >= 0 ? found : fallbackIndex;
  return { item: items[index], index, canPrev: index > 0, canNext: index < items.length - 1 };
}

export function queueSourceLabel(item: QueueItem): string {
  if (item.source === "mail") return `mail${item.from ? ` · ${item.from}` : ""}`;
  if (item.source === "steer") return `steer${item.from ? ` · ${item.from}` : ""}`;
  return "you";
}

export function queuePreviewText(item: QueueItem): string {
  if (item.preview.startsWith("you: ")) return item.preview.slice("you: ".length);
  if (item.preview.startsWith("mail:")) return item.preview.replace(/^mail:\s*/, "");
  if (item.preview.startsWith("steer:")) return item.preview.replace(/^steer:\s*/, "");
  const fromPrefix = item.from ? `${item.from}: ` : "";
  if (fromPrefix && item.preview.startsWith(fromPrefix)) return item.preview.slice(fromPrefix.length);
  return item.preview;
}

function queueItems(queue?: QueueSummary): QueueItem[] {
  if (!queue?.count) return [];
  if (queue.items?.length) return queue.items;
  if (!queue.latestPreview) return [];
  return [{ id: "__latest__", source: "operator", from: "operator", preview: queue.latestPreview, ts: "" }];
}

export function isRemovableQueueItem(item: QueueItem): boolean {
  return item.id !== "__latest__" && (item.source === "operator" || (item.source === "steer" && item.from === "operator"));
}

export function ChatPane({
  items,
  onSend,
  onInterrupt,
  onRemoveQueued,
  onUploadImages,
  placeholder,
  disabled,
  working,
  imageEnabled,
  imageDisabledReason,
  queue,
  author,
}: {
  items: TranscriptItem[];
  onSend: (text: string, images?: PromptImageRef[], opts?: { steer?: boolean }) => void | Promise<void>;
  onInterrupt?: () => void | Promise<void>;
  onRemoveQueued?: (item: QueueItem) => void | Promise<void>;
  onUploadImages?: (files: File[]) => Promise<PromptImageRef[]>;
  placeholder?: string;
  disabled?: boolean;
  working?: boolean;
  imageEnabled?: boolean;
  imageDisabledReason?: string;
  queue?: QueueSummary;
  author?: AuthorRef;
}) {
  const { t } = useI18n();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [selectedQueueId, setSelectedQueueId] = useState<string | undefined>();
  const [selectedQueueIndex, setSelectedQueueIndex] = useState<number | undefined>();
  const [queuePinned, setQueuePinned] = useState(false);
  const queued = queueItems(queue);
  const nav = queueNavState(queued, queuePinned ? selectedQueueId : undefined, queuePinned ? selectedQueueIndex : undefined, queue?.latestId);

  useEffect(() => {
    if (!queued.length) {
      setSelectedQueueId(undefined);
      setSelectedQueueIndex(undefined);
      setQueuePinned(false);
      return;
    }
    if (!queuePinned) return;
    if (nav.item && (nav.item.id !== selectedQueueId || nav.index !== selectedQueueIndex)) {
      setSelectedQueueId(nav.item.id);
      setSelectedQueueIndex(nav.index);
    }
  }, [queuePinned, queued.map((item) => item.id).join("\u0000"), nav.item?.id, nav.index, selectedQueueId, selectedQueueIndex]);

  function focusOnClick(e: MouseEvent<HTMLDivElement>) {
    if (disabled) return;
    // don't steal focus mid-selection or when clicking something interactive
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    taRef.current?.focus();
  }

  function selectQueueOffset(offset: number) {
    const nextIndex = nav.index + offset;
    const next = queued[nextIndex];
    if (!next) return;
    const latestId = queue?.latestId ?? queued[queued.length - 1]?.id;
    if (next.id === latestId) {
      setSelectedQueueId(undefined);
      setSelectedQueueIndex(undefined);
      setQueuePinned(false);
      return;
    }
    setSelectedQueueId(next.id);
    setSelectedQueueIndex(nextIndex);
    setQueuePinned(true);
  }

  function removeQueued(item: QueueItem) {
    if (!isRemovableQueueItem(item)) return;
    void onRemoveQueued?.(item);
  }

  return (
    <div className="chat" onClick={focusOnClick}>
      <Transcript items={items} author={author} />
      {queue?.count && nav.item ? (
        <div
          className="queue-box"
          title={queuePreviewText(nav.item)}
          aria-live="polite"
          aria-label={`queued messages, ${queue.count}`}
          tabIndex={0}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" && nav.canPrev) {
              e.preventDefault();
              selectQueueOffset(-1);
            } else if (e.key === "ArrowDown" && nav.canNext) {
              e.preventDefault();
              selectQueueOffset(1);
            }
          }}
        >
          <span className="queue-count">{t("queue.count", { current: nav.index + 1, count: queue.count })}</span>
          <span className={`queue-source ${nav.item.source}`}>{queueSourceLabel(nav.item)}</span>
          <span className="queue-preview">{queuePreviewText(nav.item)}</span>
          <span className="queue-nav">
            {isRemovableQueueItem(nav.item) && onRemoveQueued ? (
              <button
                type="button"
                className="queue-nav-btn queue-remove-btn"
                aria-label="remove queued message"
                title="remove queued message"
                onClick={() => removeQueued(nav.item!)}
              >
                -
              </button>
            ) : null}
            <button
              type="button"
              className="queue-nav-btn"
              aria-label="previous queued message"
              disabled={!nav.canPrev}
              onClick={() => selectQueueOffset(-1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="queue-nav-btn"
              aria-label="next queued message"
              disabled={!nav.canNext}
              onClick={() => selectQueueOffset(1)}
            >
              ↓
            </button>
          </span>
        </div>
      ) : null}
      <Composer
        ref={taRef}
        onSend={onSend}
        onInterrupt={onInterrupt}
        onUploadImages={onUploadImages}
        placeholder={placeholder}
        disabled={disabled}
        working={working}
        imageEnabled={imageEnabled}
        imageDisabledReason={imageDisabledReason}
      />
    </div>
  );
}
