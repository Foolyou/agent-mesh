// ISOLATED design gallery (Step 5 C8) — NOT part of the product.
//
// Route-guarded at /__ui-preview (index.tsx mounts this instead of <Boot/> for that
// path; server.ts serves the SPA shell there ONLY when MESH_UI_PREVIEW=1). It is the
// complete component gallery for the v2 design system: it renders the REAL C5–C7
// components from ./ui (not hand-drawn markup) across representative states, with a
// live 3×3 mode×accent switcher driven by the real compose()/applyComposition()
// runtime and query deep-links (?mode=&accent=&section=) for deterministic shots.
//
// Development/design intent only. It never touches business flows, device-auth, the
// store, or the WebSocket. To remove: delete this file, the `/__ui-preview` branch in
// index.tsx, and the `/__ui-preview` route + guard in server.ts. No raw-* utilities
// are used (passes `bun run lint:tokens`); all classes are literal so Tailwind emits them.
//
// Live review: `MESH_UI_PREVIEW=1 bun run src/main.ts run --fake --port 15080` then
// open http://localhost:15080/__ui-preview (the route 404s without MESH_UI_PREVIEW=1).
import { useEffect, useState, type ReactNode } from "react";
import { MODES, ACCENTS, type Mode, type Accent, compose, applyComposition } from "./themes";
import {
  Button, ConfirmButton, StatusChip, Badge, RouteLink, Input, Textarea, Select, Spinner, Skeleton, ProgressBar,
  PanelFrame, SegmentedControl, StatusListRow, EmptyState, ErrorBanner, ActionBar, Cluster,
  ApprovalCard, Composer, AttachmentCard, VersionLine, AssigneeTag,
  type Status,
} from "./ui/index";

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
const STATUSES: Status[] = ["ready", "working", "blocked", "attention", "idle", "done"];

interface Selection {
  mode: Mode;
  accent: Accent;
  section: string;
}

function readSelection(): Selection {
  const search = typeof window !== "undefined" ? window.location.search : "";
  const p = new URLSearchParams(search);
  const m = p.get("mode");
  const a = p.get("accent");
  return {
    mode: MODE_SET.has(m as Mode) ? (m as Mode) : "dark-slate",
    accent: ACCENT_SET.has(a as Accent) ? (a as Accent) : "signal-teal",
    section: p.get("section") ?? "all",
  };
}

