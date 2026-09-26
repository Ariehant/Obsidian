# ADR 0002: Electron renderer with Node integration

Status: accepted

## Context

Community plugins are CommonJS bundles that call `require('fs')`, `require('path')`,
`require('electron')` and `require('obsidian')` directly from the renderer. Plugin
compatibility is a v1 requirement (PLAN §8).

## Decision

- The shell is Electron, not Tauri or a browser build.
- The main window runs with `nodeIntegration: true`, `contextIsolation: false` and
  `sandbox: false`, like the app plugins were written for.
- The renderer bundle is an IIFE built for the Node platform, so builtins resolve at runtime
  through the renderer's `require`.

## Mitigations

Node integration means any script running in the renderer has full user privileges, so:

- the window never navigates (`will-navigate` is blocked; http(s) links open in the system
  browser; `window.open` is denied);
- a Content Security Policy only allows local scripts;
- the `app://local/…` protocol only serves files inside the open vault;
- IPC handlers validate their arguments (e.g. trash only inside the vault);
- rendered Markdown HTML will be sanitised (Phase 1), and community plugins will be off
  by default until the user trusts the vault ("restricted mode", Phase 7).

## Consequences

Plugin loading in Phase 7 evaluates plugin code, which needs `'unsafe-eval'` or an equivalent
loader. That CSP change has to be made deliberately, and reviewed when it is.
