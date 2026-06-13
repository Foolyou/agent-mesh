import { useEffect, useMemo, useState } from "react";
import { AuthorContext } from "./AuthorContext";
import { Markdown } from "./Markdown";
import { useI18n } from "./i18n";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; status: number; message: string }
  | { kind: "markdown"; text: string }
  | { kind: "image"; url: string; contentType: string }
  | { kind: "text"; text: string; language: string };

export interface FileRoute {
  meshId: string;
  agentName: string;
  kind: "file" | "artifact";
  path: string;
}

export function parseFileRoute(pathname: string): FileRoute | undefined {
  const m = pathname.match(/^\/mesh\/([^/]+)\/agent\/([^/]+)\/(file|artifact)\/(.+)$/);
  if (!m) return undefined;
  return {
    meshId: decodeURIComponent(m[1]),
    agentName: decodeURIComponent(m[2]),
    kind: m[3] as "file" | "artifact",
    path: m[4],
  };
}

export function FileViewer({ route }: { route: FileRoute }) {
  const { t } = useI18n();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [lightbox, setLightbox] = useState(false);
  const ext = useMemo(() => extensionOf(route.path), [route.path]);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | undefined;
    setState({ kind: "loading" });
    const url =
      route.kind === "artifact"
        ? `/api/meshes/${encodeURIComponent(route.meshId)}/agents/${encodeURIComponent(route.agentName)}/artifacts/${route.path}`
        : `/api/agents/${encodeURIComponent(route.agentName)}/files/${route.path}`;
    void (async () => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) {
          if (alive) setState({ kind: "error", status: resp.status, message: statusText(resp.status) });
          return;
        }
        const contentType = resp.headers.get("content-type") ?? "";
        if (contentType.startsWith("image/")) {
          const blob = await resp.blob();
          objectUrl = URL.createObjectURL(blob);
          if (alive) setState({ kind: "image", url: objectUrl, contentType });
          return;
        }
        const text = await resp.text();
        if (!alive) return;
        if (ext === ".md" || ext === ".markdown") setState({ kind: "markdown", text });
        else setState({ kind: "text", text, language: languageOf(ext) });
      } catch (err: any) {
        if (alive) setState({ kind: "error", status: 0, message: String(err?.message ?? err) });
      }
    })();
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [route.meshId, route.agentName, route.kind, route.path, ext]);

  const decodedPath = safeDecode(route.path);
  return (
    <div className="file-viewer-shell">
      <header className="file-viewer-head">
        <button className="file-viewer-back" type="button" onClick={goBack} aria-label={t("back")} title={t("back")}>
          ‹
        </button>
        <div className="file-viewer-title">
          <div className="sub">{route.meshId} / {route.agentName}</div>
          <div className="file-viewer-path">{decodedPath}</div>
        </div>
      </header>
      <main className="file-viewer-body">
        {state.kind === "loading" ? (
          <div className="empty">Loading…</div>
        ) : state.kind === "error" ? (
          <div className="file-viewer-error">
            <div className="ttl">{state.status === 404 ? "File not found" : "Unable to open file"}</div>
            <div className="sub">{state.status ? `${state.status} · ${state.message}` : state.message}</div>
          </div>
        ) : state.kind === "markdown" ? (
          <AuthorContext.Provider value={{ meshId: route.meshId, agent: route.agentName }}>
            <Markdown text={state.text} />
          </AuthorContext.Provider>
        ) : state.kind === "image" ? (
          <>
            <button className="file-viewer-image" type="button" onClick={() => setLightbox(true)} title={decodedPath}>
              <img src={state.url} alt={decodedPath} />
            </button>
            {lightbox ? (
              <div className="lightbox" onClick={() => setLightbox(false)}>
                <button className="lightbox-close" type="button" title="close" onClick={() => setLightbox(false)}>
                  ×
                </button>
                <img src={state.url} alt={decodedPath} />
              </div>
            ) : null}
          </>
        ) : (
          <pre className={`file-code lang-${state.language}`} data-language={state.language}>
            <code dangerouslySetInnerHTML={{ __html: highlightCode(state.text, state.language) }} />
          </pre>
        )}
      </main>
    </div>
  );
}

function goBack(): void {
  if (history.length > 1) history.back();
  else history.replaceState(null, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function extensionOf(path: string): string {
  const clean = path.split(/[?#]/, 1)[0].toLowerCase();
  const i = clean.lastIndexOf(".");
  return i >= 0 ? clean.slice(i) : "";
}

function languageOf(ext: string): string {
  return ({
    ".ts": "ts",
    ".tsx": "tsx",
    ".js": "js",
    ".jsx": "jsx",
    ".py": "py",
    ".go": "go",
    ".rs": "rs",
    ".java": "java",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".html": "html",
    ".css": "css",
    ".sh": "sh",
    ".sql": "sql",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
  } as Record<string, string>)[ext] ?? "text";
}

function statusText(status: number): string {
  if (status === 400) return "Blocked by path safety policy";
  if (status === 404) return "File not found";
  if (status === 413) return "File is larger than 5 MB";
  return "Request failed";
}

function safeDecode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function highlightCode(text: string, language: string): string {
  let html = escapeHtml(text);
  html = html.replace(/("([^"\\]|\\.)*"|'([^'\\]|\\.)*')/g, '<span class="tok-string">$1</span>');
  html = html.replace(/(^|\n)(\s*)(\/\/.*|#.*)/g, '$1$2<span class="tok-comment">$3</span>');
  if (language !== "text") {
    html = html.replace(/\b(import|export|from|const|let|var|function|return|async|await|if|else|for|while|class|interface|type|struct|package|func|fn|pub|use|def|public|private|new|try|catch|throw)\b/g, '<span class="tok-keyword">$1</span>');
  }
  return html;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
