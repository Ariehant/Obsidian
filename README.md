# Basalt

A clean-room Markdown knowledge base that works with Obsidian vaults, plugins and themes.
"Basalt" is a working name.

- Plan and roadmap: [docs/PLAN.md](docs/PLAN.md)
- Decisions: [docs/adr/](docs/adr/)

## Status

Phases 0–2 are done: vault management, Live Preview, source and reading views, a metadata
cache with link-updating renames, backlinks/outline/tags panes, link and tag autocomplete,
hover previews, attachments and properties. See [PLAN §9](docs/PLAN.md#9-status).

## Development

Requires Node 22+.

```sh
npm install
npm start            # build and launch the desktop app
npm run dev          # rebuild on change (run `npx electron apps/desktop` in another shell)
npm run check        # lint + format check + typecheck + unit tests
npm run test:e2e     # build, then drive the real app with Playwright
```

On Linux without a display, run the E2E suite under Xvfb: `xvfb-run -a npm run test:e2e`.
When running as root, Electron needs `--no-sandbox` (the E2E suite passes it).

Useful overrides:

| Variable / flag                    | Effect                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `--vault=<path>` or `BASALT_VAULT` | Open this folder as the vault on startup                                  |
| `BASALT_USER_DATA`                 | Use a separate settings folder (the E2E suite isolates each run this way) |

## Layout

```
apps/desktop/      Electron main process, renderer shell (explorer, editor pane), E2E tests
packages/core/     App, Vault, file model, adapters, Events, Component (no DOM)
packages/ui/       Global DOM helpers, icons, Menu/Modal/Notice, CSS tokens and styles
packages/editor/   CodeMirror 6: OFM grammar, theme token classes, Live Preview
packages/markdown/ OFM grammar, HTML renderer, sanitised DOM rendering, embeds, math
fixtures/markdown/ Golden OFM fixtures (<name>.md → <name>.html)
fixtures/vaults/   Test vaults
scripts/build.mjs  esbuild build for the desktop app
```

`packages/core/test/api-conformance.ts` checks our classes against the official plugin API
typings at compile time. Add a line there for each API class you implement.
