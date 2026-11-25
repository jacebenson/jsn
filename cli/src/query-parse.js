// Encoded-query tokenizer. This module classifies; it never rewrites,
// re-encodes, substitutes or drops any part of the caller's string.
//
// The parser understands the surface jsn users type, not the whole platform:
// ^-separated clauses, ^OR / ^NQ / ^EQ connectors, ORDERBY / ORDERBYDESC,
// symbolic and canonical word operators, and dot-walk paths. Anything dynamic
// (`javascript:`, `js:`) or otherwise outside that surface is reported as
// unsupported, never invalid — the platform may accept it.

const SYMBOLIC = ['>=', '<=', '!=', '=', '>', '<'];
const WORD = ['ISNOTEMPTY', 'INSTANCEOF', 'STARTSWITH', 'ENDSWITH', 'NOTLIKE',
  'NOT LIKE', 'NOT IN', 'BETWEEN', 'NSAMEAS', 'SAMEAS', 'ISEMPTY', 'NOTIN', 'LIKE', 'IN'];
const CANONICAL = new Set([...SYMBOLIC, ...WORD]);
const NO_VALUE = new Set(['ISEMPTY', 'ISNOTEMPTY']);
const CONNECTOR = /^(OR(?!DERBY)|NQ|EQ|AND)/;

const raw = value => String(value && typeof value === 'object' ? value.value ?? '' : value ?? '');

export function levenshtein(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return rows[a.length][b.length];
}

/** Close canonical operators for an unrecognised term (labels only). */
export function operatorSuggestions(token) {
  const upper = String(token || '').toUpperCase();
  if (!upper) return [];
  return [...CANONICAL]
    .map(op => ({ op, distance: levenshtein(upper, op) }))
    .filter(item => item.distance <= Math.max(2, Math.floor(upper.length / 3)))
    .sort((a, b) => a.distance - b.distance)  // closest first, labels only
    .slice(0, 3)
    .map(item => item.op);
}

// Scan every suffix window so `nameSTARTWITHfoo` still suggests STARTSWITH
// without guessing where the field ends.
function closestOperators(clause) {
  const upper = clause.toUpperCase();
  const found = new Map();
  for (const op of CANONICAL) {
    for (let start = 1; start + op.length <= upper.length + 2; start++) {
      const window = upper.slice(start, start + op.length);
      const distance = levenshtein(window, op);
      if (distance > 2 || distance >= op.length) continue;
      const previous = found.get(op);
      if (previous === undefined || distance < previous) found.set(op, distance);
    }
  }
  return [...found].sort((a, b) => a[1] - b[1] || b[0].length - a[0].length).slice(0, 3).map(([op]) => op);
}

function splitClauses(query) {
  const clauses = [];
  let current = '';
  let escaped = false;
  for (let i = 0; i < query.length; i++) {
    const char = query[i];
    if (char === '^') {
      if (query[i + 1] === '^') { current += '^^'; i++; continue; }
      clauses.push(current); current = ''; continue;
    }
    if (escaped) { current += char; escaped = false; continue; }
    current += char;
  }
  clauses.push(current);
  return clauses;
}

function findOperator(clause) {
  let symbol = -1;
  for (let i = 0; i < clause.length && symbol < 0; i++) {
    for (const op of SYMBOLIC) {
      if (clause.startsWith(op, i)) { symbol = i; break; }
    }
  }
  let word = -1;
  let wordOp = '';
  for (const op of WORD) {
    for (let i = 1; i + op.length <= clause.length; i++) {
      const token = clause.slice(i, i + op.length);
      if (token !== op) continue; // canonical uppercase only: `caller_in` stays a field
      const next = clause[i + op.length];
      if (next && /[=!<>]/.test(next)) continue; // `caller_in=x` is a field, not IN
      if (word < 0 || i < word || (i === word && op.length > wordOp.length)) { word = i; wordOp = op; }
      break;
    }
  }
  const at = symbol >= 0 && (word < 0 || symbol < word) ? symbol : word;
  if (at < 0) return null;
  if (at === symbol) {
    const op = SYMBOLIC.find(candidate => clause.startsWith(candidate, at));
    return { field: clause.slice(0, at), operator: op, value: clause.slice(at + op.length).replaceAll('^^', '^'), index: at };
  }
  return { field: clause.slice(0, word), operator: wordOp, value: clause.slice(word + wordOp.length).replaceAll('^^', '^'), index: word };
}

/**
 * Parse an encoded query.
 * @returns {{original: string, terms: object[], diagnostics: object[],
 *   unsupported: boolean, invalid: boolean}}
 */
