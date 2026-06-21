// Step 7.0 — minimal hand-written router for the new `/bnw/` console (parallel namespace).
// Old root UI is untouched; this router ONLY governs paths under `/bnw/`. It strips the
// `/bnw` prefix, parses pathname+search into a typed BnwRoute, serializes a BnwRoute back
// to a `/bnw/...` href, and exposes useRoute()/navigate() over the History API + popstate.
//
// parse/serialize are PURE (no DOM) so they unit-test without a browser — same discipline
// as ui/RouteLink.tsx spaTarget(). The board/file route SHAPES mirror the shipped
// parseBoardRoute/parseFileRoute contracts (forked here, the old view components are not
// touched — see docs/design/ui/step7-routing-plan.md §0.4).
import { useEffect, useState } from "react";

export const BNW_PREFIX = "/bnw";

export type BoardView = "list" | "kanban";
export type FileKind = "file" | "artifact";
// C4 board filters carried in the query (status/label/assignee/epic/q/sort/group).
export interface BoardFilters { status?: string; label?: string; assignee?: string; epic?: string; q?: string; sort?: string; group?: string }

export type BnwRoute =
  | { k: "home" }
  | { k: "runtime"; mesh: string; agent?: string; canvas?: boolean; full?: boolean }
  | { k: "board"; mesh: string; issue?: number; view: BoardView; filters: BoardFilters }
  | { k: "newMesh"; editOf?: string }
  | { k: "assistant"; full?: boolean }
  | { k: "harnesses" }
  | { k: "channels" }
  | { k: "doctor" }
  | { k: "settings"; tab?: string }
  | { k: "notifications" }
  | { k: "file"; mesh: string; agent: string; kind: FileKind; path: string; lb?: boolean }
  | { k: "notFound"; path: string };

/** True when this pathname belongs to the new console (so index.tsx mounts the /bnw tree). */
export function isBnwPath(pathname: string): boolean {
  return pathname === BNW_PREFIX || pathname.startsWith(BNW_PREFIX + "/");
}

const dec = (s: string) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

/**
 * Parse a full `/bnw/...` pathname (+ optional search) into a typed route. Any non-`/bnw`
 * path, or an unknown `/bnw` shape, yields `notFound` (the shell renders an in-app 404).
 */
export function parseBnwRoute(pathname: string, search = ""): BnwRoute {
  if (!isBnwPath(pathname)) return { k: "notFound", path: pathname };
  const rest = pathname.slice(BNW_PREFIX.length); // "" | "/..."
  const q = new URLSearchParams(search);
  const segs = rest.split("/").filter(Boolean).map(dec);
  if (segs.length === 0) return { k: "home" };

  // global (non-mesh) surfaces
  if (segs.length === 1) {
    switch (segs[0]) {
      case "assistant": return { k: "assistant", full: q.get("full") === "1" };
      case "harnesses": return { k: "harnesses" };
      case "channels": return { k: "channels" };
      case "doctor": return { k: "doctor" };
      case "notifications": return { k: "notifications" };
      case "settings": return { k: "settings", tab: q.get("tab") ?? undefined };
    }
  }

  // mesh-scoped surfaces: /bnw/mesh/...
  if (segs[0] === "mesh") {
    // /bnw/mesh/new
    if (segs.length === 2 && segs[1] === "new") return { k: "newMesh" };
    const mesh = segs[1];
    if (mesh && mesh !== "new") {
      if (segs.length === 2) return { k: "runtime", mesh }; // overview
      // /bnw/mesh/<id>/edit
      if (segs.length === 3 && segs[2] === "edit") return { k: "newMesh", editOf: mesh };
      // /bnw/mesh/<id>/canvas
      if (segs.length === 3 && segs[2] === "canvas") return { k: "runtime", mesh, canvas: true };
      // /bnw/mesh/<id>/board[/issue/<n>]  (+ C4 filters in the query)
      if (segs[2] === "board") {
        const view: BoardView = q.get("view") === "kanban" ? "kanban" : "list";
        const pick = (k: string) => q.get(k) || undefined;
        const filters: BoardFilters = { status: pick("status"), label: pick("label"), assignee: pick("assignee"), epic: pick("epic"), q: pick("q"), sort: pick("sort"), group: pick("group") };
        if (segs.length === 3) return { k: "board", mesh, view, filters };
        if (segs.length === 5 && segs[3] === "issue") {
          const n = Number(segs[4]);
          if (Number.isInteger(n) && n > 0) return { k: "board", mesh, view, issue: n, filters };
        }
      }
      // /bnw/mesh/<id>/agent/<agentId>[/file|artifact/<path...>]
      if (segs[2] === "agent" && segs[3]) {
        const agent = segs[3];
        if (segs.length === 4) return { k: "runtime", mesh, agent, full: q.get("full") === "1" };
        if (segs.length >= 6 && (segs[4] === "file" || segs[4] === "artifact")) {
          const path = segs.slice(5).join("/");
          return { k: "file", mesh, agent, kind: segs[4] as FileKind, path, lb: q.get("lb") === "1" };
        }
      }
    }
  }

  return { k: "notFound", path: pathname };
}

