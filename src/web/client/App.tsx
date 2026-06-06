// Top-level composition: owns UI state (selected mesh/agent, fullscreen, modal),
// wires the store + keyboard shortcuts, and lays out the TTY-style console shell.
import { useEffect, useRef, useState } from "react";
import { createStore, useStore, useConnected, useToasts, type Store } from "./store";
import { Sidebar } from "./Sidebar";
import { MeshDetail } from "./MeshDetail";
import { MeshBuilder } from "./MeshBuilder";
import { useKeyboard } from "./useKeyboard";
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

  // restore the persisted selection (or the first mesh) once meshes arrive
  const autoSel = useRef(false);
  useEffect(() => {
    if (autoSel.current || selectedMesh || !state.meshes.length) return;
    autoSel.current = true;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(SEL_KEY);
    } catch {
      /* storage unavailable */
    }
    const pick = stored && state.meshes.some((m) => m.name === stored) ? stored : state.meshes[0].name;
    setSelectedMeshRaw(pick);
  }, [state.meshes, selectedMesh]);

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

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">
          <span className="glyph">▰▰</span> agent-mesh
        </span>
        <span className="stat">
          <Dot status={masterDotStatus} /> master {state.master.status}
        </span>
        <span className="stat">
          <Dot status={connected ? "ready" : "dead"} /> {connected ? "live" : "offline"}
        </span>
        <span className="spacer" />
        <span className="stat" style={{ letterSpacing: 0.4, textTransform: "none" }}>
          <span className="kbd">↑↓</span> select <span className="kbd">f</span> full <span className="kbd">n</span> new{" "}
          <span className="kbd">r</span> reload <span className="kbd">1-9</span> permit <span className="kbd">esc</span> back
        </span>
        <Btn onClick={() => { setEditInitial(null); setNewMeshOpen(true); }}>+ new mesh</Btn>
        <Btn kind="ghost" onClick={() => void store.reload()}>
          ↻ reload
        </Btn>
      </div>

      <div className="body">
        <Sidebar
          state={state}
          store={store}
          selected={selectedMesh}
          onSelect={setSelectedMesh}
          onNewMesh={() => { setEditInitial(null); setNewMeshOpen(true); }}
        />
        <div className="detail">
          {selectedMesh ? (
            <MeshDetail
              state={state}
              store={store}
              meshName={selectedMesh}
              selectedAgent={selectedAgent}
              onSelectAgent={setSelectedAgent}
              fullscreen={fullscreen}
              onToggleFull={() => setFullscreen((f) => !f)}
              onDeleted={() => setSelectedMesh(null)}
              onEdit={() => void openEditor(selectedMesh)}
            />
          ) : (
            <div className="empty" style={{ margin: "auto", maxWidth: 460 }}>
              select a mesh from the list to open its console — topology, router chat,
              per-agent panels, permissions, and live mail/activity timelines.
            </div>
          )}
        </div>
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
