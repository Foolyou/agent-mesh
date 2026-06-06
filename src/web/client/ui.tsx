// Shared presentational primitives for the console.
import { useEffect, useState, type ReactNode, type KeyboardEvent } from "react";
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

/** Single-line input that submits on Enter and clears. */
export function Composer({
  onSend,
  placeholder,
  disabled,
}: {
  onSend: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [v, setV] = useState("");
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && v.trim()) {
      onSend(v.trim());
      setV("");
    }
    // keep keystrokes out of the global keyboard shortcuts
    e.stopPropagation();
  }
  return (
    <div className={`composer ${disabled ? "disabled" : ""}`}>
      <span className="prompt">›</span>
      <input
        value={v}
        disabled={disabled}
        placeholder={placeholder ?? "type a message…"}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={onKey}
      />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
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
