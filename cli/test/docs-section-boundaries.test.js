import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDocument } from '../src/commands/docs/sections.js';

test('CommonMark boundaries retain CRLF, containers and code; duplicate setext is ambiguous', () => {
  const body = ['Preamble', '', 'Title', '=====', '', 'Warning.', '', '## A `signature` \\*', '', '````js', '```', '## fake', '````', '', '~~~', '## fake tilde', '~~~', '', '    ## indented', '', '> ## quoted', '', '- ## listed', '', '<table>', '<tr><td>## html</td></tr>', '</table>', '', 'Repeat', '------', 'one', '', 'Repeat', '------', 'two', ''].join('\r\n');
  const row = { path: 'fixture.md', revision: 'r', release: 'australia', body };
  const result = selectDocument(row, { outline: true });
  assert.deepEqual(result.outline.map(h => h.title), ['Title', 'A signature *', 'Repeat', 'Repeat']);
  assert.equal(selectDocument(row, { section: 'A signature *' }).body, body.slice(0, body.indexOf('Repeat')));
  assert.throws(() => selectDocument(row, { section: 'Repeat' }), /Ambiguous.*s1:/);
  assert.throws(() => selectDocument(row, { section: '' }), /empty/);
  assert.throws(() => selectDocument(row, { outline: true, section: 'Title' }), /either/);
  assert.equal(selectDocument(row), row);
  assert.deepEqual(selectDocument({ ...row, body: 'No headings\n' }, { outline: true }).outline, []);
  assert.throws(() => selectDocument({ ...row, path: 'other.md' }, { section: result.outline[1].id }), /No matching/);
  assert.throws(() => selectDocument({ ...row, body: body + 'changed' }, { section: result.outline[1].id }), /No matching/);
});
