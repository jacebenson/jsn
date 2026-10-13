import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const dv = (value, display = value) => ({ value, display_value: display });
const raw = value => ({ value, display_value: value });

function sdkWith(tables) {
  const calls = [];
  return {
    calls,
    async list(table, params) {
      calls.push({ table, params: decodeURIComponent(String(params)) });
      if (!(table in tables)) throw new Error(`unexpected list ${table}`);
      const rows = tables[table];
      return typeof rows === 'function' ? rows(params) : rows;
    },
  };
}

describe('trigger catalog', () => {
  const definition = (sysId, name, type, category, active = 'true') => ({
    sys_id: raw(sysId), name: raw(name), type: raw(type), active: raw(active),
    category: category ? dv(category.id, category.label) : raw(''), description: raw(''),
  });

  it('groups the instance\'s own definitions by their category reference', async () => {
    const { readTriggerCatalog } = await import('../src/flow-triggers.js');
    const record = { id: '8886dd64c3d322002841b63b12d3aed4', label: 'Record' };
    const scheduled = { id: 'ec965da4c3d322002841b63b12d3ae01', label: 'Scheduled' };
    const sdk = sdkWith({
      sys_hub_trigger_definition: [
        definition('a'.repeat(32), 'Created', 'record_create', record),
        definition('b'.repeat(32), 'Created or Updated', 'record_create_or_update', record),
        definition('c'.repeat(32), 'Daily', 'daily', scheduled),
        definition('d'.repeat(32), 'Trigger Rest', 'rest', null),
      ],
      sys_hub_trigger_category: [
        { sys_id: raw(record.id), name: raw('Record') },
        { sys_id: raw(scheduled.id), name: raw('Scheduled') },
      ],
    });
    const catalog = await readTriggerCatalog(sdk);

    assert.deepEqual(catalog.categories.map(category => category.name), ['Record', 'Scheduled']);
    assert.deepEqual(catalog.categories[0].triggers.map(trigger => trigger.type), ['record_create', 'record_create_or_update']);
    assert.deepEqual(catalog.categories[1].triggers.map(trigger => trigger.type), ['daily']);
    // A definition whose category does not resolve is never selectable.
    assert.deepEqual(catalog.ungrouped.map(trigger => trigger.type), ['rest']);
    assert.equal(catalog.ungrouped[0].supported, false);
    // Only definitions the instance marks active are read at all.
    assert.match(sdk.calls[0].params, /sysparm_query=active=true/);
    assert.equal(sdk.calls[0].table, 'sys_hub_trigger_definition');
    assert.equal(sdk.calls[1].table, 'sys_hub_trigger_category');
  });

  it('keeps families the CLI cannot create out of the pickable list but reports them', async () => {
    const { readTriggerCatalog, selectableTriggers, SUPPORTED_TRIGGER_TYPES, EXCLUDED_TRIGGER_TYPES } = await import('../src/flow-triggers.js');
    const application = { id: '727a5011c36813002841b63b12d3ae10', label: 'Application' };
    const sdk = sdkWith({
      sys_hub_trigger_definition: [
        { sys_id: raw('a'.repeat(32)), name: raw('Inbound Email'), type: raw('email'), active: raw('true'), category: dv(application.id, application.label), description: raw('') },
        { sys_id: raw('b'.repeat(32)), name: raw('Proactive Analytics'), type: raw('analytics'), active: raw('true'), category: dv(application.id, application.label), description: raw('') },
        { sys_id: raw('c'.repeat(32)), name: raw('Trigger Rest'), type: raw('rest'), active: raw('true'), category: dv(application.id, application.label), description: raw('') },
      ],
      sys_hub_trigger_category: [{ sys_id: raw(application.id), name: raw('Application') }],
    });
    const catalog = await readTriggerCatalog(sdk);
    const names = selectableTriggers(catalog.categories[0]).map(trigger => trigger.type);
    assert.deepEqual(names, ['email']);
    const excluded = catalog.categories[0].triggers.filter(trigger => !trigger.supported);
    assert.deepEqual(excluded.map(trigger => trigger.type), ['analytics', 'rest']);
    assert.match(excluded.find(trigger => trigger.type === 'rest').excludedReason, /no resolvable trigger category/i);
    // The supported set is the families verified live; the excluded set names why.
    assert.equal(SUPPORTED_TRIGGER_TYPES.has('analytics'), false);
    assert.equal(SUPPORTED_TRIGGER_TYPES.has('rest'), false);
    assert.match(EXCLUDED_TRIGGER_TYPES.get('analytics'), /inactive/i);
  });
});

