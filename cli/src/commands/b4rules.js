import { buildDevCmd } from './_generic.js';

// Query rules are explicitly marked; their order is not a classification rule.
export const b4rulesCmd = wrap => buildDevCmd('b4rules', 'sys_script', ['b4rule'],
  ['name', 'collection', 'active', 'order', 'sys_scope'], wrap, {
    singular: 'before-query business rule', scopeValidation: true,
    extraQuery: 'when=before^action_query=true',
    describe: 'Inspect before-query business rules that can filter record reads',
    help: 'Before-query business rules use when=before and the Boolean action_query=true. Filter collection and active status for the affected table. For field behavior, see jsn columns --help; do not bypass server rules or ACLs.',
  });
