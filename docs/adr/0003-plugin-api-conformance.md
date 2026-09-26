# ADR 0003: Plugin API conformance

Status: accepted

## Context

Plugins are compiled against the `obsidian` typings. When our classes drift from them,
plugins break at runtime, and nothing warns us until someone reports it.

## Decision

- The `obsidian` npm package (MIT) is a dev dependency and is the contract.
- `packages/core/test/api-conformance.ts` is compiled on every typecheck:
  - classes whose public shape can match exactly are checked structurally with
    `satisfies Api.X` (`Events`, `Component`, `DataAdapter`, `FileSystemAdapter`);
  - stateful classes (`Vault`, `TFile`, `TFolder`) are checked for member coverage. Every API
    member must exist. Private fields make TypeScript classes nominal, so a full structural
    check is impossible there.
- Internal helpers that would change the public shape of a small API class live outside it
  (e.g. `Component` lifecycle state in a `WeakMap`; `setFilePath` as a free function).
- The global DOM helpers are typed from the typings' own `declare global` block, so their
  signatures can't drift.
- Exactly one copy of `@codemirror/state` and `@codemirror/view` is installed (npm
  `overrides`). Plugins that register editor extensions share the host's instances, and CM6
  refuses to mix instances.

## Consequences

Each newly implemented API class gets a line in the conformance file. Updating the `obsidian`
dev dependency surfaces new API members as typecheck failures, which gives us a work list.
