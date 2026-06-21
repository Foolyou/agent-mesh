// Step 7.4-A.2b-ii — File / artifact viewer (mockup 11). Deep-linkable at
// /bnw/mesh/<id>/agent/<id>/file|artifact/<path>?lb=1. Independent /bnw view; shares only the
// data layer (authHeaders Bearer fetch + the shared Markdown renderer + AuthorContext for
// artifact-relative refs). NEVER imports the old FileViewer view component (its parser/helpers
// are reimplemented locally).
//
// Deviations from mockup 11 (flagged):
//  - Code renders as a plain mono <pre> (mockup 11 shows a mono code block; the v2 design does not
//    define the legacy `tok-*` syntax-color classes, so the old syntax highlighter is dropped here).
//  - The composer pending-image tray in mockup 11 is a runtime-focus/composer concern, not part of
//    the standalone deep-linked artifact route — it is not rendered on this surface.
import { useEffect, useMemo, useState } from "react";
import { ErrorBanner, RouteLink, Spinner, StatusChip } from "../ui/index";
import { authHeaders } from "../device-auth";
import { Markdown } from "../Markdown";
import { AuthorContext } from "../AuthorContext";
import { bnwHref, navigate, type BnwRoute } from "../router";

type FileRoute = Extract<BnwRoute, { k: "file" }>;
type LoadState =
  | { kind: "loading" }
  | { kind: "error"; status: number; message: string }
  | { kind: "markdown"; text: string }
  | { kind: "image"; url: string }
  | { kind: "text"; text: string; language: string };

function extensionOf(path: string): string {
  const clean = path.split(/[?#]/, 1)[0].toLowerCase();
  const i = clean.lastIndexOf(".");
  return i >= 0 ? clean.slice(i) : "";
}
function languageOf(ext: string): string {
  return ({
    ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx", ".py": "py", ".go": "go", ".rs": "rs",
    ".java": "java", ".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp", ".html": "html", ".css": "css",
    ".sh": "sh", ".sql": "sql", ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
  } as Record<string, string>)[ext] ?? "text";
}
function statusText(status: number): string {
  if (status === 400) return "Blocked by path safety policy";
  if (status === 401 || status === 403) return "Not permitted for this device";
  if (status === 404) return "File not found";
  if (status === 413) return "File is larger than 5 MB";
  return "Request failed";
}
function safeDecode(path: string): string {
  try { return decodeURIComponent(path); } catch { return path; }
}

export function BnwFileViewer({ route }: { route: FileRoute }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const ext = useMemo(() => extensionOf(route.path), [route.path]);
  const decodedPath = safeDecode(route.path);
  const backHref = bnwHref({ k: "runtime", mesh: route.mesh, agent: route.agent });
  const selfHref = bnwHref({ k: "file", mesh: route.mesh, agent: route.agent, kind: route.kind, path: route.path });
  const lbHref = bnwHref({ k: "file", mesh: route.mesh, agent: route.agent, kind: route.kind, path: route.path, lb: true });

  useEffect(() => {
    let alive = true;
    let objectUrl: string | undefined;
    setState({ kind: "loading" });
    const url = route.kind === "artifact"
      ? `/api/meshes/${encodeURIComponent(route.mesh)}/agents/${encodeURIComponent(route.agent)}/artifacts/${route.path}`
      : `/api/agents/${encodeURIComponent(route.agent)}/files/${route.path}`;
    void (async () => {
      try {
        const resp = await fetch(url, { headers: authHeaders() });
        if (!resp.ok) { if (alive) setState({ kind: "error", status: resp.status, message: statusText(resp.status) }); return; }
        const ct = resp.headers.get("content-type") ?? "";
        if (ct.startsWith("image/")) { const blob = await resp.blob(); objectUrl = URL.createObjectURL(blob); if (alive) setState({ kind: "image", url: objectUrl }); return; }
        const text = await resp.text(); if (!alive) return;
        if (ext === ".md" || ext === ".markdown") setState({ kind: "markdown", text });
        else setState({ kind: "text", text, language: languageOf(ext) });
      } catch (e: any) {
        if (alive) setState({ kind: "error", status: 0, message: String(e?.message ?? e) });
      }
    })();
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [route.mesh, route.agent, route.kind, route.path, ext, reloadKey]);

  // Esc closes the lightbox (SPA nav back to the non-lb route).
  useEffect(() => {
    if (!route.lb) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") navigate({ k: "file", mesh: route.mesh, agent: route.agent, kind: route.kind, path: route.path }); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route.lb, route.mesh, route.agent, route.kind, route.path]);

  return (
    <div data-artifact="viewer" className="relative flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border bg-surface-raised px-1 pb-3">
        <RouteLink href={backHref} unstyled data-artifact-back aria-label="back to conversation" className="inline-flex items-center gap-1 rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-xs text-text-primary no-underline hover:bg-hover">← 返回对话</RouteLink>
        <span className="text-text-muted">·</span>
        <span data-artifact-path className="min-w-0 flex-1 truncate font-mono text-xs text-text-muted">{route.mesh} / {route.agent} / {decodedPath}</span>
        <StatusChip status="idle" variant="soft" label={route.kind} />
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mx-auto flex max-w-[820px] flex-col gap-3">
          {state.kind === "loading" ? (
            <div className="flex items-center gap-2 text-sm text-text-secondary"><Spinner size={14} label="loading" /> Bearer 拉取中…</div>
          ) : state.kind === "error" ? (
            <ErrorBanner title={state.status === 404 ? "File not found" : state.status === 401 || state.status === 403 ? "Not permitted" : "Unable to open file"}
              onRetry={state.status === 401 || state.status === 403 ? undefined : () => setReloadKey((k) => k + 1)}>
              {(state.status ? `${state.status} · ${state.message}` : state.message)}。用上方「返回对话」回到会话。
            </ErrorBanner>
          ) : state.kind === "markdown" ? (
            <div data-artifact-kind="markdown">
              <AuthorContext.Provider value={{ meshId: route.mesh, agent: route.agent }}><Markdown text={state.text} /></AuthorContext.Provider>
            </div>
          ) : state.kind === "image" ? (
            <RouteLink href={lbHref} unstyled data-artifact-image aria-label={`zoom ${decodedPath}`} className="block overflow-hidden rounded-lg border border-border no-underline">
              <img src={state.url} alt={decodedPath} className="mx-auto max-h-[60vh] w-auto" />
            </RouteLink>
          ) : (
            <pre data-artifact-kind="code" data-language={state.language} className="overflow-x-auto rounded-lg bg-surface-sunken px-3 py-2 font-mono text-xs text-text-secondary">{state.text}</pre>
          )}
        </div>
      </div>
      {state.kind === "image" && route.lb ? (
        <div data-artifact-lightbox role="dialog" aria-modal="true" aria-label="image lightbox" className="absolute inset-0 z-20 flex flex-col" style={{ background: "rgba(0,0,0,0.85)" }}>
          <div className="flex items-center gap-2 px-4 py-2.5 text-xs">
            <span className="min-w-0 flex-1 truncate font-mono text-text-on-selected">{decodedPath}</span>
            <RouteLink href={selfHref} unstyled aria-label="close lightbox" className="rounded-lg border border-border-strong bg-surface px-2 py-1 text-text-primary no-underline">✕ Esc</RouteLink>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center p-4">
            <img src={state.url} alt={decodedPath} className="max-h-full max-w-full" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
