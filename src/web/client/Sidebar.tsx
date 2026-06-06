// Left column = the TUI "top context": the mesh list (lifecycle) + master-agent chat.
import type { Store } from "./store";
import type { GatewayState, MeshSummary } from "../types";
import { Dot, Btn, Composer, Empty } from "./ui";
import { Transcript } from "./Transcript";

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
  return (
    <div className="panel">
      <div className="head">
        <span className="ttl">meshes</span>
        <span className="sub">{state.meshes.length}</span>
        <span className="right">
          <Btn small onClick={onNewMesh} title="define a new mesh">
            + new
          </Btn>
          <Btn small kind="ghost" onClick={() => void store.reload()} title="reload definitions from disk (Ctrl-R)">
            ↻
          </Btn>
        </span>
      </div>
      <div className="body-scroll" style={{ padding: 0 }}>
        <div className="mlist">
          {state.meshes.length === 0 ? (
            <Empty>no meshes — define one with + new, or ask the master agent</Empty>
          ) : (
            state.meshes.map((m) => (
              <MeshRow
                key={m.name}
                m={m}
                selected={m.name === selected}
                onSelect={() => onSelect(m.name)}
                store={store}
              />
            ))
          )}
        </div>
      </div>
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
          <div className="chat">
            <Transcript items={state.master.transcript} />
            <Composer
              placeholder={st === "ready" ? "instruct the master agent…" : "master is starting…"}
              disabled={st !== "ready"}
              onSend={(t) => void store.promptMaster(t)}
            />
          </div>
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
