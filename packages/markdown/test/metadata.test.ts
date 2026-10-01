import { getAllTags, getFrontMatterInfo, parseFrontMatterAliases, parseFrontMatterTags } from '@basalt/core';
import { describe, expect, it } from 'vitest';
import { computeMetadata } from '../src/metadata';

const NOTE = `---
title: Robot arm
tags: [robotics, "control/pid"]
aliases: Arm, Manipulator
related: "[[Kinematics]]"
---
# Robot arm

Uses [[Kinematics#Forward|FK]] and [Dynamics](Notes/Dynamics%20model.md) and
[external](https://example.com). See ![[diagram.png|300]] and ![img](img/a.png). #hardware

## Joints ^joints-h

- Base ^base
- Wrist
  - [x] Calibrated
  - [ ] Tested

Torque note[^1]. \`[[not a link]]\` %%[[hidden]]%%

[^1]: From the datasheet.

> [!warning] Limits
> Max 2 Nm.

Standalone paragraph.

^para
`;

describe('computeMetadata', () => {
  const meta = computeMetadata(NOTE);

  it('extracts headings with positions', () => {
    expect(meta.headings?.map((h) => [h.level, h.heading, h.position.start.line])).toEqual([
      [1, 'Robot arm', 6],
      [2, 'Joints', 11],
    ]);
    expect(meta.headings![0]!.position.start.col).toBe(0);
    expect(NOTE.slice(meta.headings![0]!.position.start.offset, meta.headings![0]!.position.end.offset)).toBe(
      '# Robot arm',
    );
  });

  it('extracts internal links and embeds, skipping code, comments and URLs', () => {
    expect(meta.links?.map((l) => [l.link, l.displayText, l.original])).toEqual([
      ['Kinematics#Forward', 'FK', '[[Kinematics#Forward|FK]]'],
      ['Notes/Dynamics model.md', 'Dynamics', '[Dynamics](Notes/Dynamics%20model.md)'],
    ]);
    expect(meta.embeds?.map((e) => [e.link, e.displayText])).toEqual([
      ['diagram.png', '300'],
      ['img/a.png', 'img'],
    ]);
    const l = meta.links![0]!;
    expect(NOTE.slice(l.position.start.offset, l.position.end.offset)).toBe(l.original);
  });

  it('extracts tags, frontmatter and frontmatter links', () => {
    expect(meta.tags?.map((t) => t.tag)).toEqual(['#hardware']);
    expect(meta.frontmatter).toEqual({
      title: 'Robot arm',
      tags: ['robotics', 'control/pid'],
      aliases: 'Arm, Manipulator',
      related: '[[Kinematics]]',
    });
    expect(meta.frontmatterPosition?.start.line).toBe(0);
    expect(meta.frontmatterPosition?.end.line).toBe(5);
    expect(meta.frontmatterLinks).toEqual([
      { key: 'related', link: 'Kinematics', original: '[[Kinematics]]', displayText: 'Kinematics' },
    ]);
    expect(getAllTags(meta)).toEqual(['#robotics', '#control/pid', '#hardware']);
    expect(parseFrontMatterTags(meta.frontmatter)).toEqual(['#robotics', '#control/pid']);
    expect(parseFrontMatterAliases(meta.frontmatter)).toEqual(['Arm', 'Manipulator']);
  });

  it('extracts list items with parents, tasks and ids', () => {
    expect(meta.listItems?.map((i) => [i.position.start.line, i.parent, i.task, i.id])).toEqual([
      [13, -13, undefined, 'base'],
      [14, -13, undefined, undefined],
      [15, 14, 'x', undefined],
      [16, 14, ' ', undefined],
    ]);
  });

  it('extracts blocks, footnotes and typed sections', () => {
    expect(Object.keys(meta.blocks ?? {})).toEqual(['joints-h', 'base', 'para']);
    expect(NOTE.slice(meta.blocks!.base!.position.start.offset, meta.blocks!.base!.position.end.offset)).toBe(
      '- Base ^base',
    );
    expect(NOTE.slice(meta.blocks!.para!.position.start.offset, meta.blocks!.para!.position.end.offset)).toBe(
      'Standalone paragraph.',
    );
    expect(meta.footnotes?.map((f) => f.id)).toEqual(['1']);
    expect(meta.footnoteRefs?.map((f) => f.id)).toEqual(['1']);
    expect(meta.sections?.map((s) => s.type)).toEqual([
      'yaml',
      'heading',
      'paragraph',
      'heading',
      'list',
      'paragraph',
      'footnoteDefinition',
      'callout',
      'paragraph',
      'paragraph',
    ]);
  });

  it('omits empty collections and survives invalid YAML', () => {
    expect(computeMetadata('plain text')).toEqual({
      sections: [{ type: 'paragraph', position: expect.any(Object) }],
    });
    const bad = computeMetadata('---\nkey: [unclosed\n---\nbody');
    expect(bad.frontmatterPosition).toBeDefined();
    expect(bad.frontmatter).toBeUndefined();
  });
});

describe('getFrontMatterInfo', () => {
  it('locates frontmatter and the body', () => {
    const text = '---\na: 1\n---\nbody';
    const info = getFrontMatterInfo(text);
    expect(info).toEqual({ exists: true, frontmatter: 'a: 1\n', from: 4, to: 9, contentStart: 13 });
    expect(text.slice(info.contentStart)).toBe('body');
    expect(getFrontMatterInfo('no fm').exists).toBe(false);
  });
});
