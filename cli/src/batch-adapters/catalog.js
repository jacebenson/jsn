// Catalog domain adapters for the batch manifest engine.
//
// This is the first vertical slice of the shared orchestration capability:
// catalog items and their catalog variables. Each adapter owns the domain
// payload shape and the create/update call; the engine owns ordering,
// references, per-step status and safety checks.
//
// Catalog UI policies/actions and client scripts live in families.js.
// Catalogs/categories as created artifacts and variable sets remain unsupported.
// `category` resolves an
// existing sc_category by exact title and never creates one implicitly —
// unlike `catalogitems create`, a manifest must not allocate extra records
// the manifest did not name.

import { assertSafeExactMatch, getStringField, ITEM_OPTION_TYPE_NAMES } from '../helpers.js';
import { AppError, CodeAmbiguous, CodeNotFound, errUsage } from '../errors.js';

const CATALOG_FIELDS = {
  name: { type: 'string', requiredOnCreate: true, description: 'Item name (sc_cat_item.name)' },
  short_description: { type: 'string', description: 'Short description' },
  active: { type: 'boolean', description: 'Active flag (defaults to true on create)' },
  category: { type: 'string', description: 'Existing sc_category title; resolved exactly, never created' },
  category_sys_id: { type: 'string', description: 'Existing sc_category sys_id' },
};

const VARIABLE_FIELDS = {
  cat_item: { type: 'string', requiredOnCreate: true, parent: true, ref: ['catalog_item'], description: 'Parent catalog item sys_id (usually a $ref to a catalog_item step)' },
  name: { type: 'string', createOnly: true, description: 'Variable system name; derived from label when omitted' },
  label: { type: 'string', requiredOnCreate: true, description: 'Question text shown to the requester' },
  type: { type: 'string', description: 'item_option_new type alias or numeric value (default: string)' },
  mandatory: { type: 'boolean', description: 'Required flag (defaults to false)' },
  order: { type: 'integer', description: 'Display order (defaults to 100)' },
  active: { type: 'boolean', description: 'Active flag (defaults to true on create)' },
};

function resolveStrictItemOptionType(value) {
  if (value === undefined) return 6;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 100) return value;
  const raw = String(value);
  const key = raw.toLowerCase().replace(/[\s_-]/g, '');
  if (ITEM_OPTION_TYPE_NAMES[key] != null) return ITEM_OPTION_TYPE_NAMES[key];
  if (/^\d+$/.test(raw.trim())) {
    const numeric = Number(raw.trim());
    if (Number.isInteger(numeric) && numeric > 0 && numeric < 100) return numeric;
  }
  throw errUsage(`Unsupported catalog variable type "${value}".`);
}

function variableTypeProblem(value) {
  if (value === undefined) return null;
  try {
    resolveStrictItemOptionType(value);
    return null;
  } catch (error) {
    return `${error.message} Use a documented item_option_new type alias (string, multiline, select, choice, checkbox, reference, date, datetime, email, ...) or its numeric value.`;
  }
}

async function resolveCategoryTitle(sdk, title) {
  assertSafeExactMatch(title);
  const params = new URLSearchParams();
  params.set('sysparm_query', `title=${title}`);
  params.set('sysparm_limit', '2');
  params.set('sysparm_fields', 'sys_id,title');
  const rows = await sdk.list('sc_category', params);
  if (rows.length === 0) {
    const error = new AppError(CodeNotFound, `Catalog category not found: ${title}`,
      'Create the category separately (jsn records create --table sc_category --data ...) or supply category_sys_id.');
    error.resolution = { table: 'sc_category', field: 'title', mode: 'exact', matches: 0 };
    throw error;
  }
  if (rows.length > 1) {
    const error = new AppError(CodeAmbiguous, `Multiple catalog categories match title: ${title}`,
      'Categorise by category_sys_id instead of the ambiguous title.');
    error.resolution = { table: 'sc_category', field: 'title', mode: 'exact', matches: 2, at_least: true };
    throw error;
  }
  const id = getStringField(rows[0], 'sys_id');
  if (!id) throw errUsage(`Category "${title}" has no readable sys_id; check field ACLs.`);
  return id;
}

function checkExclusiveCategory(fields) {
  if (fields.category !== undefined && fields.category_sys_id !== undefined) {
    return 'Use either category (title) or category_sys_id, not both.';
  }
  return null;
}

