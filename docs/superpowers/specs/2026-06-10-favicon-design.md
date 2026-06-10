# Agent Mesh Favicon Design

## Goal

Add a favicon for the Agent Mesh web console that matches the existing
"mission-control TTY" visual language and remains legible at browser tab size.

## Selected Direction

Use a compact SVG mark with:

- A near-black rounded square background using the console background color.
- Thin light mesh connection lines to suggest routed multi-agent coordination.
- Two small green blocks that echo the current topbar `▰▰` brand glyph.
- Two lower node points in light/cyan tones to preserve the mesh graph read.

This keeps the icon tied to the current `agent-mesh` brand instead of using a
generic network symbol.

## Integration

Add `src/web/client/favicon.svg` as a hand-authored SVG with a 32x32 viewBox.
Reference it from `src/web/client/index.html` with:

- `rel="icon"` and `type="image/svg+xml"`.
- A dark `theme-color` meta tag matching the console background.

The change should be asset-only plus HTML metadata. It should not alter React UI
layout, application state, API behavior, or server routing.

## Compatibility

SVG favicon is the first implementation target because it is small, readable in
source control, and fits the geometric mark. PNG or ICO fallbacks are out of
scope unless a later browser-support requirement appears.

## Verification

Verify that:

- The HTML references the new favicon path.
- The SVG is valid XML/SVG and renders as the selected direction.
- Existing tests still pass for the touched web client surface.

