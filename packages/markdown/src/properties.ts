/**
 * Properties: the typed view of a note's YAML frontmatter, shown read-only in the reading
 * view and editable in Live Preview. Types are inferred from values; `tags` and `aliases`
 * are always lists.
 */
import { setIcon } from '@basalt/ui';

export type PropertyType =
  'text' | 'multitext' | 'number' | 'checkbox' | 'date' | 'datetime' | 'tags' | 'aliases' | 'unknown';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

const ICONS: Record<PropertyType, string> = {
  text: 'text',
  multitext: 'list',
  number: 'binary',
  checkbox: 'square-check',
  date: 'calendar',
  datetime: 'clock',
  tags: 'tags',
  aliases: 'forward',
  unknown: 'braces',
};

export function inferPropertyType(key: string, value: unknown): PropertyType {
  const k = key.toLowerCase();
  if (k === 'tags' || k === 'tag') return 'tags';
  if (k === 'aliases' || k === 'alias') return 'aliases';
  if (Array.isArray(value)) return 'multitext';
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'number') return 'number';
  if (value instanceof Date) return 'date';
  if (typeof value === 'string' && DATE.test(value)) return 'date';
  if (typeof value === 'string' && DATETIME.test(value)) return 'datetime';
  if (value === null || value === undefined || typeof value === 'string') return 'text';
  return 'unknown';
}

const isList = (t: PropertyType) => t === 'multitext' || t === 'tags' || t === 'aliases';

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined).map(String);
  if (typeof value === 'string')
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return value === null || value === undefined ? [] : [String(value)];
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export interface PropertiesOptions {
  /** Called with the complete new frontmatter after an edit. Omit for read-only. */
  onChange?: (frontmatter: Record<string, unknown>) => void;
}

/** Renders properties into `parent`. Returns the container. */
export function renderProperties(
  parent: HTMLElement,
  frontmatter: Record<string, unknown>,
  options: PropertiesOptions = {},
): HTMLElement {
  const editable = !!options.onChange;
  const container = parent.createDiv('metadata-container');
  container.setAttr('data-property-count', String(Object.keys(frontmatter).length));
  const heading = container.createDiv('metadata-properties-heading');
  heading.createDiv({ cls: 'metadata-properties-title', text: 'Properties' });
  const list = container.createDiv('metadata-content').createDiv('metadata-properties');

  const commit = (next: Record<string, unknown>) => options.onChange?.(next);
  const withValue = (key: string, value: unknown) => {
    const next = { ...frontmatter };
    next[key] = value;
    commit(next);
  };

  for (const [key, value] of Object.entries(frontmatter)) {
    const type = inferPropertyType(key, value);
    const row = list.createDiv({
      cls: 'metadata-property',
      attr: { 'data-property-key': key, 'data-property-type': type },
    });
    const keyEl = row.createDiv('metadata-property-key');
    setIcon(keyEl.createDiv('metadata-property-icon'), ICONS[type]);
    const valueEl = row.createDiv('metadata-property-value');

    if (!editable) {
      keyEl.createDiv({ cls: 'metadata-property-key-text', text: key });
      if (isList(type)) {
        const pills = valueEl.createDiv('multi-select-container');
        for (const item of listOf(value)) {
          const text = type === 'tags' ? `#${item.replace(/^#/, '')}` : item;
          pills.createDiv({ cls: `multi-select-pill${type === 'tags' ? ' tag' : ''}`, text });
        }
      } else if (type === 'checkbox') {
        valueEl.createEl('input', {
          type: 'checkbox',
          cls: 'metadata-input-checkbox',
          attr: { disabled: true, ...(value ? { checked: true } : {}) },
        });
      } else {
        valueEl.createDiv({ cls: 'metadata-property-value-text', text: displayValue(value) });
      }
      continue;
    }

    // Key: rename on blur/Enter, keeping the property's position.
    const keyInput = keyEl.createEl('input', {
      cls: 'metadata-property-key-input',
      type: 'text',
      value: key,
    });
    const renameKey = () => {
      const newKey = keyInput.value.trim();
      if (!newKey || newKey === key || newKey in frontmatter) {
        keyInput.value = key;
        return;
      }
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(frontmatter)) next[k === key ? newKey : k] = v;
      commit(next);
    };
    keyInput.addEventListener('blur', renameKey);
    keyInput.addEventListener('keydown', (ev) => ev.key === 'Enter' && keyInput.blur());

    if (isList(type)) {
      const box = valueEl.createDiv('multi-select-container');
      const items = listOf(value);
      items.forEach((item, i) => {
        const pill = box.createDiv({ cls: `multi-select-pill${type === 'tags' ? ' tag' : ''}` });
        pill.createSpan({ cls: 'multi-select-pill-content', text: item });
        const remove = pill.createSpan({
          cls: 'multi-select-pill-remove-button',
          attr: { 'aria-label': 'Remove' },
        });
        setIcon(remove, 'x');
        remove.addEventListener('click', () =>
          withValue(
            key,
            items.filter((_, j) => j !== i),
          ),
        );
      });
      const add = box.createEl('input', {
        cls: 'multi-select-input',
        type: 'text',
        attr: { placeholder: 'Add…' },
      });
      const addItem = () => {
        let v = add.value.trim();
        if (type === 'tags') v = v.replace(/^#/, '');
        if (v) withValue(key, [...items, v]);
      };
      add.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ',') {
          ev.preventDefault();
          addItem();
        } else if (ev.key === 'Backspace' && !add.value && items.length) {
          withValue(key, items.slice(0, -1));
        }
      });
      add.addEventListener('blur', addItem);
    } else if (type === 'checkbox') {
      const box = valueEl.createEl('input', { type: 'checkbox', cls: 'metadata-input-checkbox' });
      box.checked = !!value;
      box.addEventListener('change', () => withValue(key, box.checked));
    } else if (type === 'unknown') {
      valueEl.createDiv({
        cls: 'metadata-property-value-text',
        text: displayValue(value),
        attr: { title: 'Edit as YAML' },
      });
    } else {
      const input = valueEl.createEl('input', {
        cls: 'metadata-input metadata-input-text',
        type:
          type === 'number'
            ? 'number'
            : type === 'date'
              ? 'date'
              : type === 'datetime'
                ? 'datetime-local'
                : 'text',
        value: displayValue(value),
      });
      const save = () => {
        const raw = input.value;
        const next = type === 'number' ? (raw === '' ? null : Number(raw)) : raw === '' ? null : raw;
        if (next !== value && !(next === null && (value === null || value === ''))) withValue(key, next);
      };
      input.addEventListener(type === 'date' || type === 'datetime' ? 'change' : 'blur', save);
      input.addEventListener('keydown', (ev) => ev.key === 'Enter' && input.blur());
    }

    const remove = row.createDiv({
      cls: 'clickable-icon metadata-property-remove',
      attr: { 'aria-label': 'Remove property' },
    });
    setIcon(remove, 'x');
    remove.addEventListener('click', () => {
      const next = { ...frontmatter };
      delete next[key];
      commit(next);
    });
  }

  if (editable) {
    const add = container.createDiv({ cls: 'metadata-add-button text-icon-button', attr: { tabindex: '0' } });
    setIcon(add.createSpan('text-button-icon'), 'plus');
    add.createSpan({ cls: 'text-button-label', text: 'Add property' });
    add.addEventListener('click', () => {
      let name = 'property';
      for (let i = 1; name in frontmatter; i++) name = `property ${i}`;
      commit({ ...frontmatter, [name]: null });
    });
  }
  return container;
}
