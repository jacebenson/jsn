import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../app/assets/javascripts/markdown.js', import.meta.url), 'utf8'), context);
vm.runInContext(fs.readFileSync(new URL('../../cli/src/commands/docs/public/vendor/marked.min.js', import.meta.url), 'utf8'), context);
const normalize = context.JSNMarkdown.normalize;
const render = source => context.marked.parse(normalize(source));
test('renders upstream HTML tables joined directly to Markdown tables', () => {
  const source = '<table>\n<tr><td>parameter</td></tr>\n</table>|Type|Description|\n|----|-----------|\n|void| |';
  const html = render(source);
  assert.equal((html.match(/<table>/g) || []).length, 2);
  assert.match(html, /<th>Type<\/th>/);
  assert.match(html, /<td>void<\/td>/);
  assert.doesNotMatch(html, /\|Type\|Description\|/);
});
test('renders a Markdown table after an HTML block without a blank line', () => {
  const html = render('<div>note</div>\n|Name|Type|\n|---|---|\n|record|String|');
  assert.match(html, /<table>/);
  assert.match(html, /<td>record<\/td>/);
});
test('does not repair literal examples in backtick, tilde, longer, or indented code', () => {
  for (const fence of ['```', '~~~', '````']) {
    const source = `${fence}html\n</table>|Type|Description|\n|----|-----------|\n${fence}`;
    assert.equal(normalize(source), source);
    assert.match(render(source), /&lt;\/table&gt;\|Type\|Description\|/);
    assert.doesNotMatch(render(source), /<table>/);
  }
  const indented = '    </table>|Type|Description|\n    |----|-----------|';
  assert.equal(normalize(indented), indented);
});
test('normal source is unchanged and repeated normalization is stable', () => {
  const source = '# A heading\n\nA **bold** word and `code`.\n\n|Name|Type|\n|---|---|\n|record|String|';
  assert.equal(normalize(source), source);
  const broken = '</table>|Type|Description|\n|---|---|\n|void| |';
  assert.equal(normalize(normalize(broken)), normalize(broken));
});
