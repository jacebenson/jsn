// FTS5 query sanitizing for the docs index.
//
// ServiceNow documentation is full of dotted, hyphenated and slash-separated
// identifiers (`com.snc.itsm.roles`, `glide.ui.escape_all_script`,
// `change-management`). FTS5 reads a bare `.`, `:`, `-`, `/` or `+` as query
// syntax and throws `fts5: syntax error`, so every token is rendered as a
// quoted phrase unless it is plain word characters. Uppercase AND/OR/NOT and a
// trailing `*` prefix keep working as operators.

const FTS_COLUMNS = new Set(['title', 'body']);
const BOOLEAN_OPERATORS = new Set(['AND', 'OR', 'NOT']);
const WORD = /^[\p{L}\p{N}_]+$/u;

function quotePhrase(text) {
  return `"${text.replace(/"/g, '""')}"`;
}

function renderValue(value, prefix) {
  const rendered = WORD.test(value) ? value : quotePhrase(value);
  return prefix ? `${rendered}*` : rendered;
}

function renderTerm(text) {
  let prefix = false;
  let core = text;
  while (core.endsWith('*')) {
    prefix = true;
    core = core.slice(0, -1);
  }
  if (!core) return null;

  const separator = core.indexOf(':');
  if (separator > 0) {
    const column = core.slice(0, separator);
    const rest = core.slice(separator + 1);
    if (FTS_COLUMNS.has(column) && rest) {
      return `${column}: ${renderValue(rest, prefix)}`;
    }
  }
  return renderValue(core, prefix);
}

function splitTokens(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < input.length) {
        if (input[j] === '"') {
          if (input[j + 1] === '"') {
            text += '"';
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        text += input[j];
        j += 1;
      }
      let prefix = false;
      if (input[j] === '*') {
        prefix = true;
        j += 1;
      }
      tokens.push({ kind: 'phrase', text, prefix });
      i = j;
      continue;
    }
    let j = i;
    while (j < input.length && !/\s/.test(input[j])) j += 1;
    tokens.push({ kind: 'term', text: input.slice(i, j) });
    i = j;
  }
  return tokens;
}

/**
 * Turn a free-text search query into an FTS5 MATCH expression that cannot throw
 * a syntax error on punctuation. Returns '' when nothing searchable is left.
 */
export function sanitizeFts5Query(query) {
  const raw = query == null ? '' : String(query);
  const out = [];

  for (const token of splitTokens(raw)) {
    if (token.kind === 'phrase') {
      out.push({ text: quotePhrase(token.text) + (token.prefix ? '*' : '') });
      continue;
    }
    if (BOOLEAN_OPERATORS.has(token.text)) {
      // Operators only mean something between two operands.
      if (out.length === 0) continue;
      if (out[out.length - 1].operator) {
        // FTS5 only accepts NOT as an infix operator, so "a AND NOT b" becomes "a NOT b".
        if (token.text === 'NOT' && out[out.length - 1].text !== 'NOT') {
          out[out.length - 1] = { text: 'NOT', operator: true };
        }
        continue;
      }
      out.push({ text: token.text, operator: true });
      continue;
    }
    const rendered = renderTerm(token.text);
    if (rendered) out.push({ text: rendered });
  }

  while (out.length > 0 && out[out.length - 1].operator) out.pop();
  return out.map((token) => token.text).join(' ');
}
