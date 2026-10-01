/**
 * Compile-time check of our implementations against the public plugin API typings
 * (`obsidian` package, MIT). Never executed; `npm run typecheck` fails when a class drifts
 * from the contract plugins are compiled against.
 *
 * Two levels:
 * - Full structural check (`satisfies`) for classes whose public shape can match exactly.
 * - Member coverage (`MissingMembers`) for stateful classes. Their private fields make them
 *   nominal in TypeScript, so the API's own parameter types (e.g. its `TFile`) can't be
 *   assigned to ours even though at runtime there is only one implementation.
 *
 * Add a line here whenever another API class is implemented.
 */
import type * as Api from 'obsidian';
import type { Menu, MenuItem, Modal, Notice } from '@basalt/ui';
import type {
  Component,
  DataAdapter,
  Events,
  FileManager,
  FileSystemAdapter,
  Keymap,
  MetadataCache,
  Scope,
  TFile,
  TFolder,
  Vault,
} from '../src';

/** API member names our type doesn't have. Must resolve to `never`. */
type MissingMembers<Ours, Theirs> = Exclude<keyof Theirs, keyof Ours>;
type AssertNever<T extends never> = T;

declare const events: Events;
declare const component: Component;
declare const adapter: DataAdapter;
declare const fsAdapter: FileSystemAdapter;

export const structural: unknown[] = [
  events satisfies Api.Events,
  component satisfies Api.Component,
  adapter satisfies Api.DataAdapter,
  fsAdapter satisfies Api.FileSystemAdapter,
];

export type Coverage = [
  AssertNever<MissingMembers<Vault, Api.Vault>>,
  AssertNever<MissingMembers<typeof import('../src').Vault, typeof Api.Vault>>,
  AssertNever<MissingMembers<TFile, Api.TFile>>,
  AssertNever<MissingMembers<TFolder, Api.TFolder>>,
  AssertNever<MissingMembers<MetadataCache, Api.MetadataCache>>,
  AssertNever<MissingMembers<FileManager, Api.FileManager>>,
  AssertNever<MissingMembers<Scope, Api.Scope>>,
  AssertNever<MissingMembers<Keymap, Api.Keymap>>,
  AssertNever<MissingMembers<typeof import('../src').Keymap, typeof Api.Keymap>>,
  AssertNever<MissingMembers<Menu, Api.Menu>>,
  AssertNever<MissingMembers<typeof import('@basalt/ui').Menu, typeof Api.Menu>>,
  AssertNever<MissingMembers<MenuItem, Api.MenuItem>>,
  AssertNever<MissingMembers<Notice, Api.Notice>>,
  AssertNever<MissingMembers<Modal, Api.Modal>>,
];