describe('declared trigger inputs', () => {
  const definitionId = 'a45d9180c32222002841b63b12d3aea7';

  it('reads the definition\'s inputs through the var__m_sys_hub_trigger_input_<id> name relation', async () => {
    const { readTriggerInputDefinitions } = await import('../src/flow-triggers.js');
    const sdk = sdkWith({
      sys_hub_trigger_input: [
        {
          sys_id: raw('cf1e1980c32222002841b63b12d3aea0'), element: raw('table'), label: raw('Table'),
          internal_type: dv('table_name', 'Table Name'), mandatory: raw('true'), order: raw('1'),
          max_length: raw('80'), default_value: raw(''), attributes: raw('filter_table_source=RECORD_WATCHER_RESTRICTED'),
          choice: raw(''), reference: raw(''), use_dependent_field: raw('false'), dependent_on_field: raw(''),
          read_only: raw('false'), hint: raw(''),
        },
      ],
    });
    const inputs = await readTriggerInputDefinitions(sdk, definitionId);
    assert.equal(sdk.calls[0].table, 'sys_hub_trigger_input');
    assert.equal(sdk.calls[0].params.includes(`sysparm_query=name=var__m_sys_hub_trigger_input_${definitionId}^ORDERBYorder`), true);
    assert.deepEqual(inputs.map(input => input.name), ['table']);
    // `internal_type` holds the real GraphQL type as its RAW value; its display
    // value is only the human label.
    assert.equal(inputs[0].type, 'table_name');
    assert.equal(inputs[0].label, 'Table');
    assert.equal(inputs[0].mandatory, true);
    assert.equal(inputs[0].order, 1);
    assert.equal(inputs[0].parameter.type, 'table_name');
    assert.equal(inputs[0].parameter.maxsize, 80);
    // attributes is a String on input even though the read path renders an object.
    assert.equal(inputs[0].parameter.attributes, 'filter_table_source=RECORD_WATCHER_RESTRICTED');
  });

  it('rejects a definition id that is not an exact sys_id before querying', async () => {
    const { readTriggerInputDefinitions } = await import('../src/flow-triggers.js');
    const sdk = sdkWith({});
    await assert.rejects(readTriggerInputDefinitions(sdk, 'Created'), /exact sys_id/);
    assert.equal(sdk.calls.length, 0);
  });

  it('writes every declared input using the instance default and rejects undeclared names', async () => {
    const { buildTriggerInputs } = await import('../src/flow-triggers.js');
    const declared = [
      { name: 'table', label: 'Table', type: 'table_name', mandatory: true, order: 1, defaultValue: '', parameter: { id: 'p1', label: 'Table', name: 'table', type: 'table_name', order: 1, mandatory: true, attributes: '' } },
      { name: 'condition', label: 'Condition', type: 'conditions', mandatory: false, order: 100, defaultValue: '', parameter: { id: 'p2', label: 'Condition', name: 'condition', type: 'conditions', order: 100, mandatory: false, attributes: '' } },
      { name: 'run_on_extended', label: 'Run On Extended Tables', type: 'choice', mandatory: false, order: 100, defaultValue: 'false', parameter: { id: 'p3', label: 'Run On Extended Tables', name: 'run_on_extended', type: 'choice', order: 100, mandatory: false, attributes: '' } },
    ];
    const inputs = buildTriggerInputs(declared, { table: 'ticket', condition: 'active=true' }, { table: 'ticket', label: 'Ticket', displayField: 'number' });
    assert.deepEqual(inputs.map(input => input.name), ['table', 'condition', 'run_on_extended']);
    assert.deepEqual(inputs[0].value, { schemaless: false, schemalessValue: '', value: 'ticket' });
    assert.deepEqual(inputs[0].displayValue, { schemaless: false, schemalessValue: '', value: 'Ticket' });
    assert.equal(inputs[0].displayField, 'number');
    assert.deepEqual(inputs[1].value, { schemaless: false, schemalessValue: '', value: 'active=true' });
    // The instance's own default fills an input the caller never mentioned.
    assert.deepEqual(inputs[2].value, { schemaless: false, schemalessValue: '', value: 'false' });
    assert.equal(inputs[2].parameter.id, 'p3');

    assert.throws(() => buildTriggerInputs(declared, { nope: 'x' }), /not declared by this trigger definition/);
    assert.throws(() => buildTriggerInputs(declared, { table: '', condition: '' }, null), /"table".*is required/i);
  });
});

