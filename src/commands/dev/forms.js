async function showForm(app, table, viewName) {
  // 1) Look up the view
  const viewParams = new URLSearchParams();
  viewParams.set('sysparm_limit', '1');
  viewParams.set('sysparm_fields', 'sys_id');
  viewParams.set('sysparm_display_value', 'all');
  viewParams.set('sysparm_query', `name=${viewName}`);
  let viewSysID = '';
  try { const vr = await app.sdk.list('sys_ui_view', viewParams); if (vr.length > 0) viewSysID = getStringField(vr[0], 'sys_id'); } catch { /* ignore */ }
  if (!viewSysID) {
    viewParams.set('sysparm_query', `title=${viewName}`);
    try { const vr = await app.sdk.list('sys_ui_view', viewParams); if (vr.length > 0) viewSysID = getStringField(vr[0], 'sys_id'); } catch { /* ignore */ }
  }

  // 2) Find the form for this table + view
  const formParams = new URLSearchParams();
  formParams.set('sysparm_limit', '1');
  formParams.set('sysparm_fields', 'sys_id');
  formParams.set('sysparm_display_value', 'all');
  formParams.set('sysparm_query', `name=${table}^view=${viewName}`);
  let formSysID = '';
  try { const fr = await app.sdk.list('sys_ui_form', formParams); if (fr.length > 0) formSysID = getStringField(fr[0], 'sys_id'); } catch { /* ignore */ }

  // 3) Get form sections (ordered by position)
  const fsParams = new URLSearchParams();
  fsParams.set('sysparm_limit', '200');
  fsParams.set('sysparm_fields', 'sys_id,sys_ui_section,position,caption,order');
  fsParams.set('sysparm_display_value', 'all');
  fsParams.set('sysparm_query', `form=${formSysID}^ORDERBYposition`);
  const formSections = await app.sdk.list('sys_ui_form_section', fsParams);

  // 4) For each form section, get the section + elements
  const sectionsOut = [];
  for (const fs of formSections) {
    const secRef = fs.sys_ui_section;
    const secSysID = (typeof secRef === 'object' && secRef !== null) ? (secRef.value || '') : String(secRef || '');

    // Fetch section details
    let sectionName = '', sectionCaption = '';
    if (secSysID) {
      const secParams = new URLSearchParams();
      secParams.set('sysparm_limit', '1');
      secParams.set('sysparm_fields', 'name,caption,header');
      secParams.set('sysparm_display_value', 'all');
      secParams.set('sysparm_query', `sys_id=${secSysID}`);
      try {
        const sr = await app.sdk.list('sys_ui_section', secParams);
        if (sr.length > 0) {
          sectionName = getDisplayValue(sr[0], 'name') || '';
          sectionCaption = getDisplayValue(sr[0], 'caption') || '';
        }
      } catch { /* ignore */ }
    }

    // Fetch elements for this section
    let elements = [];
    if (secSysID) {
      const elemParams = new URLSearchParams();
      elemParams.set('sysparm_limit', '500');
      elemParams.set('sysparm_fields', 'element,type,label,mandatory,visible,read_only,order,default_value,help_tag,choice_table,reference');
      elemParams.set('sysparm_display_value', 'all');
      elemParams.set('sysparm_query', `sys_ui_section=${secSysID}^ORDERBYorder`);
      try { elements = await app.sdk.list('sys_ui_element', elemParams); } catch { /* ignore */ }
    }

    sectionsOut.push({
      name: sectionName,
      caption: sectionCaption || sectionName || getDisplayValue(fs, 'caption') || '(unnamed)',
      position: getIntValue(fs, 'position'),
      elements: elements.map(e => ({
        type: getDisplayValue(e, 'type'),
        label: getDisplayValue(e, 'label'),
        element: getDisplayValue(e, 'element'),
        mandatory: getBoolValue(e, 'mandatory'),
        visible: getBoolValue(e, 'visible'),
        read_only: getBoolValue(e, 'read_only'),
        order: getIntValue(e, 'order'),
        default_value: getDisplayValue(e, 'default_value'),
        help_tag: getDisplayValue(e, 'help_tag'),
        choice_table: getDisplayValue(e, 'choice_table'),
        reference: getDisplayValue(e, 'reference'),
      })),
    });
  }

  const totalElements = sectionsOut.reduce((sum, s) => sum + s.elements.length, 0);

  // Build formatted output
  const lines = [];
  lines.push(`Form: ${table} → ${viewName}`);
  if (viewSysID) {
    lines.push(`  View: ${app.getEffectiveInstance()}/nav_to.do?uri=sys_ui_view.do?sys_id=${viewSysID}`);
  }
  if (formSysID) {
    lines.push(`  Form: ${app.getEffectiveInstance()}/nav_to.do?uri=sys_ui_form.do?sys_id=${formSysID}`);
  }
  lines.push('');

  for (const sec of sectionsOut) {
    const secLabel = sec.caption || '(unnamed)';
    lines.push(`── ${secLabel} ──`);
    if (sec.elements.length === 0) {
      lines.push('  (no elements)');
    }
    for (const el of sec.elements) {
      const flags = [];
      if (el.mandatory) flags.push('required');
      if (el.read_only) flags.push('read-only');
      if (!el.visible) flags.push('hidden');
      const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
      const elLabel = el.label || el.element || '(unnamed)';
      lines.push(`  ${elLabel}  ${el.type || ''}${flagStr}`);
    }
    lines.push('');
  }

  process.stdout.write(lines.join('\n') + '\n');
}
