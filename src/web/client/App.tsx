// Top-level composition: owns UI state (selected mesh/agent, fullscreen, modal),
// wires the store + keyboard shortcuts, and lays out the TTY-style console shell.
import { useEffect, useRef, useState } from "react";
import { createStore, useStore, useConnected, useToasts, type Store } from "./store";
import { Sidebar } from "./Sidebar";
import { MeshDetail } from "./MeshDetail";
import { MeshBuilder } from "./MeshBuilder";
import { useKeyboard } from "./useKeyboard";
import { useIsMobile } from "./useMedia";
import { ThemeControls } from "./Theme";
import { Dot, Btn } from "./ui";

const SEL_KEY = "mesh.selected";

function Toaster({ store }: { store: Store }) {
  const toasts = useToasts(store);
  if (!toasts.length) return null;
  return (
    <div className="toaster">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => store.dismissToast(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function App() {
  const storeRef = useRef<Store | null>(null);
  if (!storeRef.current) {
    storeRef.current = createStore();
    // expose for debugging + browser e2e
    if (typeof window !== "undefined") (window as any).__meshStore = storeRef.current;
  }
  const store = storeRef.current;

  const state = useStore(store);
  const connected = useConnected(store);
  const mobile = useIsMobile();

  const [selectedMesh, setSelectedMeshRaw] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [newMeshOpen, setNewMeshOpen] = useState(false);
  const [editInitial, setEditInitial] = useState<import("../types").MeshConfig | null>(null);

  async function openEditor(name: string) {
    try {
      const res = await fetch(`/api/meshes/${encodeURIComponent(name)}/config`);
      if (!res.ok) throw new Error("config unavailable");
      setEditInitial(await res.json());
      setNewMeshOpen(true);
    } catch {
      /* ignore — editor just won't open */
    }
  }

  // persist the selected mesh across reloads
  const setSelectedMesh = (n: string | null) => {
    setSelectedMeshRaw(n);
    try {
      if (n) localStorage.setItem(SEL_KEY, n);
      else localStorage.removeItem(SEL_KEY);
    } catch {
      /* storage unavailable */
    }
  };

  // restore the persisted selection (or the first mesh) once meshes arrive.
  // On mobile we start at the overview (no auto-selection into a detail screen).
  const autoSel = useRef(false);
  useEffect(() => {
    if (autoSel.current || selectedMesh || !state.meshes.length || mobile) return;
    autoSel.current = true;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(SEL_KEY);
    } catch {
      /* storage unavailable */
    }
    const pick = stored && state.meshes.some((m) => m.name === stored) ? stored : state.meshes[0].name;
    setSelectedMeshRaw(pick);
  }, [state.meshes, selectedMesh, mobile]);

  // reset agent selection + fullscreen when switching mesh
  useEffect(() => {
    setSelectedAgent(null);
    setFullscreen(false);
  }, [selectedMesh]);

  const names = state.meshes.map((m) => m.name);
  const cycle = (dir: 1 | -1) => {
    if (!names.length) return;
    const i = selectedMesh ? names.indexOf(selectedMesh) : -1;
    const next = ((i + dir + names.length) % names.length + names.length) % names.length;
    setSelectedMesh(names[next]);
  };

  useKeyboard({
    onPrev: () => cycle(-1),
    onNext: () => cycle(1),
    onReload: () => void store.reload(),
    onToggleFull: () => selectedMesh && setFullscreen((f) => !f),
    onNewMesh: () => {
      setEditInitial(null);
      setNewMeshOpen(true);
    },
    onEsc: () => {
      if (newMeshOpen) setNewMeshOpen(false);
      else if (fullscreen) setFullscreen(false);
      else setSelectedMesh(null);
    },
    onDigit: (idx) => {
      if (!selectedMesh) return;
      const pm = state.perMesh[selectedMesh];
      const req = pm?.pending[0];
      const opt = req?.options[idx];
      if (req && opt) void store.resolvePermission(selectedMesh, req.requestId, opt.id);
    },
  });

  const masterDotStatus =
    state.master.status === "ready"
      ? "ready"
      : state.master.status === "starting"
        ? "spawning"
        : state.master.status === "absent"
          ? "dead"
          : "stopped";

  const openNew = () => {
    setEditInitial(null);
    setNewMeshOpen(true);
  };
  const inDetail = !!selectedMesh;
  const detail = (
    <div className="detail">
      <MeshDetail
        state={state}
        store={store}
        meshName={selectedMesh!}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
        fullscreen={fullscreen}
        onToggleFull={() => setFullscreen((f) => !f)}
        onDeleted={() => setSelectedMesh(null)}
        onEdit={() => selectedMesh && void openEditor(selectedMesh)}
        mobile={mobile}
      />
    </div>
  );
  const overview = (
    <Sidebar state={state} store={store} selected={selectedMesh} onSelect={setSelectedMesh} onNewMesh={openNew} />
  );

  return (
    <div className={`app ${mobile ? "mobile" : ""}`}>
      <div className="topbar">
        {mobile && inDetail ? (
          <Btn kind="ghost" title="back to meshes" onClick={() => setSelectedMesh(null)}>
            ‹ back
          </Btn>
        ) : null}
        <span className="brand">
          <span className="glyph">▰▰</span> agent-mesh
        </span>
        <span className="stat" title={`master ${state.master.status}`}>
          <Dot status={masterDotStatus} />
          {!mobile ? <> master {state.master.status}</> : null}
        </span>
        <span className="stat" title={connected ? "connected" : "offline"}>
          <Dot status={connected ? "ready" : "dead"} />
          {!mobile ? <> {connected ? "live" : "offline"}</> : null}
        </span>
        <span className="spacer" />
        {!mobile ? (
          <span className="stat hints" style={{ letterSpacing: 0.4, textTransform: "none" }}>
            <span className="kbd">↑↓</span> select <span className="kbd">f</span> full <span className="kbd">n</span> new{" "}
            <span className="kbd">r</span> reload <span className="kbd">1-9</span> permit <span className="kbd">esc</span> back
          </span>
        ) : null}
        {!mobile ? <ThemeControls /> : null}
        <Btn kind="ghost" onClick={() => void store.reload()} title="reload definitions">
          {mobile ? "↻" : "↻ reload"}
        </Btn>
      </div>

      <div className="body">
        {mobile ? (
          inDetail ? (
            detail
          ) : (
            overview
          )
        ) : (
          <>
            {overview}
            {inDetail ? (
              detail
            ) : (
              <div className="detail">
                <div className="empty" style={{ margin: "auto", maxWidth: 460 }}>
                  select a mesh from the list to open its console — topology, router chat,
                  per-agent panels, permissions, and live mail/activity timelines.
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {newMeshOpen ? (
        <MeshBuilder
          store={store}
          initial={editInitial ?? undefined}
          onClose={(created) => {
            setNewMeshOpen(false);
            setEditInitial(null);
            if (created) setSelectedMesh(created);
          }}
        />
      ) : null}

      <Toaster store={store} />
    </div>
  );
}