export function parseEncodedQuery(query) {
  const original = typeof query === 'string' ? query : '';
  const terms = [];
  const diagnostics = [];
  if (!original.trim()) return { original, terms, diagnostics, unsupported: false, invalid: false };

  for (const rawClause of splitClauses(original)) {
    if (rawClause === '') continue;
    let clause = rawClause;
    let connector = '';

    // Directives are checked before connector stripping: ORDERBY starts with OR.
    if (/^ORDERBYDESC/i.test(clause) || /^ORDERBY/i.test(clause)) {
      const match = clause.match(/^ORDERBY(?:DESC)?([a-z0-9_]+(?:\.[a-z0-9_]+)*)$/i);
      if (match) {
        terms.push({ kind: 'directive', raw: rawClause, connector, directive: /^ORDERBYDESC/i.test(clause) ? 'ORDERBYDESC' : 'ORDERBY', field: match[1] });
        continue;
      }
      diagnostics.push({ code: 'malformed_directive', severity: 'error', term: rawClause,
        message: `"${rawClause}" is not a valid ORDERBY directive.`,
        hint: 'Use ORDERBYfield or ORDERBYDESCfield.' });
      continue;
    }

    const connected = clause.match(CONNECTOR);
    if (connected) { connector = connected[1]; clause = clause.slice(connected[0].length); }
    if (clause.trim() === '') {
      if (connector !== 'EQ') {
        terms.push({ kind: 'invalid', raw: rawClause, connector });
        diagnostics.push({ code: 'empty_branch', severity: 'error', term: rawClause,
          message: `${connector} requires a complete query term.`, hint: 'Supply a condition after every OR, NQ or AND branch. See jsn records list --help.' });
      }
      continue;
    }

    if (/^(?:javascript|js):/i.test(clause) || /(?:javascript|js):/i.test(clause)
      || /^(?:RLQUERY|ENDRLQUERY|GROUPBY|HAVING)/.test(clause)
      || /(?:NOTON|ON|RELATIVE[A-Z]*|DYNAMIC)/.test(clause.split(/[=!<>]/, 1)[0])) {
      terms.push({ kind: 'unsupported', raw: rawClause, connector, reason: 'dynamic_script' });
      diagnostics.push({ code: 'unsupported_dynamic_query', severity: 'warning', term: rawClause,
        message: 'This term uses platform dynamic/script syntax, which jsn does not evaluate.',
        hint: 'The query is left byte-identical; validation is unverified for this term.' });
      continue;
    }

    const found = findOperator(clause);
    if (!found) {
      const suggestions = closestOperators(clause);
      terms.push({ kind: 'ambiguous', raw: rawClause, clause, connector, code: 'missing_operator', field: clause });
      diagnostics.push({ code: 'missing_operator', severity: 'warning', term: rawClause,
        message: `"${rawClause}" has no recognised operator.`,
        ...(suggestions.length ? { suggestions } : {}),
        hint: suggestions.length ? `Did you mean a canonical operator such as ${suggestions.join(', ')}?` : 'Use fieldOPERATORvalue, for example active=true.' });
      continue;
    }

    const field = found.field.trim();
    if (!field) {
      terms.push({ kind: 'invalid', raw: rawClause, connector, code: 'empty_field', operator: found.operator });
      diagnostics.push({ code: 'empty_field', severity: 'error', term: rawClause,
        message: `"${rawClause}" has an operator but no field name.` });
      continue;
    }
    if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(field)) {
      terms.push({ kind: 'invalid', raw: rawClause, connector, code: 'invalid_field_syntax', field, operator: found.operator });
      diagnostics.push({ code: 'invalid_field_syntax', severity: 'error', term: rawClause,
        message: `"${field}" is not a valid field path.`,
        hint: 'Field paths contain letters, numbers, underscores and dots (for reference walks).' });
      continue;
    }
    if (!NO_VALUE.has(found.operator) && found.value === '') {
      diagnostics.push({ code: 'empty_value', severity: 'warning', term: rawClause, field,
        message: `"${rawClause}" supplies an empty value for ${found.operator}.`,
        hint: 'The query is unchanged; confirm this is intentional.' });
    }
    terms.push({
      kind: 'clause', raw: rawClause, clause, connector, field, operator: found.operator, value: found.value,
      path: field.split('.'), inherited: false,
    });
  }

  if (!terms.length) diagnostics.push({ code: 'empty_filter', severity: 'error', term: original,
    message: 'A nonempty encoded query must contain a condition or directive, not only separators or connectors.',
    hint: 'Supply a complete filter. See jsn records list --help.' });

  const invalid = terms.some(term => term.kind === 'invalid') || diagnostics.some(d => d.severity === 'error');
  const unsupported = terms.some(term => term.kind === 'unsupported' || term.kind === 'ambiguous');
  return { original, terms, diagnostics, unsupported, invalid };
}

export const CANONICAL_OPERATORS = Object.freeze([...CANONICAL]);
export { raw as rawFieldValue };
