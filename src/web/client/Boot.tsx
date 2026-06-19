// Boot gate (design device-auth.md §4.1): before the console (and its WebSocket) loads, check
// authorization against the REAL server gate via bootAuthorized() — so a loopback-only dev/host
// session (no token, server-trusted) opens normally, while an unauthorized remote sees a MINIMAL
// device-code page that polls for approval. The page never surfaces internal failure reasons.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { App } from "./App";
import { bootAuthorized, runEnrollment, submitBootstrap, type DeviceAuthPhase } from "./device-auth";

type BootPhase = "checking" | "authorized" | "unauthorized";

export function Boot() {
  const [phase, setPhase] = useState<BootPhase>("checking");
  useEffect(() => {
    let cancelled = false;
    bootAuthorized().then((ok) => {
      if (!cancelled) setPhase(ok ? "authorized" : "unauthorized");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase === "authorized") return <App />;
  if (phase === "checking") {
    return (
      <div className="boot-gate">
        <div className="boot-card">
          <div className="boot-msg">Checking device authorization…</div>
        </div>
      </div>
    );
  }
  return <UnauthorizedPage onApproved={() => setPhase("authorized")} />;
}

// Coarse, user-facing status text. Deliberately vague: no internal codes / reasons leak here.
function statusLine(s: DeviceAuthPhase): string {
  if (s === "revoked") return "This device is not authorized. Ask the operator to approve a new code, then refresh.";
  if (s === "unknown") return "This code is no longer valid. Refresh to request a new one.";
  return "Waiting for approval…"; // pending
}

function UnauthorizedPage({ onApproved }: { onApproved: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [status, setStatus] = useState<DeviceAuthPhase>("pending");
  const [failed, setFailed] = useState(false);
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [bootstrapBusy, setBootstrapBusy] = useState(false);
  const [bootstrapError, setBootstrapError] = useState(false);
  const started = useRef(false);

  async function onSubmitBootstrap(e: FormEvent) {
    e.preventDefault();
    const token = bootstrapToken.trim();
    if (!token || bootstrapBusy) return;
    setBootstrapBusy(true);
    setBootstrapError(false);
    const ok = await submitBootstrap(token);
    setBootstrapBusy(false);
    if (ok) onApproved();
    else setBootstrapError(true); // generic — never reveals which part failed
  }

  useEffect(() => {
    if (started.current) return; // StrictMode double-invoke guard: enroll exactly once
    started.current = true;
    let cancelled = false;
    runEnrollment(
      { onCode: (c) => !cancelled && setCode(c), onStatus: (s) => !cancelled && setStatus(s) },
      fetch,
      undefined,
      () => !cancelled,
    ).then((outcome) => {
      if (cancelled) return;
      if (outcome === "approved") onApproved();
      else if (outcome === "failed") setFailed(true);
      // revoked / unknown: statusLine already shown via onStatus; polling has stopped → prompt refresh.
    });
    return () => {
      cancelled = true;
    };
  }, [onApproved]);

  return (
    <div className="boot-gate">
      <div className="boot-card" role="dialog" aria-label="Device authorization required">
        <div className="boot-title">Device authorization required</div>
        {failed ? (
          <div className="boot-msg">Couldn’t reach the server. Refresh to try again.</div>
        ) : code ? (
          <>
            <div className="boot-msg">Give this code to the host operator to authorize this device:</div>
            <div className="boot-code" aria-label="device code">
              {code}
            </div>
            <div className="boot-msg">{statusLine(status)}</div>
            <form className="boot-form" onSubmit={onSubmitBootstrap}>
              <div className="boot-msg">Or paste a one-time bootstrap token from the host log:</div>
              <input
                type="text"
                className="boot-input"
                aria-label="bootstrap token"
                autoComplete="off"
                spellCheck={false}
                value={bootstrapToken}
                onChange={(e) => setBootstrapToken(e.target.value)}
                placeholder="bootstrap token"
              />
              <button type="submit" className="btn" disabled={bootstrapBusy || !bootstrapToken.trim()}>
                {bootstrapBusy ? "Authorizing…" : "Authorize this device"}
              </button>
              {bootstrapError ? <div className="boot-msg">Couldn’t authorize with that token. Check it and try again.</div> : null}
            </form>
          </>
        ) : (
          <div className="boot-msg">Requesting a device code…</div>
        )}
      </div>
    </div>
  );
}
