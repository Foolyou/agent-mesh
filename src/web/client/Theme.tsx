// Theme controls: a top-bar preset picker + a custom-theme editor modal (live
// preview via applyPalette, persisted in localStorage).
import { useEffect, useState } from "react";
import { Btn } from "./ui";
import {
  BUILTIN_THEMES,
  THEME_KEYS,
  applyPalette,
  loadActive,
  loadCustomPalette,
  saveActive,
  saveCustomPalette,
  themeByName,
  isPalette,
  type Palette,
} from "./themes";

const KEY_LABEL: Record<string, string> = {
  bg: "background",
  "bg-raise": "panel",
  "bg-inset": "inset",
  line: "border",
  "line-bright": "border bright",
  fg: "text",
  "fg-dim": "text dim",
  "fg-faint": "text faint",
  ok: "status ok",
  warn: "status warn",
  bad: "status bad",
  off: "status off",
  info: "accent",
  "sel-bg": "select bg",
  "sel-fg": "select fg",
};

export function ThemeControls() {
  const [active, setActive] = useState(() => loadActive().name);
  const [editing, setEditing] = useState(false);

  function pick(name: string) {
    applyPalette(name === "custom" ? loadCustomPalette() : themeByName(name).palette);
    saveActive(name);
    setActive(name);
  }

  return (
    <span className="theme-controls">
      <select className="theme-sel" value={active} onChange={(e) => pick(e.target.value)} title="theme">
        {BUILTIN_THEMES.map((t) => (
          <option key={t.name} value={t.name}>
            {t.label}
          </option>
        ))}
        <option value="custom">Custom</option>
      </select>
      <Btn small kind="ghost" title="customize theme" onClick={() => setEditing(true)}>
        ✎
      </Btn>
      {editing ? (
        <ThemeEditor
          onClose={(savedAsCustom) => {
            setEditing(false);
            if (savedAsCustom) setActive("custom");
          }}
        />
      ) : null}
    </span>
  );
}

function ThemeEditor({ onClose }: { onClose: (savedAsCustom: boolean) => void }) {
  const before = loadActive().palette; // restore on cancel
  const [pal, setPal] = useState<Palette>({ ...before });
  const [json, setJson] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    applyPalette(pal); // live preview
  }, [pal]);

  const set = (k: string, v: string) => setPal((p) => ({ ...p, [k]: v }));

  function applyJson() {
    try {
      const p = JSON.parse(json);
      if (!isPalette(p)) throw new Error("missing keys — need all 15 theme vars as hex strings");
      setPal(p);
      setErr(null);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  return (
    <div className="scrim" onClick={() => { applyPalette(before); onClose(false); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="mhead">
          <span style={{ flex: 1 }}>customize theme</span>
          <Btn small kind="ghost" onClick={() => { applyPalette(before); onClose(false); }}>
            ✕ esc
          </Btn>
        </div>
        <div className="mbody">
          <div className="row" style={{ gap: 8 }}>
            <span className="sub">start from</span>
            {BUILTIN_THEMES.map((t) => (
              <Btn key={t.name} small kind="ghost" onClick={() => setPal({ ...t.palette })}>
                {t.label}
              </Btn>
            ))}
          </div>

          <div className="theme-grid">
            {THEME_KEYS.map((k) => (
              <label className="theme-row" key={k}>
                <input type="color" value={pal[k]} onChange={(e) => set(k, e.target.value)} />
                <input
                  className="inp hex"
                  value={pal[k]}
                  onChange={(e) => set(k, e.target.value)}
                  spellCheck={false}
                />
                <span className="tk">{KEY_LABEL[k] ?? k}</span>
              </label>
            ))}
          </div>

          <div className="field">
            <label>export / import (JSON)</label>
            <textarea
              className="inp"
              rows={4}
              value={json}
              spellCheck={false}
              placeholder="paste a theme JSON and Apply, or click ‘from current’ to export"
              onChange={(e) => setJson(e.target.value)}
              style={{ resize: "vertical", fontFamily: "var(--mono)" }}
            />
            <div className="row" style={{ gap: 6 }}>
              <Btn small kind="ghost" onClick={() => { setJson(JSON.stringify(pal, null, 2)); setErr(null); }}>
                ↧ from current
              </Btn>
              <Btn small onClick={applyJson}>
                ↥ apply JSON
              </Btn>
            </div>
          </div>

          {err ? <div className="err">{err}</div> : null}

          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Btn kind="ghost" onClick={() => { applyPalette(before); onClose(false); }}>
              cancel
            </Btn>
            <Btn kind="go" onClick={() => { saveCustomPalette(pal); saveActive("custom"); onClose(true); }}>
              save as custom
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
