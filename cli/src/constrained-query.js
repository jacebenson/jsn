import { errUsageHint } from './errors.js';

/** Constrained table views accept literal AND filters. Encoded queries have no
 * portable parenthesization; OR/NQ/dynamic clauses must not escape fixed filters. */
export function constrainQuery(query = '', constraint = '') {
  if (!constraint) return query;
  const clauses = String(query).split('^').filter((clause, index, values) => clause !== 'EQ' || index !== values.length - 1);
  if (!query) return constraint;
  const literal = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*(?:(?:!=|>=|<=|=|>|<|NOT LIKE|STARTSWITH|ENDSWITH|LIKE|NOT IN|IN)[^^]*|ISEMPTY|ISNOTEMPTY)$/;
  const ordering = /^ORDERBY(?:DESC)?[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*$/;
  const allowed = clause => ordering.test(clause) || (literal.test(clause)
    && (!/^(?:NQ|OR)/i.test(clause) || /^order(?:!=|>=|<=|=|>|<|NOT LIKE|STARTSWITH|ENDSWITH|LIKE|NOT IN|IN|ISEMPTY|ISNOTEMPTY)/.test(clause)));
  if (/javascript\s*:/i.test(query) || clauses.some(clause => !allowed(clause))) {
    throw errUsageHint('This constrained command accepts literal AND filters and ORDERBY only; OR, NQ and dynamic query clauses are unsupported.',
      `The fixed filter is ${constraint}. Use literal AND clauses, or explicitly use records list for advanced queries and retain the intended constraints in every branch.`);
  }
  return clauses.length ? `${constraint}^${clauses.join('^')}` : constraint;
}

export const constrainedQueryHelp = constraint => `Always includes: ${constraint}. Additional --query filters use literal AND clauses (plus ORDERBY). OR, NQ and dynamic query clauses are rejected before requests so they cannot bypass this view's fixed filter.`;