const enc = (s: string) => encodeURIComponent(s);
const seg = (p: string) => p.split("/").filter(Boolean).map(enc).join("/");

/** Serialize a route back to a `/bnw/...` href (pathname + search). Inverse of parse. */
export function bnwHref(r: BnwRoute): string {
  switch (r.k) {
    case "home": return BNW_PREFIX + "/";
    case "runtime": {
      let p = `${BNW_PREFIX}/mesh/${enc(r.mesh)}`;
      if (r.canvas) return p + "/canvas";
      if (r.agent) { p += `/agent/${enc(r.agent)}`; return r.full ? p + "?full=1" : p; }
      return p;
    }
    case "board": {
      let p = `${BNW_PREFIX}/mesh/${enc(r.mesh)}/board`;
      if (r.issue) p += `/issue/${r.issue}`;
      const q = new URLSearchParams();
      if (r.view === "kanban") q.set("view", "kanban");
      const f = r.filters ?? {};
      for (const k of ["status", "label", "assignee", "epic", "q", "sort", "group"] as const) { if (f[k]) q.set(k, f[k] as string); }
      const qs = q.toString();
      return qs ? `${p}?${qs}` : p;
    }
    case "newMesh": return r.editOf ? `${BNW_PREFIX}/mesh/${enc(r.editOf)}/edit` : `${BNW_PREFIX}/mesh/new`;
    case "assistant": return r.full ? `${BNW_PREFIX}/assistant?full=1` : `${BNW_PREFIX}/assistant`;
    case "harnesses": return `${BNW_PREFIX}/harnesses`;
    case "channels": return `${BNW_PREFIX}/channels`;
    case "doctor": return `${BNW_PREFIX}/doctor`;
    case "settings": return r.tab ? `${BNW_PREFIX}/settings?tab=${enc(r.tab)}` : `${BNW_PREFIX}/settings`;
    case "notifications": return `${BNW_PREFIX}/notifications`;
    case "file": {
      const p = `${BNW_PREFIX}/mesh/${enc(r.mesh)}/agent/${enc(r.agent)}/${r.kind}/${seg(r.path)}`;
      return r.lb ? p + "?lb=1" : p;
    }
    case "notFound": return r.path;
  }
}

function currentRoute(): BnwRoute {
  return parseBnwRoute(window.location.pathname, window.location.search);
}

/** Subscribe to the current `/bnw/` route; re-parses on popstate (RouteLink dispatches one). */
export function useRoute(): BnwRoute {
  const [route, setRoute] = useState<BnwRoute>(currentRoute);
  useEffect(() => {
    const onPop = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return route;
}

/** Imperative navigation (RouteLink covers the common <a> case; this is for programmatic nav). */
export function navigate(to: BnwRoute | string, opts: { replace?: boolean } = {}): void {
  const href = typeof to === "string" ? to : bnwHref(to);
  const here = window.location.pathname + window.location.search + window.location.hash;
  if (href === here) return;
  if (opts.replace) window.history.replaceState({}, "", href);
  else window.history.pushState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
