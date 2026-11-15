// CommonMark source positions let us slice original text, never reserialize tables/code.
import * as commonmark from 'commonmark';
import { createHash } from 'node:crypto';
import { AppError } from '../../errors.js';

export const SECTION_PROTOCOL = 'sections-v1';
function failure(message) { return new AppError('usage_error', message, 'Use --outline for exact titles and revision-bound IDs.', 400); }
export function selectDocument(row, { outline = false, section } = {}) {
  if (outline && section !== undefined) throw failure('Use either --outline or --section, not both.');
  if (section !== undefined && !String(section).trim()) throw failure('Section must not be empty.');
  if (!outline && section === undefined) return row;
  const body = row.body;
  const starts = [0];
  for (const match of body.matchAll(/\r\n|\n|\r/g)) starts.push(match.index + match[0].length);
  const ast = new commonmark.Parser().parse(body);
  const headings = [];
  for (let node = ast.firstChild; node; node = node.next) {
    if (node.type !== 'heading') continue; // Never split lists, blockquotes or HTML blocks.
    let title = '', walker = node.walker(), event;
    while ((event = walker.next())) {
      if (event.entering && ['text', 'code'].includes(event.node.type)) title += event.node.literal;
      if (event.entering && ['softbreak', 'linebreak'].includes(event.node.type)) title += ' ';
    }
    headings.push({ title, depth: node.level, start_line: node.sourcepos[0][0], start: starts[node.sourcepos[0][0] - 1] });
  }
  const identity = createHash('sha256').update(JSON.stringify([SECTION_PROTOCOL, row.path, row.release, row.revision, body])).digest('hex').slice(0, 24);
  const stack = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    while (stack.length && headings[stack.at(-1)].depth >= h.depth) stack.pop();
    h.ancestors = stack.map(n => headings[n].id);
    h.id = `s1:${identity}:${i + 1}`;
    const next = headings.slice(i + 1).find(n => n.depth <= h.depth);
    h.end = next?.start ?? body.length;
    h.end_line = next ? next.start_line - 1 : starts.length;
    h.introEnd = headings[i + 1]?.start ?? body.length;
    stack.push(i);
  }
  const publicHeading = ({ start: _start, end: _end, introEnd: _introEnd, ...h }) => h; // Offsets remain an implementation detail.
  const metadata = { protocol: SECTION_PROTOCOL, document_complete: false, semantic_completeness: 'unknown', truncated: false,
    heading_policy: 'CommonMark top-level ATX/setext; container and HTML headings are not boundaries' };
  const { body: _body, ...identityRow } = row;
  if (outline) return { ...identityRow, outline: headings.map(publicHeading), retrieval: { ...metadata, mode: 'outline', total_lines: starts.length, context_policy: 'Selection includes preamble and ancestor introductions; other sections may contain relevant context.' } };
  const matches = headings.filter(h => h.id === section || h.title === section);
  if (!matches.length) throw failure('No matching section. IDs are document- and revision-bound; refresh the outline.');
  if (matches.length !== 1) throw failure(`Ambiguous section ${JSON.stringify(section)}. Choose an ID: ${matches.map(h => `${h.id} (${h.title}, line ${h.start_line})`).join('; ')}`);
  const h = matches[0];
  const spans = [];
  const add = (start, end, kind) => { if (end > start) spans.push({ start, end, kind }); };
  add(0, headings[0]?.start ?? body.length, 'preamble');
  for (const id of h.ancestors) { const a = headings.find(n => n.id === id); add(a.start, a.introEnd, 'ancestor-introduction'); }
  add(h.start, h.end, 'section-subtree');
  return { ...identityRow, body: spans.map(s => body.slice(s.start, s.end)).join(''), section: publicHeading(h), retrieval: {
    ...metadata, mode: 'section', subtree_complete: true, document_complete: spans.reduce((n, s) => n + s.end - s.start, 0) === body.length,
    context_policy: 'Preamble and ancestor introductions included. Sibling sections and linked prerequisites are not automatically included; read the full document when needed.',
    context_sections: headings.filter(n => !spans.some(s => n.start >= s.start && n.start < s.end)).map(n => ({ id: n.id, title: n.title })),
    included_spans: spans.map(s => ({ start_offset: s.start, end_offset: s.end, kind: s.kind })),
  } };
}
