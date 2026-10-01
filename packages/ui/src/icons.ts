/**
 * Icon registry matching the plugin API: `setIcon`, `addIcon`, `getIcon`, `getIconIds`.
 *
 * Every Lucide icon is available under its kebab-case name, with or without a `lucide-`
 * prefix (e.g. `file-text` or `lucide-file-text`). `addIcon` registers custom icons whose
 * SVG content is drawn in a 0 0 100 100 viewBox.
 */
import { icons as lucideIcons } from 'lucide';

type IconNode = [tag: string, attrs: Record<string, string | number>][];

const SVG_NS = 'http://www.w3.org/2000/svg';
const LUCIDE_PREFIX = 'lucide-';
const custom = new Map<string, string>();

/**
 * Icon ids specific to Obsidian that plugins pass to `setIcon`, mapped to Lucide icons with
 * the same meaning (we don't ship Obsidian's own artwork).
 */
const ALIASES: Record<string, string> = {
  'links-coming-in': 'log-in',
  'links-going-out': 'log-out',
  'right-triangle': 'chevron-right',
  document: 'file',
  documents: 'files',
  install: 'download',
  'sheets-in-box': 'archive',
  'stacked-levels': 'layers',
  switch: 'toggle-right',
  reset: 'rotate-ccw',
  'popup-open': 'external-link',
  'pane-layout': 'layout-dashboard',
};

function pascalCase(kebab: string): string {
  return kebab
    .split('-')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : ''))
    .join('');
}

function kebabCase(pascal: string): string {
  return pascal
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-zA-Z])([0-9])/g, '$1-$2')
    .toLowerCase();
}

function lucideNode(iconId: string): IconNode | null {
  const id = ALIASES[iconId] ?? iconId;
  const name = id.startsWith(LUCIDE_PREFIX) ? id.slice(LUCIDE_PREFIX.length) : id;
  const node = (lucideIcons as Record<string, IconNode | undefined>)[pascalCase(name)];
  return node ?? null;
}

function svgRoot(doc: Document, iconId: string, viewBox: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.classList.add('svg-icon', iconId);
  return svg;
}

/** Registers a custom icon. `svgContent` is the inner markup of a 0 0 100 100 SVG. */
export function addIcon(iconId: string, svgContent: string): void {
  custom.set(iconId, svgContent);
}

/** Returns a new SVG element for the icon, or null if the id is unknown. */
export function getIcon(iconId: string, doc: Document = document): SVGSVGElement | null {
  const customSvg = custom.get(iconId);
  if (customSvg !== undefined) {
    const svg = svgRoot(doc, iconId, '0 0 100 100');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('stroke', 'none');
    svg.innerHTML = customSvg;
    return svg;
  }

  const node = lucideNode(iconId);
  if (!node) return null;
  const name = iconId.startsWith(LUCIDE_PREFIX) ? iconId : LUCIDE_PREFIX + iconId;
  const svg = svgRoot(doc, name, '0 0 24 24');
  for (const [tag, attrs] of node) {
    const child = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, String(v));
    svg.appendChild(child);
  }
  return svg;
}

/** Replaces the parent's content with the icon. Does nothing for unknown ids. */
export function setIcon(parent: HTMLElement, iconId: string): void {
  const svg = getIcon(iconId, parent.ownerDocument);
  if (!svg) return;
  while (parent.lastChild) parent.removeChild(parent.lastChild);
  parent.appendChild(svg);
}

export function getIconIds(): string[] {
  const ids = new Set<string>();
  for (const key of Object.keys(lucideIcons)) ids.add(LUCIDE_PREFIX + kebabCase(key));
  for (const key of Object.keys(ALIASES)) ids.add(key);
  for (const key of custom.keys()) ids.add(key);
  return [...ids];
}
