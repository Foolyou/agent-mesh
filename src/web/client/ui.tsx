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
import { useI18n } from "./i18n";

export function Dot({ status }: { status: AgentStatus | MeshStatus | string }) {
  return <span className={`dot ${status}`} title={status} />;
}

export function Btn({
  children,
  onClick,
  kind,
  disabled,
  title,
  ariaLabel,
  ariaDescribedBy,
  small,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "go" | "stop" | "ghost";
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  small?: boolean;
}) {
  return (
    <button
      className={`btn ${kind ?? ""} ${small ? "sm" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
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
// Flat, dependency-free line icons for the composer action buttons (feather-style strokes,
// inheriting currentColor). aria-hidden — the buttons carry the accessible label.
function AttachIcon() {
  return (
    <svg className="compose-btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
function SendIcon() {
  return (
    <svg className="compose-btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}
function StopIcon() {
  return (
    <svg className="compose-btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

export const Composer = forwardRef<HTMLTextAreaElement, {
  onSend: (text: string, images?: PromptImageRef[], opts?: { steer?: boolean }) => void | Promise<void>;
  onInterrupt?: () => void | Promise<void>;
  onUploadImages?: (files: File[]) => Promise<PromptImageRef[]>;
  placeholder?: string;
  disabled?: boolean;
  working?: boolean;
  imageEnabled?: boolean;
  imageDisabledReason?: string;
}>(function Composer({ onSend, onInterrupt, onUploadImages, placeholder, disabled, working, imageEnabled, imageDisabledReason }, ref) {
  const { t } = useI18n();
  const [v, setV] = useState("");
  const [pending, setPending] = useState<{ file: File; url: string }[]>([]);
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);
  const refocusAfterSend = useRef(false);
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

  useEffect(() => {
    if (sending || !refocusAfterSend.current) return;
    refocusAfterSend.current = false;
    taRef.current?.focus({ preventScroll: true });
  }, [sending]);

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    e.stopPropagation();
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

  async function submit(opts?: { steer?: boolean }) {
    if (sending || disabled) return;
    const text = v.trim();
    if (!text && !pending.length) return;
    setSending(true);
    setErr("");
    try {
      // Only upload + attach images when the target agent advertises image support. Otherwise the
      // server would drop them anyway, so we skip the upload and the user keeps the warning below.
      const images = imageEnabled && pending.length && onUploadImages ? await onUploadImages(pending.map((p) => p.file)) : [];
      await onSend(text, images, opts);
      for (const p of pending) URL.revokeObjectURL(p.url);
      setPending([]);
      setV("");
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      refocusAfterSend.current = true;
      setSending(false);
    }
  }

  function removePending(i: number) {
    const p = pending[i];
    if (p) URL.revokeObjectURL(p.url);
    setPending(pending.filter((_, idx) => idx !== i));
  }

  const canAttach = !disabled;
  // Only show the interrupt button while the agent actually has an in-flight turn; when idle the
  // primary action is "send" instead. (Idle gating — the interrupt is not merely disabled, it is
  // not rendered.)
  const showInterrupt = !!onInterrupt && !!working;
  const canSend = !disabled && !sending && (v.trim().length > 0 || pending.length > 0);
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
          placeholder={placeholder ?? "type a message…  (Enter send · Shift+Enter newline)"}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
        />
        {imagesWontSend ? <div className="compose-warn">⚠ {imageDisabledReason ?? "this agent can’t receive images — they won’t be sent"}</div> : null}
        {err ? <div className="compose-error">{err}</div> : null}
      </div>
      <div className="compose-actions">
        <button
          className="compose-btn attach-btn"
          type="button"
          disabled={!canAttach || sending}
          title={imageEnabled ? "attach image" : imageDisabledReason ?? "this agent may not accept images"}
          aria-label={imageEnabled ? "attach image" : imageDisabledReason ?? "attach image"}
          onClick={() => fileRef.current?.click()}
        >
          <AttachIcon />
        </button>
        {showInterrupt ? (
          <button
            className="compose-btn compose-interrupt"
            type="button"
            disabled={disabled || sending}
            title={t("interrupt.current")}
            aria-label={t("interrupt.current")}
            onClick={() => void onInterrupt?.()}
          >
            <StopIcon />
          </button>
        ) : (
          <button
            className="compose-btn compose-send"
            type="button"
            disabled={!canSend}
            title={t("send")}
            aria-label={t("send")}
            onClick={() => void submit()}
          >
            <SendIcon />
          </button>
        )}
      </div>
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
  ariaLabel,
}: {
  children: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  kind?: "go" | "stop" | "ghost";
  small?: boolean;
  title?: string;
  ariaLabel?: string;
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
      aria-label={armed ? confirmLabel ?? "confirm?" : ariaLabel}
      aria-live="polite"
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
