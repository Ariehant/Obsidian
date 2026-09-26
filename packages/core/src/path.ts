/**
 * Vault paths are always relative to the vault root, use `/` as separator, have no leading
 * or trailing slash, and are NFC-normalised. The root folder itself is `/`.
 */
export function normalizePath(path: string): string {
  let p = path
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/[\\/]+/g, '/')
    .replace(/^\/+|\/+$/g, '');
  p = p.normalize('NFC');
  return p === '' ? '/' : p;
}

/** Parent folder path of a normalised vault path; `/` for top-level entries. */
export function parentPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '/' : path.slice(0, idx);
}

/** Last path segment. */
export function basenameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Joins a folder path and a child name into a vault path. */
export function joinPath(folder: string, name: string): string {
  return folder === '/' || folder === '' ? name : `${folder}/${name}`;
}

/**
 * Splits a file name into basename and extension. The extension excludes the dot and is
 * empty when there is none; a leading dot does not start an extension.
 */
export function splitExtension(name: string): { basename: string; extension: string } {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return { basename: name, extension: '' };
  return { basename: name.slice(0, idx), extension: name.slice(idx + 1) };
}

/** Whether any segment of the path is hidden (dot-prefixed). Hidden entries are not indexed. */
export function isHiddenPath(path: string): boolean {
  return path.split('/').some((seg) => seg.startsWith('.'));
}
