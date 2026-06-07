// Shared presentational primitives for the console.
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import type { AgentStatus, MeshStatus } from "../types";

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
  onSend: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
}>(function Composer({ onSend, placeholder, disabled }, ref) {
  const [v, setV] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => taRef.current!, []);

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
      if (v.trim()) {
        onSend(v.trim());
        setV("");
      }
    }
  }
  return (
    <div className={`composer ${disabled ? "disabled" : ""}`}>
      <span className="prompt">›</span>
      <textarea
        ref={taRef}
        rows={1}
        value={v}
        disabled={disabled}
        placeholder={placeholder ?? "type a message…  (Enter to send · Shift+Enter for newline)"}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={onKey}
      />
    </div>
  );
});

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
