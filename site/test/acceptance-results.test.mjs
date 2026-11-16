import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../static/assets/acceptance-results.js', import.meta.url), 'utf8');
function fixture(readyState = 'complete') {
  const rows = [
    ['Zulu', 'passed', '10000'], ['Alpha', 'failed', '0'],
    ['Beta', 'blocked-access', '2000'], ['Beta', 'failed', '2000'],
    ['Gamma', 'not-run', '100'], ['Delta', 'excluded-mode', '900']
  ].map(([checkName, status, duration], id) => ({ id, dataset: { checkName, status, duration }, details: { open: id === 2 }, badge: {}, link: {} }));
  const original = [...rows];
  const body = { rows, appendChild(row) { rows.splice(rows.indexOf(row), 1); rows.push(row); } };
  const headers = ['checkName', 'status', 'duration'].map((key) => {
    const indicator = { textContent: ' ↕' };
    const header = { direction: 'none', getAttribute() { return this.direction; }, setAttribute(_, value) { this.direction = value; }, querySelector() { return indicator; } };
    header.button = { dataset: { sortKey: key }, listeners: [], closest() { return header; }, addEventListener(_, listener) { this.listeners.push(listener); }, click() { this.listeners.forEach((fn) => fn()); } };
    return header;
  });
  const table = { dataset: {}, tBodies: [body], querySelectorAll(selector) { return selector === 'th' ? headers : headers.map((h) => h.button); } };
  const document = { readyState, querySelectorAll() { return [table]; }, addEventListener(_, fn) { this.ready = fn; } };
  const context = vm.createContext({ document });
  vm.runInContext(source, context);
  return { rows, original, headers, document, context };
}

test('all columns toggle both directions; numeric milliseconds include zero and stable ties', () => {
  const f = fixture();
  const expectations = [
    [[1, 2, 3, 5, 4, 0], [0, 4, 5, 2, 3, 1]],
    [[2, 5, 1, 3, 4, 0], [0, 4, 1, 3, 5, 2]],
    [[1, 4, 5, 2, 3, 0], [0, 2, 3, 5, 4, 1]]
  ];
  f.headers.forEach((header, index) => {
    expectations[index].forEach((expected, toggle) => {
      header.button.click();
      assert.deepEqual(f.rows.map((row) => row.id), expected);
      assert.equal(header.direction, toggle ? 'descending' : 'ascending');
      assert.equal(header.querySelector().textContent, toggle ? ' ↓' : ' ↑');
      assert.ok(f.headers.filter((h) => h !== header).every((h) => h.direction === 'none' && h.querySelector().textContent === ' ↕'));
      for (const row of f.rows) assert.equal(row, f.original[row.id]);
      assert.equal(f.original[2].details.open, true);
    });
  });
});

test('deferred initialization and repeated script execution do not duplicate handlers', () => {
  const f = fixture('loading');
  assert.equal(f.headers[0].button.listeners.length, 0);
  f.document.ready();
  f.document.readyState = 'complete';
  vm.runInContext(source, f.context);
  assert.equal(f.headers[0].button.listeners.length, 1);
  f.headers[0].button.click();
  assert.equal(f.headers[0].direction, 'ascending');
});
