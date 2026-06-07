// Shared presentational primitives for the console.
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
  type ReactNode,
  type KeyboardEvent,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import type { AgentStatus, MeshStatus, PromptImageRef } from "../types";

export function Dot({ status }: { status: AgentStatus | MeshStatus | string }) {
  return <span className={`dot ${status}`} title={status} />;
}

export function Btn({
  children,
  onClick,
  kind,
  disabled,
  title,
  small,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "go" | "stop" | "ghost";
  disabled?: boolean;
  title?: string;
  small?: boolean;
}) {
  return (
    <button
      className={`btn ${kind ?? ""} ${small ? "sm" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

export function Panel({
  title,
  sub,
  right,
  children,
  bodyClass,
}: {
  title: string;
  sub?: string;
  right?: ReactNode;
  children: ReactNode;
  bodyClass?: string;
}) {
  return (
    <div className="panel">
      <div className="head">
        <span className="ttl">{title}</span>
        {sub ? <span className="sub">{sub}</span> : null}
        {right ? <span className="right">{right}</span> : null}
      </div>
      <div className={bodyClass ?? "body-scroll"}>{children}</div>
    </div>
  );
}

/** Auto-growing, wrapping multi-line input. Enter sends, Shift+Enter inserts a
 *  newline. Exposes its <textarea> via ref so a parent can focus-on-click. */
export const Composer = forwardRef<HTMLTextAreaElement, {
  onSend: (text: string, images?: PromptImageRef[]) => void | Promise<void>;
  onUploadImages?: (files: File[]) => Promise<PromptImageRef[]>;
  placeholder?: string;
  disabled?: boolean;
  imageEnabled?: boolean;
  imageDisabledReason?: string;
}>(function Composer({ onSend, onUploadImages, placeholder, disabled, imageEnabled, imageDisabledReason }, ref) {
  const [v, setV] = useState("");
  const [pending, setPending] = useState<{ file: File; url: string }[]>([]);
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => taRef.current!, []);

  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  useEffect(() => () => {
    for (const p of pendingRef.current) URL.revokeObjectURL(p.url);
  }, []);

  // grow with content (wrap at the edge), up to a cap then scroll
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [v]);

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    e.stopPropagation(); // keep keystrokes out of the global shortcuts
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  function addFiles(files: File[]) {
    // Attaching is always allowed while the composer is enabled; capability only governs whether
    // the images are actually sent (the server drops them for agents without image support).
    if (disabled) return;
    const next = [...pending];
    for (const file of files) {
      const reason = validateImageFile(file, next.length);
      if (reason) {
        setErr(reason);
        continue;
      }
      next.push({ file, url: URL.createObjectURL(file) });
    }
    setPending(next);
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (disabled) return;
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  }

  async function submit() {
    if (sending || disabled) return;
    const text = v.trim();
    if (!text && !pending.length) return;
    setSending(true);
    setErr("");
    try {
      // Only upload + attach images when the target agent advertises image support. Otherwise the
      // server would drop them anyway, so we skip the upload and the user keeps the warning below.
      const images = imageEnabled && pending.length && onUploadImages ? await onUploadImages(pending.map((p) => p.file)) : [];
      await onSend(text, images);
      for (const p of pending) URL.revokeObjectURL(p.url);
      setPending([]);
      setV("");
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSending(false);
    }
  }

  function removePending(i: number) {
    const p = pending[i];
    if (p) URL.revokeObjectURL(p.url);
    setPending(pending.filter((_, idx) => idx !== i));
  }

  const canAttach = !disabled;
  // images were attached to an agent that can't receive them — they'll be dropped on send
  const imagesWontSend = pending.length > 0 && imageEnabled === false;
  return (
    <div className={`composer ${disabled ? "disabled" : ""}`} onDragOver={(e) => canAttach && e.preventDefault()} onDrop={onDrop}>
      <span className="prompt">›</span>
      <div className="compose-main">
        {pending.length ? (
          <div className="attach-strip">
            {pending.map((p, i) => (
              <span className="pending-img" key={p.url}>
                <img src={p.url} alt={p.file.name} />
                <button type="button" title="remove image" onClick={() => removePending(i)}>
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={taRef}
          rows={1}
          value={v}
          disabled={disabled || sending}
          placeholder={placeholder ?? "type a message…  (Enter to send · Shift+Enter for newline)"}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
        />
        {imagesWontSend ? <div className="compose-warn">⚠ {imageDisabledReason ?? "this agent can’t receive images — they won’t be sent"}</div> : null}
        {err ? <div className="compose-error">{err}</div> : null}
      </div>
      <button
        className="attach-btn"
        type="button"
        disabled={!canAttach || sending}
        title={imageEnabled ? "attach image" : imageDisabledReason ?? "this agent may not accept images"}
        onClick={() => fileRef.current?.click()}
      >
        📎
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []));
          e.currentTarget.value = "";
        }}
      />
    </div>
  );
});

export function validateImageFile(file: File, currentCount: number): string | undefined {
  if (currentCount >= 5) return "at most 5 images per message";
  if (file.size > 10 * 1024 * 1024) return "image is too large (max 10 MB)";
  if (file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg")) return "SVG images are not allowed";
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) return "only PNG, JPEG, GIF, and WebP images are supported";
  return undefined;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** A compact "ⓘ" that reveals a description on hover — declutters panel headers. */
export function InfoIcon({ text }: { text: string }) {
  return (
    <span className="info-icon" title={text} aria-label={text}>
      ⓘ
    </span>
  );
}

/** Two-click confirm button (no native dialog) — first click arms, second confirms. */
export function ConfirmButton({
  children,
  confirmLabel,
  onConfirm,
  kind,
  small,
  title,
}: {
  children: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  kind?: "go" | "stop" | "ghost";
  small?: boolean;
  title?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={`btn ${armed ? "stop" : kind ?? ""} ${small ? "sm" : ""}`}
      title={title}
      onClick={() => {
        if (armed) {
          onConfirm();
          setArmed(false);
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? confirmLabel ?? "confirm?" : children}
    </button>
  );
}

export function fmtTime(ts: string): string {
  // ISO → HH:MM:SS, robust to bad input
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "--:--:--";
  return d.toTimeString().slice(0, 8);
}
