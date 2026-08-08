import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractBodyHtml, extractMeta, extractCommunityLinks, htmlToMarkdown, slugify,
} from '../src/commands/docs/community.js';
import { walkDocs } from '../src/commands/docs/db.js';

const SAMPLE = `
<html><head><title>My Article - ServiceNow Community</title></head>
<body>
  <div class="lia-quilt">
    <div class="lia-message-body-wrapper">
      <div class="lia-message-body-content">
        <h1>My Article</h1>
        <p>Hello <strong>world</strong>.</p>
        <p><a href="https://www.servicenow.com/community/developer-articles/foo-bar/ta-p/12345">Foo</a></p>
        <p><a href="https://www.servicenow.com/community/user/viewprofilepage/user-id/1">profile</a></p>
        <p><a href="https://example.com/other">external</a></p>
      </div>
    </div>
  </div>
</body></html>`;

describe('community extractBodyHtml', () => {
  it('should extract the lia-message-body-content div', () => {
    const body = extractBodyHtml(SAMPLE);
    assert.ok(body.includes('<h1>My Article</h1>'));
    assert.ok(body.includes('Hello <strong>world</strong>.'));
    assert.ok(!body.includes('lia-quilt'));
  });

  it('should return null when marker is absent', () => {
    assert.equal(extractBodyHtml('<html><body><p>x</p></body></html>'), null);
  });
});

describe('community extractMeta', () => {
  it('should pull title from h1', () => {
    const meta = extractMeta(SAMPLE);
    assert.equal(meta.title, 'My Article');
  });

  it('should decode HTML entities in title', () => {
    const html = '<h1>Knowledge &amp; Troubleshooting</h1>';
    assert.equal(extractMeta(html).title, 'Knowledge & Troubleshooting');
  });

  it('should pull author from itemprop name span', () => {
    const html = `<span content="Mark Roethof" itemprop="name" class="login-bold">Mark Roethof</span>`;
    assert.equal(extractMeta(html).author, 'Mark Roethof');
  });

  it('should pull authorUrl from user-name-link', () => {
    const html = `<a class="lia-user-name-link" href="https://www.servicenow.com/community/user/viewprofilepage/user-id/201738">x</a>`;
    assert.equal(extractMeta(html).authorUrl, 'https://www.servicenow.com/community/user/viewprofilepage/user-id/201738');
  });
});

describe('community extractCommunityLinks', () => {
  it('should find only new Khoros community article links', () => {
    const links = extractCommunityLinks(SAMPLE, 'https://www.servicenow.com/community/developer-blog/x/ba-p/1');
    assert.deepEqual(links, ['https://www.servicenow.com/community/developer-articles/foo-bar/ta-p/12345']);
  });

  it('should dedupe repeated links', () => {
    const html = `<div class="lia-message-body-content">
      <a href="https://www.servicenow.com/community/a/b/ta-p/1">x</a>
      <a href="https://www.servicenow.com/community/a/b/ta-p/1">y</a>
    </div>`;
    assert.equal(extractCommunityLinks(html, 'https://www.servicenow.com').length, 1);
  });
});

describe('community htmlToMarkdown', () => {
  it('should convert HTML to markdown', () => {
    const md = htmlToMarkdown('<p>Hello <strong>world</strong>.</p>');
    assert.match(md, /Hello \*\*world\*\*\./);
  });
});

describe('community slugify', () => {
  it('should produce a kebab-case slug', () => {
    assert.equal(slugify('  Knowledge Sources To Go!! '), 'knowledge-sources-to-go');
  });
  it('should fall back to provided fallback', () => {
    assert.equal(slugify('', 'untitled'), 'untitled');
  });
});

describe('writeCommunityDoc filename uniqueness', () => {
  it('should include the post id so identical titles never collide', async () => {
    const { writeCommunityDoc } = await import('../src/commands/docs/community.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-community-'));
    const body = 'body text\n';
    const one = writeCommunityDoc({
      author: 'Test Author', title: 'Same Title', url: 'https://www.servicenow.com/community/a/b/ta-p/111',
      bodyMd: body, docType: 'article', communityDir: tmp,
    });
    const two = writeCommunityDoc({
      author: 'Test Author', title: 'Same Title', url: 'https://www.servicenow.com/community/a/b/ta-p/222',
      bodyMd: body, docType: 'article', communityDir: tmp,
    });
    assert.notEqual(one.rel, two.rel);
    assert.match(one.rel, /-ta-p-111\.md$/);
    assert.match(two.rel, /-ta-p-222\.md$/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('walkDocs multi-root', () => {
  it('should walk two roots with prefixes without collision', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-docs-walk-'));
    fs.mkdirSync(path.join(dir, 'a', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'one.md'), 'x');
    fs.writeFileSync(path.join(dir, 'a', 'sub', 'two.md'), 'x');
    fs.writeFileSync(path.join(dir, 'b', 'three.md'), 'x');
    fs.writeFileSync(path.join(dir, 'b', 'notes.txt'), 'x'); // ignored
    const roots = [
      { dir: path.join(dir, 'a'), prefix: '' },
      { dir: path.join(dir, 'b'), prefix: 'community/' },
    ];
    const files = [...walkDocs(roots)].map((f) => f.rel).sort();
    assert.deepEqual(files, ['community/three.md', 'one.md', 'sub/two.md']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
