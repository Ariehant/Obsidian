// Builds the desktop app into apps/desktop/dist: main process, renderer bundle + CSS, HTML.
// Usage: node scripts/build.mjs [--watch] [--production]
import * as esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const outdir = 'apps/desktop/dist';

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
  // Resolve ESM builds first so CodeMirror & co. are shared single instances.
  mainFields: ['module', 'main'],
};

const main = {
  ...common,
  entryPoints: { main: 'apps/desktop/src/main/main.ts' },
  outdir,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
};

// The renderer runs with Node integration, so it is built for Node: builtins and electron
// stay as runtime `require` calls. It loads as a classic <script>, so it must be an IIFE;
// otherwise top-level bindings leak into (and can collide with) window globals.
const renderer = {
  ...common,
  entryPoints: { renderer: 'apps/desktop/src/renderer/main.ts' },
  outdir,
  platform: 'node',
  format: 'iife',
  target: ['chrome130'],
  external: ['electron'],
  loader: { '.css': 'css' },
};

await mkdir(outdir, { recursive: true });
await copyFile('apps/desktop/src/renderer/index.html', `${outdir}/index.html`);

if (watch) {
  const contexts = await Promise.all([esbuild.context(main), esbuild.context(renderer)]);
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all([esbuild.build(main), esbuild.build(renderer)]);
}