describe('table descriptor', () => {
  it('takes the label from sys_db_object and walks the super_class chain for the display column', async () => {
    const { readTableDescriptor } = await import('../src/flow-triggers.js');
    const sdk = sdkWith({
      // sys_db_object is queried by name= and then by sys_id=, so it answers per query.
      sys_db_object: params => {
        const query = decodeURIComponent(String(params));
        if (query.includes('name=ticket')) return [{ name: raw('ticket'), label: raw('Ticket'), super_class: raw('1521b6f78c5103100a22deb6dd2b4e61') }];
        if (query.includes('sys_id=1521b6f78c5103100a22deb6dd2b4e61')) return [{ name: raw('task'), super_class: raw('') }];
        return [];
      },
      sys_dictionary: params => (decodeURIComponent(String(params)).includes('name=ticket') ? [] : [{ element: raw('number') }]),
    });
    const descriptor = await readTableDescriptor(sdk, 'ticket');
    // `ticket` does not declare its own display column: it inherits `number` from task.
    assert.deepEqual(descriptor, { table: 'ticket', label: 'Ticket', displayField: 'number' });
    assert.equal(sdk.calls[0].table, 'sys_db_object');
    assert.match(sdk.calls[0].params, /sysparm_query=name=ticket/);
    assert.equal(sdk.calls.some(call => call.table === 'sys_dictionary' && call.params.includes('display=true')), true);
  });

  it('refuses an unknown table', async () => {
    const { readTableDescriptor } = await import('../src/flow-triggers.js');
    await assert.rejects(readTableDescriptor(sdkWith({ sys_db_object: [] }), 'nope'), /Table not found/);
  });
});

describe('GraphQL parameter payloads', () => {
  it('drops the synthetic default and stringifies attributes for the parameter input type', async () => {
    const { flowDesignParameter, attributesToString } = await import('../src/flow-triggers.js');
    const parameter = flowDesignParameter({
      id: 'i1', name: 'log_level', type: 'choice', label: 'Level',
      // schemaEntries adds this; global_snFlowDesigner_FlowDesignParameter has no such field.
      default: 'info',
      values: ['info'],
      attributes: { element_mapping_provider: 'com.glide.flow_design.action.data.FlowDesignVariableMapper' },
    });
    assert.equal('default' in parameter, false);
    assert.equal('values' in parameter, false);
    assert.equal(parameter.name, 'log_level');
    assert.equal(parameter.attributes, 'element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper');
    assert.equal(attributesToString(''), '');
    assert.throws(() => attributesToString(['x']), /flat object/);
  });
});

describe('create-time trigger assembly', () => {
  const definitionId = 'a45d9180c32222002841b63b12d3aea7';
  const definition = { sysId: definitionId, name: 'Created or Updated', type: 'record_create_or_update', triggerType: 'Record' };

  function inputSdk() {
    return sdkWith({
      sys_hub_trigger_input: [
        { sys_id: raw('p1'), element: raw('table'), label: raw('Table'), internal_type: dv('table_name', 'Table Name'), mandatory: raw('true'), order: raw('1'), max_length: raw('80'), default_value: raw(''), attributes: raw(''), choice: raw(''), reference: raw(''), use_dependent_field: raw('false'), dependent_on_field: raw(''), read_only: raw('false'), hint: raw('') },
        { sys_id: raw('p2'), element: raw('condition'), label: raw('Condition'), internal_type: dv('conditions', 'Conditions'), mandatory: raw('false'), order: raw('100'), max_length: raw('4000'), default_value: raw(''), attributes: raw(''), choice: raw(''), reference: raw(''), use_dependent_field: raw('true'), dependent_on_field: raw('table'), read_only: raw('false'), hint: raw('') },
      ],
    });
  }

  it('maps the table and condition shortcuts onto the declared inputs', async () => {
    const { buildCreateTrigger } = await import('../src/flow-create.js');
    const trigger = await buildCreateTrigger(inputSdk(), 'flow-1', { trigger: { type: 'record_create_or_update', table: 'ticket', condition: 'short_descriptionSTARTSWITHjacetest' } }, definition, {
      readTableDescriptor: async table => ({ table, label: 'Ticket', displayField: 'number' }),
    });
    assert.equal(trigger.flowSysId, 'flow-1');
    assert.equal(trigger.name, 'Created or Updated');
    assert.equal(trigger.type, 'record_create_or_update');
    assert.equal(trigger.triggerType, 'Record');
    assert.equal(trigger.triggerDefinitionId, definitionId);
    // Predicate metadata is left to the instance to derive.
    assert.equal(trigger.metadata, '{}');
    assert.deepEqual(trigger.inputs.map(input => [input.name, input.value.value]), [['table', 'ticket'], ['condition', 'short_descriptionSTARTSWITHjacetest']]);
  });

  it('refuses a table or condition a trigger does not declare', async () => {
    const { buildCreateTrigger } = await import('../src/flow-create.js');
    const scheduled = { sysId: 'f'.repeat(32), name: 'Daily', type: 'daily', triggerType: 'Scheduled' };
    await assert.rejects(buildCreateTrigger(sdkWith({ sys_hub_trigger_input: [] }), 'flow-1', { trigger: { type: 'daily', table: 'ticket' } }, scheduled), /does not declare a table input/);
  });

  it('refuses an unsupported trigger type before touching the instance', async () => {
    const { resolveTriggerDefinition } = await import('../src/flow-create.js');
    const sdk = sdkWith({});
    await assert.rejects(resolveTriggerDefinition(sdk, 'rest'), /unsupported trigger\.type/i);
    assert.equal(sdk.calls.length, 0);
  });
});
