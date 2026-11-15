import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDocument } from '../src/commands/docs/sections.js';

test('outline and exact subtree preserve source and inherited safety context', () => {
  const body = '# API\n\nWarning: global only.\n\n## method(a)\nIntro\n\n### Example\n~~~js\n# fake\n~~~\n<table><tr><td>value</td></tr></table>\n\n## Other\nOther body\n';
  const row = { path: 'api.md', release: 'australia', revision: 'abc', body };
  const outline = selectDocument(row, { outline: true });
  assert.deepEqual(outline.outline.map(s => s.title), ['API', 'method(a)', 'Example', 'Other']);
  const selected = selectDocument(row, { section: outline.outline[1].id });
  assert.equal(selected.body, body.slice(0, body.indexOf('## Other')));
  assert.equal(selected.retrieval.subtree_complete, true);
  assert.equal(selected.retrieval.document_complete, false);
  assert.equal(selected.retrieval.semantic_completeness, 'unknown');
  assert.deepEqual(selected.retrieval.context_sections.map(h => h.title), ['Other']);
  assert.equal(selectDocument(row, { section: 'API' }).body, body);
  assert.equal(selectDocument(row, { section: 'API' }).retrieval.document_complete, true);
  assert.throws(() => selectDocument({ ...row, revision: 'changed' }, { section: outline.outline[1].id }), /revision|match/i);
});
