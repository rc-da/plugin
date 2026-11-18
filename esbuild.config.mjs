import esbuild from "esbuild";
import builtins from "builtin-modules";
import process from "process";

const watch = process.argv.includes("--watch");
// `npm run build` (and the release workflow) pass "production": no source map in
// the shipped main.js. Dev/watch builds keep an inline map for debugging.
const production = process.argv.includes("production");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  platform: "browser",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
