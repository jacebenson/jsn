import { buildDevCmd } from './_generic.js';

// Before-query business rules — applies filters to GlideRecord queries before they execute.
// These are sys_script records with order < 100.
export const b4rulesCmd = (wrap) => buildDevCmd('b4rules', 'sys_script', ['b4rule'], ['name', 'collection', 'active', 'order', 'sys_scope'], wrap, { singular: 'before-query business rule', scopeValidation: true, extraQuery: 'when=before', devAlias: false });