export function UiPreview() {
  const [sel, setSel] = useState<Selection>(readSelection);
  const { mode, accent, section } = sel;

  // Drive the REAL runtime: recolor every semantic utility by rewriting :root vars.
  useEffect(() => {
    applyComposition(compose(mode, accent));
  }, [mode, accent]);

  // Keep state in sync with back/forward and externally-set deep links.
  useEffect(() => {
    const onPop = () => setSel(readSelection());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const nav = (next: Partial<Selection>) => {
    const merged = { ...sel, ...next };
    setSel(merged);
    const p = new URLSearchParams();
    p.set("mode", merged.mode);
    p.set("accent", merged.accent);
    if (merged.section !== "all") p.set("section", merged.section);
    window.history.replaceState({}, "", `/__ui-preview?${p.toString()}`);
  };

  // Interactive demo state.
  const [seg, setSeg] = useState("list");
  const [progress, setProgress] = useState(42);
  const [approved, setApproved] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const sections: { id: string; title: string; node: ReactNode }[] = [
    {
      id: "buttons",
      title: "Button / ConfirmButton",
      node: (
        <div className="flex flex-wrap gap-2 items-center">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Link</Button>
          <Button variant="primary" size="sm">Small</Button>
          <Button busy>Busy</Button>
          <Button disabled>Disabled</Button>
          <Button iconOnly aria-label="settings">⚙</Button>
          <ConfirmButton onConfirm={() => {}}>Delete mesh</ConfirmButton>
          <ConfirmButton variant="primary" onConfirm={() => {}}>Publish</ConfirmButton>
        </div>
      ),
    },
    {
      id: "statuschip",
      title: "StatusChip",
      node: (
        <div className="flex flex-col gap-2">
          {STATUSES.map((s) => (
            <div key={s} className="flex items-center gap-2">
              <span className="w-20 text-xs text-text-muted">{s}</span>
              <StatusChip status={s} variant="dot" />
              <StatusChip status={s} variant="worded" />
              <StatusChip status={s} variant="soft" />
              <StatusChip status={s} variant="filled" />
              <StatusChip status={s} count={3} />
            </div>
          ))}
        </div>
      ),
    },
    {
      id: "badge",
      title: "Badge",
      node: (
        <div className="flex flex-wrap gap-3 items-center">
          <Badge count={3} tone="neutral" />
          <Badge count={7} tone="accent" />
          <Badge count={12} tone="info" />
          <Badge count={5} tone="urgent" />
          <Badge count={250} max={99} tone="urgent" />
          <Badge dot tone="accent" label="unread" />
        </div>
      ),
    },
    {
      id: "links",
      title: "RouteLink",
      node: (
        <div className="flex flex-wrap gap-4">
          <RouteLink href="/__ui-preview?section=links">Inactive link</RouteLink>
          <RouteLink href="/__ui-preview?section=links" active>Active link (aria-current)</RouteLink>
        </div>
      ),
    },
    {
      id: "forms",
      title: "Input / Textarea / Select",
      node: (
        <div className="flex flex-col gap-2 max-w-sm">
          <Input placeholder="Mesh name" />
          <Input error defaultValue="bad value" aria-label="invalid input" />
          <Textarea placeholder="Description" rows={2} />
          <Select defaultValue="">
            <option value="">choose a harness…</option>
            <option>codex</option>
            <option>claude</option>
          </Select>
          <Select error defaultValue="" aria-label="required select">
            <option value="">required</option>
          </Select>
        </div>
      ),
    },
    {
      id: "feedback",
      title: "Spinner / Skeleton / ProgressBar",
      node: (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3"><Spinner /> <span className="text-sm text-text-secondary">Loading…</span></div>
          <Skeleton variant="line" />
          <Skeleton variant="row" />
          <Skeleton variant="card" />
          <ProgressBar value={progress} />
          <div><Button size="sm" onClick={() => setProgress((p) => (p + 20) % 120)}>Advance progress ({progress}%)</Button></div>
        </div>
      ),
    },
    {
      id: "panelframe",
      title: "PanelFrame",
      node: (
        <PanelFrame title="Active meshes" description="3 running" actions={<Button size="sm" variant="primary">New</Button>} footer="updated just now">
          <p className="text-sm text-text-secondary">Body content sits inside the framed surface; the header is labelled for assistive tech.</p>
        </PanelFrame>
      ),
    },
    {
      id: "segmented",
      title: "SegmentedControl",
      node: (
        <div>
          <SegmentedControl
            ariaLabel="Demo view"
            value={seg}
            onChange={setSeg}
            options={[
              { value: "list", label: "List" },
              { value: "board", label: "Board" },
              { value: "detail", label: "Detail" },
              { value: "timeline", label: "Timeline", disabled: true },
            ]}
          />
          <p className="text-xs text-text-muted mt-2">selected: {seg} · arrow keys roving-focus between enabled options</p>
        </div>
      ),
    },
    {
      id: "listrows",
      title: "StatusListRow",
      node: (
        <div className="flex flex-col gap-1">
          <StatusListRow status="working" title="mesh · alpha" meta="2m ago" trailing={<Badge count={3} tone="accent" />} href="/__ui-preview?section=listrows" />
          <StatusListRow status="ready" title="mesh · beta" meta="idle" onClick={() => {}} />
          <StatusListRow status="blocked" title="mesh · gamma (selected)" href="/__ui-preview?section=listrows" active trailing={<StatusChip status="blocked" variant="dot" />} />
        </div>
      ),
    },
    {
      id: "emptystate",
      title: "EmptyState",
      node: (
        <EmptyState
          icon={<span className="text-2xl">📭</span>}
          title="No meshes yet"
          description="Create your first mesh to get started."
          action={<Button variant="primary">Create mesh</Button>}
        />
      ),
    },
    {
      id: "errorbanner",
      title: "ErrorBanner",
      node: (
        <div className="flex flex-col gap-2">
          <ErrorBanner title="Failed to load board" onRetry={() => {}}>The daemon is not responding.</ErrorBanner>
          <ErrorBanner title="Dismissable error" onRetry={() => {}} onDismiss={() => {}}>With both retry and dismiss controls.</ErrorBanner>
        </div>
      ),
    },
    {
      id: "actionbar",
      title: "ActionBar / Cluster / Spacer",
      node: (
        <ActionBar ariaLabel="Mesh actions" end={<Cluster><Button variant="ghost" size="sm">Stop</Button><Button variant="primary" size="sm">Start</Button></Cluster>}>
          <StatusChip status="working" variant="soft" />
          <span className="text-sm text-text-secondary">alpha</span>
        </ActionBar>
      ),
    },
    {
      id: "approval",
      title: "ApprovalCard",
      node: (
        <div>
          <ApprovalCard
            title="router · write file"
            question={<>Allow writing <b>config.json</b>?</>}
            options={[
              { id: "allow", label: "Allow", kind: "approve" },
              { id: "once", label: "Just once" },
              { id: "deny", label: "Deny", kind: "reject" },
            ]}
            onResolve={(id) => setApproved(id)}
            resolvedLabel={approved ? `Resolved: ${approved}` : undefined}
          />
          {approved ? <Button size="sm" variant="link" onClick={() => setApproved(null)} className="mt-2">reset</Button> : null}
        </div>
      ),
    },
    {
      id: "composer",
      title: "Composer (shell)",
      node: (
        <Composer
          toolbar={<><Button size="sm" variant="ghost" iconOnly aria-label="attach">📎</Button><AssigneeTag name="router" size="sm" /></>}
          actions={<Button size="sm" variant="primary" disabled={!msg.trim()}>Send</Button>}
          hint="Enter to send · Shift+Enter for newline"
        >
          <Textarea aria-label="message" placeholder="Message the mesh…" rows={2} value={msg} onChange={(e) => setMsg(e.target.value)} className="w-full !border-0 !bg-transparent focus-visible:!outline-none" />
        </Composer>
      ),
    },
    {
      id: "attachment",
      title: "AttachmentCard (media slot)",
      node: (
        <div>
          <div className="flex flex-wrap gap-4 items-start">
            <AttachmentCard
              name="diagram.png"
              caption="from router"
              href="/__ui-preview?section=attachment"
              media={<div className="w-40 h-24 bg-surface-sunken flex items-center justify-center text-xs text-text-muted">image preview slot</div>}
            />
            <AttachmentCard name="notes.txt" caption="text attachment" />
          </div>
          <p className="text-xs text-text-muted mt-2">The media slot is where the app plugs in its AuthedImage — this gallery never imports it.</p>
        </div>
      ),
    },
    {
      id: "version",
      title: "VersionLine",
      node: (
        <div className="flex flex-col gap-1">
          <VersionLine primary={{ name: "codex-acp", version: "1.2.3" }} secondary={{ name: "codex", version: "0.141.0" }} />
          <VersionLine primary={{ name: "claude-agent-acp", version: "0.9.0" }} />
          <VersionLine primary={{ name: "opencode" }} secondary={{ name: "sst" }} />
        </div>
      ),
    },
    {
      id: "assignee",
      title: "AssigneeTag",
      node: (
        <div className="flex flex-wrap gap-4 items-center">
          <AssigneeTag name="Ada Lovelace" />
          <AssigneeTag name="router" />
          <AssigneeTag name="prdmgr" size="sm" />
          <AssigneeTag name="team1 builder" iconOnly />
        </div>
      ),
    },
  ];

  const shown = section === "all" ? sections : sections.filter((s) => s.id === section);

  return (
    <div data-gallery="root" className="min-h-screen bg-surface text-text-primary font-sans p-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold mb-1">Agent Mesh — UI gallery (v2 design system · live compose)</h1>
        <p className="text-sm text-text-secondary mb-1">Real C5–C7 components from <code className="text-syntax-string">src/web/client/ui</code> across all 9 mode×accent combinations.</p>
        <p className="text-xs text-text-muted mb-4">Live review: <code className="text-syntax-string">MESH_UI_PREVIEW=1 bun run src/main.ts run --fake --port 15080</code> → <code className="text-syntax-string">/__ui-preview</code> (route 404s without the flag).</p>
        <div className="flex flex-wrap gap-6 items-start">
          <div>
            <div className="text-xs uppercase tracking-wider text-text-muted mb-2">Background mode</div>
            <SegmentedControl ariaLabel="Background mode" value={mode} onChange={(m) => nav({ mode: m })} options={MODES.map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-text-muted mb-2">Accent</div>
            <SegmentedControl ariaLabel="Accent" value={accent} onChange={(a) => nav({ accent: a })} options={ACCENTS.map((a) => ({ value: a, label: ACCENT_LABEL[a] }))} />
          </div>
        </div>
        <div className="mt-4">
          <div className="text-xs uppercase tracking-wider text-text-muted mb-2">Section</div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant={section === "all" ? "primary" : "ghost"} onClick={() => nav({ section: "all" })}>all</Button>
            {sections.map((s) => (
              <Button key={s.id} size="sm" variant={section === s.id ? "primary" : "ghost"} onClick={() => nav({ section: s.id })}>{s.id}</Button>
            ))}
          </div>
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-2" style={{ maxWidth: 1280 }}>
        {shown.map((s) => (
          <div key={s.id} data-section={s.id}>
            <PanelFrame title={s.title}>{s.node}</PanelFrame>
          </div>
        ))}
      </div>
    </div>
  );
}
