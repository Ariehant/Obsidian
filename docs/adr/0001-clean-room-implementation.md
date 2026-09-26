# ADR 0001: Clean-room implementation

Status: accepted

## Context

The goal is an app that behaves like Obsidian and runs its plugins and themes. Obsidian is
closed source, and its name and logo are trademarks.

## Decision

- We never decompile, extract or copy Obsidian's bundled code, CSS, icons or other assets.
  Behaviour comes from public documentation, the MIT-licensed plugin API typings
  (`obsidian` on npm), the open JSON Canvas spec, and hands-on observation.
- The product ships under its own name and branding (working name: Basalt).
- **Interoperability identifiers are kept** because existing vaults, plugins and themes depend
  on them. None of them is shown to users as branding:
  - the default config folder `.obsidian/` and its JSON file names;
  - DOM class names and CSS variable names that themes target (including `cm-s-obsidian`);
  - the `obsidian` module name that plugins `require`, and the global `app`.
- CSS variable _values_, palettes, layout metrics and copy are our own.

## Consequences

Visual parity is judged against screenshots and behaviour, not by copying stylesheets. When
behaviour isn't documented, we write it down in `docs/spec/` before implementing it.
