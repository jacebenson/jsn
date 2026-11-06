// Narrow table adapters; mappings verified against demo sys_dictionary.
// See docs/batch-families-verification.md. No implicit related-record writes.
export const string = (requiredOnCreate = false) => ({ type: 'string', requiredOnCreate });
export const boolean = { type: 'boolean' };
export const integer = { type: 'integer' };
export const parent = (type) => ({ type: 'string', ref: [type], parent: true, requiredOnCreate: true });

export function tableAdapter({ type, table, fields, targetField = null, targetScopeFields = [] }) {
  return {
    type, table, label: type, fields, outputs: ['sys_id'],
    targetField, targetMatchFields: targetField ? [targetField, 'sys_id'] : ['sys_id'], targetScopeFields,
    async prepare({ operation, fields: values }) {
      return { payload: operation === 'delete' ? {} : { ...values }, notes: [] };
    },
    async create({ sdk, payload }) { return sdk.create(table, payload); },
    async update({ sdk, sysId, payload }) { return sdk.update(table, sysId, payload); },
    async delete({ sdk, sysId }) { return sdk.delete(table, sysId); },
  };
}
