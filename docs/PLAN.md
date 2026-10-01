# Plan: an Obsidian-compatible Markdown knowledge base

Goal: a desktop app (mobile later) that works and feels like Obsidian: same vault format, same
Markdown flavour, same workspace model, and ideally the ability to run existing community
plugins and themes unmodified.

---

## 0. Ground rules (read first)

"Exact as it is" has to mean **same behaviour and compatibility**, not copied code or assets.

- **Obsidian is closed source.** We don't decompile, extract or copy `app.js`, `app.css`,
  icons or other bundled assets. Everything gets reimplemented from public behaviour and
  documentation.
- **We can't use the name or logo.** "Obsidian" and its logo are trademarks. The product needs
  its own name (placeholder below: **Basalt**). The repo name doesn't matter.
- **What we're free to use:**
  - The plugin API type definitions ([`obsidianmd/obsidian-api`](https://github.com/obsidianmd/obsidian-api), MIT). This is the contract that community plugins compile against.
  - The same open-source building blocks Obsidian is known to use: Electron, CodeMirror 6,
    Lucide icons (ISC), MathJax, Mermaid, PDF.js, Prism.
  - The public docs at help.obsidian.md and the JSON Canvas spec (MIT, open format).
  - The vault format: plain `.md` files plus a `.obsidian/` config folder of JSON files.
- Community plugins and themes each have their own licence. We load them at runtime and
  never bundle them.

---

## 1. Target stack

| Concern        | Choice                                                                                                                                                        | Why                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Shell          | **Electron**                                                                                                                                                  | Plugins call `require('fs')`, `electron` and Node APIs directly. Tauri would break most of them. |
| Language       | TypeScript (strict)                                                                                                                                           | Matches the plugin API typings.                                                                  |
| Editor         | **CodeMirror 6**                                                                                                                                              | Obsidian's editor is CM6. Plugins reach `editor.cm` / `EditorView` and register CM6 extensions.  |
| Markdown       | `markdown-it` or micromark + custom extensions for reading view; Lezer Markdown grammar + extensions for the editor                                           | We need one parser we control for wikilinks, embeds, callouts, block refs, etc.                  |
| UI             | **Vanilla DOM + Obsidian-style DOM helpers** (`createEl`, `createDiv`, `setIcon`)                                                                             | The plugin API is imperative DOM. Adding React/Vue would fight plugins and themes.               |
| Styling        | Plain CSS on CSS custom properties, using the **same variable names** Obsidian documents (`--background-primary`, `--text-normal`, `--interactive-accent`, …) | Existing themes and snippets need this to work.                                                  |
| Build          | esbuild (app + workers), electron-builder (packaging)                                                                                                         | Fast. Plugins are built with esbuild too.                                                        |
| Tests          | Vitest (unit), Playwright for Electron (E2E + screenshot diff)                                                                                                |                                                                                                  |
| Mobile (later) | Capacitor over the same web bundle, with a `CapacitorAdapter` for the file system                                                                             | Same approach Obsidian mobile takes.                                                             |

Monorepo layout:

```
apps/desktop/          Electron main + preload, packaging
packages/core/         App, Vault, MetadataCache, Workspace, Events, Plugin host (no DOM in model layer)
packages/editor/       CM6 setup, live preview, source mode, editor extensions
packages/markdown/     Parser + renderer (reading view, embeds, callouts, math, mermaid)
packages/ui/           Modals, menus, notices, settings tab, suggesters, icons
packages/plugins-core/ Built-in "core plugins" (graph, canvas, daily notes, …)
packages/api/          Public `obsidian` module shim exposed to community plugins
fixtures/vaults/       Test vaults (edge-case Markdown, large vaults, plugin test vault)
```

---

## 2. Architecture (mirrors the public API)

```
App
 ├─ vault: Vault ──────────── DataAdapter (FileSystemAdapter | CapacitorAdapter)
 │     TFile / TFolder / TAbstractFile tree, file watcher, create/modify/rename/delete events
 ├─ metadataCache: MetadataCache ── parser worker
 │     per-file CachedMetadata: headings, links, embeds, tags, blocks, sections,
 │     frontmatter, listItems; resolvedLinks / unresolvedLinks; link resolution
 ├─ fileManager: FileManager ── link-updating renames, frontmatter processing
 ├─ workspace: Workspace
 │     rootSplit / leftSplit / rightSplit / floating (popout windows)
 │     WorkspaceSplit → WorkspaceTabs → WorkspaceLeaf → View (ItemView, MarkdownView, FileView…)
 │     layout (de)serialisation to .obsidian/workspace.json
 ├─ commands / hotkeys (Scope, keymap, command palette)
 ├─ internalPlugins (core plugins, toggled in core-plugins.json)
 ├─ plugins (community plugins, .obsidian/plugins/<id>/{manifest.json,main.js,styles.css,data.json})
 └─ customCss (themes in .obsidian/themes, snippets in .obsidian/snippets)
```

Rules:

- `packages/core` is the source of truth. Views subscribe to model events and don't own state.
- Parsing runs in a worker. The UI thread never blocks on a vault-wide operation.
- The public API only grows by adding things. Anything in `obsidian.d.ts` gets implemented
  with matching semantics, including quirks like `vault.on('create')` firing during the
  initial load.

---

## 3. Phased roadmap

Each phase ends with something you can demo and a parity checklist (§5). Effort figures assume
2–3 experienced engineers. They're rough estimates.

### Phase 0: Foundations (1–2 weeks)

- Monorepo, TS configs, lint/format, esbuild, Electron main/preload, CI (lint, typecheck, unit, E2E).
- `Events` base class, `Component` lifecycle (`load`, `onload`, `register*`, `addChild`), DOM helpers.
- Icon system (Lucide) and `setIcon`.
- CSS variable token sheet with light and dark base themes.

### Phase 1: Vault and a working editor (4–6 weeks)

- Open vault / vault switcher / create vault. Vault list stored in the app-data dir.
- `FileSystemAdapter`, file tree model, chokidar watcher, debounced external-change handling.
- File explorer: create, rename, delete (to system trash / `.trash`), drag-move, sort, reveal.
- Markdown editor on CM6: **source mode** first, then **Live Preview** (the hard part: hide
  syntax outside the cursor line, inline widgets for links, images, checkboxes, callouts,
  tables, embeds).
- Reading view renderer.
- Obsidian-flavoured Markdown, all of it:
  `[[wikilinks]]`, `[[note#heading]]`, `[[note#^block]]`, `[[note|alias]]`, `![[embeds]]`
  (notes, headings, blocks, images, audio, video, PDF), `^block-ids`, `#tags` and `#nested/tags`,
  YAML frontmatter, `> [!callout]+/-` (foldable), `==highlight==`, `%%comments%%`,
  footnotes (inline too), task lists with custom statuses, tables, `$math$` / `$$math$$`
  (MathJax), ` ```mermaid `, code highlighting, HTML passthrough (sanitised).
- Autosave (~2 s debounce), undo history per file.

### Phase 2: Links and the metadata graph (3–4 weeks)

- MetadataCache running in a worker, persisted to IndexedDB for fast startup on large vaults.
- Link resolution rules: shortest path, relative, or absolute (the "New link format" setting),
  case-insensitive matching, attachments folder setting.
- Rename a file → rewrite all links to it (with a setting to skip this).
- Backlinks pane (linked and unlinked mentions), outgoing links pane, outline pane, tags pane.
- Link autocomplete (`[[`, `[[#`, `[[^`), tag autocomplete, hover preview (`Ctrl` + hover).
- Properties: typed frontmatter editor (text, list, number, checkbox, date, datetime),
  `types.json`, and the "All properties" view.

### Phase 3: Workspace (4–5 weeks)

- Splits, tab groups, drag tabs to split, stacked tabs, pinned tabs, linked panes.
- Left and right sidebars with ribbon, collapsible and resizable.
- Navigation history (back/forward per leaf).
- Popout windows (multiple BrowserWindows sharing one App state).
- Save/restore layout to `workspace.json`. Workspaces core plugin (named layouts).
- Status bar.

### Phase 4: Commands, search, navigation (3 weeks)

- Command palette and Quick switcher (fuzzy matching with the same scoring feel, aliases, headings).
- Hotkey manager: defaults, per-command overrides in `hotkeys.json`, conflict display.
- Search: full-text plus operators (`file:`, `path:`, `tag:`, `line:`, `block:`, `section:`,
  `task:`, `[property:value]`, regex, boolean). Results pane and embedded ` ```query ` blocks.
- In-file find/replace.

### Phase 5: Core plugins (6–8 weeks, can run in parallel)

Priority order:

1. Daily notes, Templates, Bookmarks, Outline, Tags, Word count, File recovery (snapshots).
2. **Graph view**: global and local, forces, filters, groups, colour by query. WebGL renderer
   (PixiJS) with a d3-force simulation in a worker so it scales to 10k+ nodes.
3. **Canvas**: JSON Canvas format (`.canvas`). Cards, notes, media, groups, edges, zoom/pan,
   minimap-free interactions like Obsidian's.
4. **Bases**: `.base` files, database-style table/card views over properties with filters,
   formulas and sorting.
5. Slides, Audio recorder, Page preview, Note composer (merge/extract), Unique note creator,
   Random note, Format converter, Sync/Publish placeholders (see §3 Phase 9).

### Phase 6: Settings, appearance, themes (2–3 weeks)

- Settings modal, same section structure (Editor, Files & links, Appearance, Hotkeys, Core
  plugins, Community plugins).
- `app.json`, `appearance.json` (base theme, accent colour, font sizes, fonts, translucency).
- Theme loader (`.obsidian/themes/<name>/theme.css`), CSS snippets with live reload.
- **Compatibility target:** the 20 most popular community themes render correctly. We check
  this with screenshot tests against a reference vault.

### Phase 7: Community plugin compatibility (6–10 weeks, ongoing)

- A `require('obsidian')` shim exporting classes and functions that match `obsidian.d.ts`:
  `Plugin`, `PluginSettingTab`, `Setting`, `Modal`, `Notice`, `Menu`, `ItemView`,
  `MarkdownView`, `MarkdownRenderer`, `MarkdownRenderChild`, `EditorSuggest`,
  `FuzzySuggestModal`, `TFile`, `normalizePath`, `requestUrl`, `moment`, `debounce`, …
- `registerView`, `registerExtensions`, `registerMarkdownPostProcessor`,
  `registerMarkdownCodeBlockProcessor`, `registerEditorExtension`, `registerObsidianProtocolHandler`,
  `addRibbonIcon`, `addStatusBarItem`, `addCommand`, `loadData` / `saveData`.
- Browse, install and update plugins from the public `community-plugins.json` registry and
  GitHub releases. Restricted mode on by default.
- **Compatibility target:** the top 50 plugins load and their main features work (Dataview,
  Templater, Excalidraw, Tasks, Calendar, Kanban, Git, Style Settings, …). We track this in a
  CI compatibility matrix.
- Many plugins also use **undocumented internals** (`app.internalPlugins`, `app.setting`,
  `app.commands`, `workspace.leftSplit.collapsed`, and so on). We'll add these one at a time,
  driven by the compatibility matrix.

### Phase 8: Polish and platform (ongoing)

- `obsidian://`-style URI scheme under our own protocol name, "Open vault as folder",
  "Show in system explorer", spellcheck, i18n, RTL, accessibility, auto-update, crash
  reporting (opt-in).
- Performance budgets (§6).

### Phase 9: Optional services (separate project)

- **Sync:** end-to-end encrypted, version history, selective sync. Needs a backend service
  plus conflict resolution (diff-match-patch three-way merge for Markdown).
- **Publish:** static-site export or hosted publishing.
- **Mobile:** a Capacitor app with a mobile toolbar, gestures, and a mobile layout (drawers
  instead of sidebars).

Rough total to a strong desktop v1 (Phases 0–7): **9–12 months** for a small team.
Getting pixel-level parity and broad plugin compatibility has a long tail after that.

---

## 4. Getting "exact" behaviour without copying

1. **Behaviour spec from observation.** For each feature, write a short spec in `docs/spec/`
   from the public docs and hands-on testing with the real app. Record edge cases as fixtures.
2. **Golden tests.**
   - Markdown rendering: a fixture corpus of `.md` input and expected HTML structure and
     classes (`.callout`, `.internal-link`, `.cm-hmd-*`, …). Themes and plugins select on
     these class names, so they have to match exactly.
   - Metadata: fixture vault → expected `CachedMetadata` JSON.
   - Link resolution and rename-rewrite matrices.
3. **Visual parity.** Playwright screenshots of our app next to reference screenshots
   captured by hand, with per-component diff thresholds.
4. **Plugin matrix.** CI installs pinned versions of the top N plugins into a test vault and
   runs smoke scripts for each one.

---

## 5. Parity checklist (tracked as GitHub issues, one per line item)

Vault & files · Editor (source) · Live Preview · Reading view · OFM syntax (each element) ·
Embeds · Properties · Link resolution · Rename/refactor · Backlinks · Outline · Tags ·
Search operators · Quick switcher · Command palette · Hotkeys · Splits/tabs/sidebars ·
Popouts · Workspace persistence · Graph · Canvas · Bases · Daily notes · Templates ·
Bookmarks · File recovery · Settings · Themes · Snippets · Plugin API surface · Plugin
browser · URI scheme · Export to PDF · Drag & drop (files, links, images) · Paste images →
attachments · Spellcheck · i18n.

---

## 6. Performance budgets

| Metric                              | Budget                    |
| ----------------------------------- | ------------------------- |
| Cold start, 10k-note vault (cached) | < 1.5 s to editable       |
| First index, 10k notes              | < 10 s, off the UI thread |
| Keystroke latency in Live Preview   | < 16 ms p95               |
| Quick switcher on 50k files         | < 50 ms per keystroke     |
| Graph view, 10k nodes               | 60 fps pan/zoom           |

We'll keep a benchmark vault generator in `fixtures/` and run perf tests in CI.

---

## 7. Main risks

| Risk                                                           | Mitigation                                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Live Preview complexity (cursor-aware hiding, widgets, tables) | Build it early (Phase 1), cover it heavily with E2E tests, and iterate                  |
| Plugins depending on undocumented internals                    | Let the compatibility matrix decide which internals to add                              |
| Theme breakage from DOM/class drift                            | Golden DOM tests; freeze class names once they match                                    |
| Trademark/IP                                                   | Own name and branding, clean-room reimplementation, no copied assets                    |
| Scope explosion                                                | Ship the desktop v1 at the end of Phase 6. Plugin compatibility and services come later |

---

## 8. Decisions

| Question             | Decision                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Plugin compatibility | **Required for v1.** Electron is locked in, the renderer runs with Node integration ([ADR 0002](adr/0002-electron-renderer-node-integration.md)), and DOM/class names mirror what themes and plugins target. |
| Platforms            | **Desktop first.** Mobile (Capacitor) stays in Phase 9.                                                                                                                                                      |
| Product name         | Open. "Basalt" is the working name.                                                                                                                                                                          |
| Sync/Publish         | Open. Not started before desktop v1.                                                                                                                                                                         |
| Team and timeline    | Open.                                                                                                                                                                                                        |

## 9. Status

### Phase 0: done

- npm-workspaces monorepo (`packages/core`, `packages/ui`, `packages/editor`, `apps/desktop`),
  esbuild build, ESLint + Prettier, Vitest, Playwright-for-Electron, GitHub Actions CI.
- `Events`, `Component`, `normalizePath`, `TAbstractFile`/`TFile`/`TFolder`, `DataAdapter`,
  `FileSystemAdapter`, `Vault` (full plugin-API method set, file watcher, serialised mutations).
- Every global DOM helper from the plugin typings (`createEl`, `empty`, `addClass`, delegated
  `on`/`off`, …), plus `setIcon`/`addIcon`/`getIcon`/`getIconIds` over all Lucide icons.
- CSS tokens using the documented theme variable names, with light and dark themes.
- Desktop app: vault chooser with recent vaults, file explorer (expand/collapse, new
  note/folder, inline rename, extension tags), CodeMirror 6 source editor, 2 s autosave (plus
  save on switch and on close), live reload on external edits, rename from the title, word count.
- Checked against the official typings at compile time
  ([ADR 0003](adr/0003-plugin-api-conformance.md)).

Moved to Phase 1: the Markdown fixture corpus and golden-test harness. They belong with the
parser, which is where Phase 1 starts.

### Phase 1: done

- `packages/markdown`: one Lezer grammar for Obsidian-flavoured Markdown (wikilinks,
  embeds, highlights, comments, tags, block ids, math, footnotes, frontmatter, tasks with any
  status), shared by the editor and the renderer ([ADR 0004](adr/0004-one-grammar-sanitised-rendering.md)).
- HTML renderer with a CommonMark flavour graded against the official spec: **637/652**
  examples pass; the 15 remaining are parser-level and documented in the test.
- Golden fixtures for every OFM feature (`fixtures/markdown`), reviewed by hand.
- Reading view (Ctrl/Cmd+E): callouts with folding, tables, footnotes, MathJax, image,
  audio, video, PDF and note embeds with heading/block subpaths, sanitised through DOMPurify
  with a fail-closed self-check.
- Live Preview: syntax hides away from the cursor; bullets, checkboxes, rules, images,
  embeds and math render in place; tables, callouts and math blocks render as blocks until
  the cursor enters. Source mode keeps the same token classes. Mode toggle in the status bar.
- Link navigation: `LinkResolver` with `getFirstLinkpathDest` semantics; following an
  unresolved link creates the note; heading subpaths scroll.
- `Menu`, `Notice`, `Modal`, `Scope`, `Keymap` (plugin API); explorer context menu, delete
  confirmation, make a copy, copy path, reveal in system explorer, drag-and-drop moves,
  incremental tree updates.
- Hardening: vault paths can't escape the vault root; `openPath` only opens document/media
  types; unresolved relative images never load from the app folder; the CSP stays free of
  `unsafe-eval`.

Deferred from Phase 1, with the phase that picks them up:

- code-block syntax highlighting in both views, Mermaid diagrams (Phase 5, with other
  renderers);
- image/PDF/audio file views and opening links in new tabs (Phase 3, workspace);
- properties UI for frontmatter (Phase 2);
- dropping OS files into the explorer, and attachment paste (Phase 2, with the
  attachment-folder setting).

### Phase 2: done

- `MetadataCache` (plugin API): headings, links, embeds, tags, blocks, sections, list items,
  footnotes and frontmatter per note from the shared grammar; resolved/unresolved link maps;
  `changed`/`deleted`/`resolve`/`resolved` events; backlinks and tag counts. Parsing runs in
  a Web Worker pool, and results persist in IndexedDB, so startup re-parses only changed notes.
- `FileManager` (plugin API): renames rewrite wikilinks, embeds, Markdown links and
  frontmatter links, keeping subpaths and aliases; link generation follows the link-format
  settings; `processFrontMatter`; attachment paths; trash setting. Settings read from
  `.obsidian/app.json` through `vault.getConfig`.
- Right sidebar: backlinks (linked and unlinked mentions, one-click linking), outgoing links,
  outline, tags (nested, with counts).
- Editor: `[[` link autocomplete with aliases, `#heading` and `#^block` targets, `#tag`
  autocomplete, all ranked by `prepareFuzzySearch`; hover previews (reading view, previews,
  and Ctrl/Cmd-hover in the editor).
- Attachments: paste or drop files into a note (saved per the attachment-folder setting,
  embedded); drop OS files on the explorer to import them.
- Properties: typed frontmatter (text, list, number, checkbox, date, date-time, tags,
  aliases), editable in Live Preview and read-only in the reading view.

Deferred from Phase 2:

- per-property type overrides (`types.json`) and the "All properties" view (Phase 6, with
  settings);
- unlinked mentions in the outgoing-links pane;
- search-backed tag clicks (Phase 4).

### Phase 3: next

The workspace: splits, tab groups, drag tabs to split, linked panes, navigation history,
popout windows, `workspace.json` persistence, and file views for images, PDF, audio and
video. Plugin-facing `Workspace`, `WorkspaceLeaf`, `ItemView`, `MarkdownView` and `FileView`.
