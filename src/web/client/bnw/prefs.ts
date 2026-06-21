// Step 7.4-B — net-new (`[N]`) /bnw user preferences. CLIENT-LOCAL persistence only (this
// browser's localStorage) — there is no server preference endpoint, so the settings UI is honest
// about this not being a backend write. `defaultView` is honored by BnwApp's landing redirect;
// `defaultDevice` is persisted but inert until a manual layout override exists (mobile is
// viewport-responsive today — see Step 7.5).
export type DefaultView = "runtime" | "board";
export type DefaultDevice = "desktop" | "mobile";
const VIEW_KEY = "mesh.bnw.defaultView";
const DEVICE_KEY = "mesh.bnw.defaultDevice";

export function loadDefaultView(): DefaultView {
  try { return localStorage.getItem(VIEW_KEY) === "board" ? "board" : "runtime"; } catch { return "runtime"; }
}
export function saveDefaultView(v: DefaultView): void {
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* unavailable */ }
}
export function loadDefaultDevice(): DefaultDevice {
  try { return localStorage.getItem(DEVICE_KEY) === "mobile" ? "mobile" : "desktop"; } catch { return "desktop"; }
}
export function saveDefaultDevice(v: DefaultDevice): void {
  try { localStorage.setItem(DEVICE_KEY, v); } catch { /* unavailable */ }
}
