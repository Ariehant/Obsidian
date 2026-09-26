# Fixtures

- `vaults/basic` — small vault used by the desktop E2E suite. Tests copy it to a temp
  folder before launching, so it is never modified in place. It includes a hidden
  `.obsidian/` folder (must not appear in the file tree) and a non-Markdown attachment
  (must show its extension tag).
