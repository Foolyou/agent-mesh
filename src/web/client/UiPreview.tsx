// ISOLATED design preview (Step 5, pre-C5) — NOT part of the product.
//
// Route-guarded at /__ui-preview (index.tsx mounts this instead of <Boot/> for that
// path; server.ts serves the SPA shell there). It renders representative UI samples
// using ONLY the real semantic Tailwind utilities (tailwind.css @theme) + the v2
// `compose()` runtime, with a compact 3×3 mode/accent switcher so the user can see
// the actual two-axis token system before the full component library (C5) is built.
//
// Development/design intent only. It does NOT touch business flows, device-auth, the
// store, or the WebSocket. To remove: delete this file, the `/__ui-preview` branch in
// index.tsx, and the `/__ui-preview` route in server.ts. No raw-* utilities are used
// (passes `bun run lint:tokens`); all classes are literal so Tailwind generates them.
import { useEffect, useState } from "react";
import { MODES, ACCENTS, type Mode, type Accent, compose, applyComposition } from "./themes";

const MODE_LABEL: Record<Mode, string> = {
  "dark-slate": "Dark·Slate",
  "light-cool": "Light·Cool",
  "eye-care-warm": "Eye-care·Warm",
};
const ACCENT_LABEL: Record<Accent, string> = {
  "signal-teal": "Signal Teal",
  ember: "Ember",
  "fleet-azure": "Fleet Azure",
};
const MODE_SET = new Set<Mode>(MODES);
const ACCENT_SET = new Set<Accent>(ACCENTS);

function initialMode(): Mode {
  const requested = new URLSearchParams(window.location.search).get("mode");
  return MODE_SET.has(requested as Mode) ? (requested as Mode) : "dark-slate";
}

function initialAccent(): Accent {
  const requested = new URLSearchParams(window.location.search).get("accent");
  return ACCENT_SET.has(requested as Accent) ? (requested as Accent) : "signal-teal";
}

// Status rows use LITERAL class strings (Tailwind scans source text; interpolated
// class names like `bg-${name}` would not be generated).
const STATUS = [
  { name: "success", fill: "bg-success text-on-success", subtle: "bg-success-subtle text-success", dot: "bg-success" },
  { name: "warning", fill: "bg-warning text-on-warning", subtle: "bg-warning-subtle text-warning", dot: "bg-warning" },
  { name: "danger", fill: "bg-danger text-on-danger", subtle: "bg-danger-subtle text-danger", dot: "bg-danger" },
  { name: "info", fill: "bg-info text-on-info", subtle: "bg-info-subtle text-info", dot: "bg-info" },
];

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-surface-raised border border-border rounded-xl p-4">
      <h2 className="text-xs uppercase tracking-wider text-text-muted mb-3">{title}</h2>
      {children}
    </section>
  );
}

