#!/usr/bin/env bun
// Compile the mesh binary with the Tailwind v4 plugin.
//
// `bun build --compile` (CLI) does NOT read bunfig.toml `[serve.static].plugins`,
// so the web client's `@import "tailwindcss"` (a transitive import of the bundled
// HTML entry) would ship UNPROCESSED in the compiled binary (`@theme`/`@tailwind`
// left raw). The programmatic Bun.build API does honour plugins, so we run the
// compile here with bun-plugin-tailwind to match the dev/runtime Bun.serve path
// (which uses the bunfig plugin). Honours --outfile <path> or $OUT (used by
// scripts/update.sh); defaults to dist/mesh.
import tailwind from "bun-plugin-tailwind";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--outfile");
const outfile = process.env.OUT || (outIdx >= 0 ? args[outIdx + 1] : "dist/mesh");

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  compile: { outfile },
  plugins: [tailwind],
  throw: false,
});

for (const log of result.logs) console.error(String(log));
if (!result.success) {
  console.error(`build failed: ${outfile}`);
  process.exit(1);
}
console.log(`built ${outfile}`);
