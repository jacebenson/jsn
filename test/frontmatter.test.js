import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, stringifyFrontmatter } from '../src/frontmatter.js';

describe('frontmatter adapter', () => {
  it('strips a BOM from content without frontmatter', () => {
    assert.deepStrictEqual(parseFrontmatter('\ufeffplain body'), {
      data: {},
      content: 'plain body',
    });
  });

  it('strips a BOM before parsing YAML frontmatter', () => {
    assert.deepStrictEqual(parseFrontmatter('\ufeff---\ntitle: Guide\n---\nBody'), {
      data: { title: 'Guide' },
      content: 'Body',
    });
  });

  it('parses nested YAML mappings, sequences, scalars, and multiline values', () => {
    const result = parseFrontmatter(`---
title: Guide
published: true
count: 3
tags:
  - docs
  - yaml
author:
  name: Jace
summary: |
  First line
  Second line
---
Body`);

    assert.deepStrictEqual(result.data, {
      title: 'Guide',
      published: true,
      count: 3,
      tags: ['docs', 'yaml'],
      author: { name: 'Jace' },
      summary: 'First line\nSecond line\n',
    });
    assert.strictEqual(result.content, 'Body');
  });

  it('preserves valid falsy YAML roots', () => {
    for (const value of ['false', 'null', '0']) {
      assert.strictEqual(parseFrontmatter(`---\n${value}\n---\nBody`).data,
        value === 'false' ? false : value === 'null' ? null : 0);
    }
  });

  it('returns an empty object for empty YAML frontmatter', () => {
    assert.deepStrictEqual(parseFrontmatter('---\n---\nBody'), {
      data: {},
      content: 'Body',
    });
  });

  it('uses exact default delimiters and leaves non-frontmatter input intact', () => {
    assert.deepStrictEqual(parseFrontmatter('----\nnot frontmatter'), {
      data: {},
      content: '----\nnot frontmatter',
    });
    assert.deepStrictEqual(parseFrontmatter('---\ntitle: Hi\n---\n\nBody').content, '\nBody');
  });

  it('supports an explicit delimiter pair with the same boundary rules', () => {
    assert.deepStrictEqual(parseFrontmatter('+++\nkind: note\n+++\nBody', {
      delimiters: ['+++', '+++'],
    }), { data: { kind: 'note' }, content: 'Body' });
    assert.deepStrictEqual(parseFrontmatter('++++\nBody', {
      delimiters: ['+++', '+++'],
    }), { data: {}, content: '++++\nBody' });
  });

  it('throws on malformed YAML so callers can retain raw-body fallback', () => {
    assert.throws(() => parseFrontmatter('---\ntitle: [\n---\nBody'), /end of the stream|flow collection/i);
  });

  it('stringifies community metadata and body with a round trip', () => {
    const source = stringifyFrontmatter('Body\n', {
      title: 'Community post',
      bundle: 'community',
      metadata: { category: 'How to' },
      tags: ['docs', 'community'],
    });

    assert.strictEqual(source, `---
title: Community post
bundle: community
metadata:
  category: How to
tags:
  - docs
  - community
---
Body
`);
    assert.deepStrictEqual(parseFrontmatter(source), {
      data: {
        title: 'Community post',
        bundle: 'community',
        metadata: { category: 'How to' },
        tags: ['docs', 'community'],
      },
      content: 'Body\n',
    });
  });
});