export function UiPreview() {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [accent, setAccent] = useState<Accent>(initialAccent);

  // Drive the REAL runtime: recolor every semantic utility by rewriting :root vars.
  useEffect(() => {
    applyComposition(compose(mode, accent));
  }, [mode, accent]);

  return (
    <div className="min-h-screen bg-surface text-text-primary font-sans p-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold mb-1">Agent Mesh — UI preview (v2 tokens · live compose)</h1>
        <p className="text-sm text-text-secondary mb-4">Real semantic Tailwind utilities + the runtime two-axis token system. Pick a background mode and an accent — all 9 combinations.</p>
        <div className="flex flex-wrap gap-6">
          <div>
            <div className="text-xs uppercase tracking-wider text-text-muted mb-2">Background mode</div>
            <div className="flex gap-2">
              {MODES.map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={
                    "px-3 py-1.5 rounded-lg text-sm border " +
                    (m === mode ? "bg-accent text-on-accent border-accent" : "bg-surface-raised text-text-secondary border-border-strong")
                  }
                >
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-text-muted mb-2">Accent</div>
            <div className="flex gap-2">
              {ACCENTS.map((a) => (
                <button
                  key={a}
                  onClick={() => setAccent(a)}
                  className={
                    "px-3 py-1.5 rounded-lg text-sm border " +
                    (a === accent ? "bg-accent text-on-accent border-accent" : "bg-surface-raised text-text-secondary border-border-strong")
                  }
                >
                  {ACCENT_LABEL[a]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-2" style={{ maxWidth: 1180 }}>
        <Card title="StatusChip">
          <div className="flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-success-subtle text-success"><span className="w-1.5 h-1.5 rounded-full bg-success" />ready</span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-accent-subtle text-accent"><span className="w-1.5 h-1.5 rounded-full bg-accent" />working</span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-warning-subtle text-warning"><span className="w-1.5 h-1.5 rounded-full bg-warning" />attention</span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-danger-subtle text-danger"><span className="w-1.5 h-1.5 rounded-full bg-danger" />blocked</span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs text-idle"><span className="w-1.5 h-1.5 rounded-full bg-idle" />idle</span>
          </div>
        </Card>

        <Card title="Button states">
          <div className="flex flex-wrap gap-2 items-center">
            <button className="px-3.5 py-1.5 rounded-lg text-sm font-medium bg-accent text-on-accent">Primary</button>
            <button className="px-3.5 py-1.5 rounded-lg text-sm font-medium bg-surface-raised text-text-primary border border-border-strong">Default</button>
            <button className="px-3.5 py-1.5 rounded-lg text-sm font-medium bg-danger text-on-danger">Danger</button>
            <button className="px-3.5 py-1.5 rounded-lg text-sm font-medium bg-surface-raised text-text-disabled border border-border" disabled>Disabled</button>
          </div>
        </Card>

        <Card title="StatusListRow">
          <div className="flex items-center gap-2 px-2 py-2 rounded-lg">
            <span className="w-2 h-2 rounded-full bg-success" />
            <span className="text-sm flex-1">mesh · alpha</span>
            <span className="text-xs text-text-muted">3 agents</span>
          </div>
          <div className="flex items-center gap-2 px-2 py-2 rounded-lg bg-selected">
            <span className="w-2 h-2 rounded-full bg-accent" />
            <span className="text-sm flex-1 text-text-on-selected">mesh · beta (selected)</span>
            <span className="text-xs text-text-muted">working</span>
          </div>
        </Card>

        <Card title="ApprovalCard">
          <div className="border-l-4 border-accent pl-3 py-1">
            <div className="text-sm mb-2">Allow <b>write</b> to src/?</div>
            <div className="flex gap-2">
              <button className="px-3 py-1.5 rounded-lg text-sm font-medium bg-accent text-on-accent">Approve</button>
              <button className="px-3 py-1.5 rounded-lg text-sm font-medium bg-danger text-on-danger">Deny</button>
            </div>
          </div>
        </Card>

        <Card title="Composer">
          <div className="flex gap-2 items-center">
            <div className="flex-1 bg-surface-sunken border border-border-strong rounded-lg px-3 py-2 text-sm text-text-muted">Type an instruction…</div>
            <button className="px-3.5 py-2 rounded-lg text-sm font-medium bg-accent text-on-accent">Send</button>
          </div>
        </Card>

        <Card title="Transcript bubbles">
          <div className="flex flex-col gap-2">
            <div className="self-end max-w-[80%] bg-surface-raised border border-border rounded-xl px-3 py-2 text-sm">user: restart the alpha mesh</div>
            <div className="self-start max-w-[80%] bg-surface border border-border rounded-xl px-3 py-2 text-sm text-text-secondary">agent: restarting alpha… <span className="text-syntax-string">done</span></div>
          </div>
        </Card>

        <Card title="Status: filled (on-status) + subtle">
          <div className="flex flex-col gap-2">
            {STATUS.map((s) => (
              <div key={s.name} className="flex items-center gap-2">
                <span className="w-20 text-xs text-text-muted font-mono">{s.name}</span>
                <span className={"px-2.5 py-1 rounded-md text-xs font-semibold " + s.fill}>filled · on-{s.name}</span>
                <span className={"px-2.5 py-1 rounded-md text-xs " + s.subtle}>{s.name}-subtle</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Code (syntax on surface-sunken)">
          <pre className="bg-surface-sunken rounded-lg p-3 text-xs font-mono overflow-x-auto"><span className="text-syntax-keyword">const</span> x = <span className="text-syntax-string">"signal"</span>; <span className="text-syntax-comment">// accent</span></pre>
        </Card>
      </div>
    </div>
  );
}
