# ADR 0004: One Markdown grammar, sanitised rendering

Status: accepted

## Context

Obsidian-flavoured Markdown shows up in four places: the editor (highlighting, Live
Preview), the reading view, embeds, and the metadata cache (links, headings, block ids).
When those use different parsers, they disagree on edge cases: a link that highlights in the
editor but isn't indexed, a block id that renders as text. Reading-view HTML also comes
from untrusted notes and runs in a renderer with Node access (ADR 0002).

## Decision

- One Lezer grammar (`packages/markdown/src/syntax.ts`: CommonMark + GFM + OFM extensions)
  is used by CodeMirror, the HTML renderer and, from Phase 2, the metadata cache.
- The renderer walks the Lezer tree to an HTML string. Its CommonMark flavour runs against
  the official spec suite in CI. Known failures are listed with reasons, and the test fails
  when one of them starts passing, so the list can't go stale.
- OFM output is pinned by golden fixtures that are reviewed by hand.
- The HTML string is always sanitised with DOMPurify before it enters a document. On first
  use the sanitiser is fed a canary (script, event handler, `javascript:` URL), and rendering
  refuses to proceed if any of them survives, because DOMPurify returns its input unchanged
  in DOMs it doesn't support.
- Live Preview renders blocks (tables, callouts, embeds) with the same reading-view
  pipeline, so both views show the same thing.

## Consequences

- Grammar differences from `@lezer/markdown` (tab expansion, some link-bracket and raw-HTML
  edge cases) affect every view equally. Fixing them means fixing the grammar once.
- DOM-level renderer tests run under jsdom, since happy-dom breaks DOMPurify. A test pins
  that the renderer fails closed there.
