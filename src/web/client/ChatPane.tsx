// A chat pane = transcript + composer, where clicking anywhere in the pane focuses
// the input (so you don't have to hit the small textarea exactly). Text selection and
// interactive elements (buttons, tool/thought toggles) are preserved.
import { useRef } from "react";
import type { MouseEvent } from "react";
import type { TranscriptItem } from "../types";
import { Composer } from "./ui";
import { Transcript } from "./Transcript";

const INTERACTIVE = "button, a, input, textarea, select, .thought .label, .tool .thead";

export function ChatPane({
  items,
  onSend,
  placeholder,
  disabled,
}: {
  items: TranscriptItem[];
  onSend: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
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
      <Transcript items={items} />
      <Composer ref={taRef} onSend={onSend} placeholder={placeholder} disabled={disabled} />
    </div>
  );
}