export const catalogItemBatchAdapter = {
  type: 'catalog_item',
  label: 'Catalog item',
  table: 'sc_cat_item',
  outputs: ['sys_id'],
  targetField: 'name',
  targetMatchFields: ['name', 'sys_id'],
  targetScopeFields: ['active', 'category'],
  fields: CATALOG_FIELDS,
  validate: ({ fields }) => checkExclusiveCategory(fields),
  async prepare({ sdk, operation, fields }) {
    if (operation === 'delete') return { payload: {}, notes: [] };
    const payload = {};
    const notes = [];
    if (fields.name !== undefined) payload.name = fields.name;
    if (fields.short_description !== undefined) payload.short_description = fields.short_description;
    if (fields.active !== undefined) payload.active = fields.active;
    if (operation === 'create') {
      if (payload.short_description === undefined) payload.short_description = '';
      if (payload.active === undefined) payload.active = true;
      payload.type = 'item';
    }
    if (fields.category_sys_id !== undefined) {
      payload.category = fields.category_sys_id;
    } else if (fields.category !== undefined) {
      payload.category = await resolveCategoryTitle(sdk, fields.category);
      notes.push(`category "${fields.category}" resolved to ${payload.category}`);
    }
    return { payload, notes };
  },
  async create({ sdk, payload }) {
    return sdk.create('sc_cat_item', payload);
  },
  async delete({ sdk, sysId }) { return sdk.delete(this.table, sysId); },
  async update({ sdk, sysId, payload }) {
    return sdk.update('sc_cat_item', sysId, payload);
  },
};

export const catalogVariableBatchAdapter = {
  type: 'catalog_variable',
  label: 'Catalog variable',
  table: 'item_option_new',
  outputs: ['sys_id', 'catalog_variable'],
  produceOutputs: ({ sysId }) => ({ sys_id: sysId, catalog_variable: `IO:${sysId}` }),
  targetField: 'name',
  targetMatchFields: ['name', 'sys_id'],
  targetScopeFields: ['cat_item'],
  fields: VARIABLE_FIELDS,
  validate: ({ operation, fields }) => {
    if (operation === 'create' && fields.name !== undefined && !/^[A-Za-z][A-Za-z0-9_]*$/.test(fields.name)) {
      return 'Variable name must start with a letter and contain only letters, digits and underscores.';
    }
    if (operation === 'create' && fields.label !== undefined && fields.name === undefined
      && !/[A-Za-z0-9]/.test(String(fields.label))) {
      return 'label must contain at least one letter or digit so a variable name can be derived.';
    }
    if (fields.order !== undefined && fields.order < 0) return 'order must be zero or greater.';
    return variableTypeProblem(fields.type);
  },
  async prepare({ operation, fields }) {
    if (operation === 'delete') return { payload: {}, notes: [] };
    const payload = {};
    const notes = [];
    if (operation === 'create') {
      const label = fields.label;
      const name = fields.name || label.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
      if (fields.name === undefined) notes.push(`variable name derived as "${name}" from the label`);
      payload.name = name;
      payload.question_text = label;
      payload.type = resolveStrictItemOptionType(fields.type);
      payload.cat_item = fields.cat_item;
      payload.mandatory = fields.mandatory ?? false;
      payload.order = fields.order ?? 100;
      payload.active = fields.active ?? true;
      return { payload, notes };
    }
    if (fields.cat_item !== undefined) payload.cat_item = fields.cat_item;
    if (fields.label !== undefined) payload.question_text = fields.label;
    if (fields.type !== undefined) payload.type = resolveStrictItemOptionType(fields.type);
    if (fields.mandatory !== undefined) payload.mandatory = fields.mandatory;
    if (fields.order !== undefined) payload.order = fields.order;
    if (fields.active !== undefined) payload.active = fields.active;
    return { payload, notes };
  },
  async create({ sdk, payload }) {
    return sdk.create('item_option_new', payload);
  },
  async delete({ sdk, sysId }) { return sdk.delete(this.table, sysId); },
  async update({ sdk, sysId, payload }) {
    return sdk.update('item_option_new', sysId, payload);
  },
};

export const catalogBatchAdapters = [catalogItemBatchAdapter, catalogVariableBatchAdapter];
