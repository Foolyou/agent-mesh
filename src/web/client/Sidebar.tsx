// Left column = the TUI "top context": the mesh list (lifecycle) + master-agent chat.
import { useEffect, useState } from "react";
import type { Store } from "./store";
import type { GatewayState, MeshSummary } from "../types";
import { Dot, Btn, Empty } from "./ui";
import { ChatPane } from "./ChatPane";

const PER_PAGE = 4;

function MeshRow({
  m,
  selected,
  onSelect,
  store,
}: {
  m: MeshSummary;
  selected: boolean;
  onSelect: () => void;
  store: Store;
}) {
  const live = m.status === "running" || m.status === "starting";
  return (
    <div className={`mrow ${selected ? "sel" : ""}`} onClick={onSelect}>
      <span className="caret">{selected ? "▸" : ""}</span>
      <Dot status={m.status} />
      <span className="mname">{m.name}</span>
      <span className="mstatus">{m.status}</span>
      {live ? (
        <Btn
          small
          kind="stop"
          onClick={() => {
            void store.stopMesh(m.name);
          }}
        >
          stop
        </Btn>
      ) : (
        <Btn
          small
          kind="go"
          onClick={() => {
            void store.startMesh(m.name);
          }}
        >
          start
        </Btn>
      )}
    </div>
  );
}

function MeshList({
  state,
  store,
  selected,
  onSelect,
  onNewMesh,
}: {
  state: GatewayState;
  store: Store;
  selected: string | null;
  onSelect: (n: string) => void;
  onNewMesh: () => void;
}) {
  const all = state.meshes;
  const pages = Math.max(1, Math.ceil(all.length / PER_PAGE));
  const [page, setPage] = useState(0);
  // follow the selected mesh onto its page (e.g. keyboard ↑/↓ cycling)
  useEffect(() => {
    if (!selected) return;
    const i = all.findIndex((m) => m.name === selected);
    if (i >= 0) setPage(Math.floor(i / PER_PAGE));
  }, [selected, all]);
  // clamp if the list shrank
  useEffect(() => {
    if (page > pages - 1) setPage(pages - 1);
  }, [pages, page]);
  const shown = all.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);

  return (
    <div className="panel">
      <div className="head">
        <span className="ttl">meshes</span>
        <span className="sub">{all.length}</span>
        <span className="right">
          <Btn small onClick={onNewMesh} title="define a new mesh">
            + new
          </Btn>
          <Btn small kind="ghost" onClick={() => void store.reload()} title="reload definitions from disk">
            ↻
          </Btn>
        </span>
      </div>
      <div className="mlist">
        {all.length === 0 ? (
          <Empty>no meshes — define one with + new, or ask the master agent</Empty>
        ) : (
          shown.map((m) => (
            <MeshRow key={m.name} m={m} selected={m.name === selected} onSelect={() => onSelect(m.name)} store={store} />
          ))
        )}
      </div>
      {pages > 1 ? (
        <div className="mpage">
          <Btn small kind="ghost" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            ‹
          </Btn>
          <span className="sub">
            {page + 1} / {pages}
          </span>
          <Btn small kind="ghost" disabled={page >= pages - 1} onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}>
            ›
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

function MasterChat({ state, store }: { state: GatewayState; store: Store }) {
  const st = state.master.status;
  const absent = st === "absent";
  return (
    <div className="panel">
      <div className="head">
        <span className="ttl">master</span>
        <span className="row" style={{ gap: 6 }}>
          <Dot status={st === "ready" ? "ready" : st === "starting" ? "spawning" : st === "absent" ? "dead" : "stopped"} />
          <span className="sub">{st}</span>
        </span>
        <span className="right sub">create / start / stop via natural language</span>
      </div>
      <div className="scroll-pane">
        {absent ? (
          <Empty>master agent not configured — use the mesh list to control meshes directly</Empty>
        ) : (
          <ChatPane
            items={state.master.transcript}
            placeholder={st === "ready" ? "instruct the master agent…" : "master is starting…"}
            disabled={st !== "ready"}
            onSend={(t) => void store.promptMaster(t)}
          />
        )}
      </div>
    </div>
  );
}

export function Sidebar({
  state,
  store,
  selected,
  onSelect,
  onNewMesh,
}: {
  state: GatewayState;
  store: Store;
  selected: string | null;
  onSelect: (n: string) => void;
  onNewMesh: () => void;
}) {
  return (
    <div className="sidebar">
      <MeshList state={state} store={store} selected={selected} onSelect={onSelect} onNewMesh={onNewMesh} />
      <MasterChat state={state} store={store} />
    </div>
  );
}
