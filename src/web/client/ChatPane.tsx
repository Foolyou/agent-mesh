// A chat pane = transcript + composer, where clicking anywhere in the pane focuses
// the input (so you don't have to hit the small textarea exactly). Text selection and
// interactive elements (buttons, tool/thought toggles) are preserved.
import { useRef } from "react";
import type { MouseEvent } from "react";
import type { PromptImageRef, TranscriptItem } from "../types";
import { Composer } from "./ui";
import { Transcript } from "./Transcript";
import type { AuthorRef } from "./AuthorContext";

const INTERACTIVE = "button, a, input, textarea, select, .thought .label, .tool .thead";

export function ChatPane({
  items,
  onSend,
  onInterrupt,
  onUploadImages,
  placeholder,
  disabled,
  working,
  steerEnabled,
  imageEnabled,
  imageDisabledReason,
  author,
}: {
  items: TranscriptItem[];
  onSend: (text: string, images?: PromptImageRef[], opts?: { steer?: boolean }) => void | Promise<void>;
  onInterrupt?: () => void | Promise<void>;
  onUploadImages?: (files: File[]) => Promise<PromptImageRef[]>;
  placeholder?: string;
  disabled?: boolean;
  working?: boolean;
  steerEnabled?: boolean;
  imageEnabled?: boolean;
  imageDisabledReason?: string;
  author?: AuthorRef;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  function focusOnClick(e: MouseEvent<HTMLDivElement>) {
    if (disabled) return;
    // don't steal focus mid-selection or when clicking something interactive
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    taRef.current?.focus();
  }

  return (
    <div className="chat" onClick={focusOnClick}>
      <Transcript items={items} author={author} />
      <Composer
        ref={taRef}
        onSend={onSend}
        onInterrupt={onInterrupt}
        onUploadImages={onUploadImages}
        placeholder={placeholder}
        disabled={disabled}
        working={working}
        steerEnabled={steerEnabled}
        imageEnabled={imageEnabled}
        imageDisabledReason={imageDisabledReason}
      />
    </div>
  );
}
