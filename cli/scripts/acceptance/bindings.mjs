// Explicit assertion bindings, not command-path/help/factory coverage inference.
export function bindScenarios(scenarios) {
  for (const s of scenarios) {
    const bindings = {};
    for (const binding of Object.values(s.coverageBindings || {})) if (Array.isArray(binding.options)) binding.options = Object.fromEntries(binding.options.map(id => [id, ['explicit-value']]));
    const bind = (path, requirements, options = {}) => { bindings[path] = { requirements, options }; };
    if (s.id === 'local.version') bind('version', ['scripted-success', 'human-and-json-output'], { '$root --json': ['explicit-value', 'omitted-default', 'human-json-consistency'] });
    if (s.id === 'local.completion') bind('completion', ['scripted-success']);
    if (s.id === 'local.history-empty') bind('history list', ['scripted-success'], { 'history list --limit': ['explicit-value'] });
    if (s.id === 'local.parser-rejection') bind('records list', ['scripted-failure']);
    if (s.id === 'readonly.records') {
      bind('records list', ['scripted-success', 'human-and-json-output']);
      bind('records get', ['scripted-success']);
    }
    if (s.id.startsWith('resources.')) for (const command of s.commandPaths) {
      bind(command, command.endsWith(' delete') ? ['scripted-success', 'scripted-failure'] : ['scripted-success']);
    }
    // Flow/catalog/interactive are intentionally NOT credited: their complete
    // lifecycle cannot pass. Auth bindings await actual provider validation.
    s.coverageBindings = { ...s.coverageBindings, ...bindings };
  }
  return scenarios;
}

export function coverageDetails(coverage, scenarios, selectedIds, mode, selectedScope = false) {
  if (!Array.isArray(coverage?.entries) || !coverage.entries.length) return { gaps: ['coverage inventory missing or empty'], counts: { capabilities: 0, incomplete: 0 } };
  const paths = new Set(coverage.entries.map(e => e.path));
  const gaps = [];
  for (const s of scenarios) for (const command of s.commandPaths) if (!paths.has(command)) gaps.push(`unknown-command:${s.id}:${command}`);
  const selected = scenarios.filter(s => selectedIds.includes(s.id) && s.modes.includes(mode));
  const counts = { capabilities: 0, incomplete: 0, bound: 0, excludedLive: 0, outOfMode: 0, missingRequirements: 0, missingOptionAssertions: 0 };
  for (const entry of coverage.entries) {
    if (entry.exclusion) { counts.excludedLive++; continue; }
    if (mode === 'readonly' && entry.mode === 'pdi') { counts.outOfMode++; continue; }
    const bound = selected.filter(s => s.coverageBindings?.[entry.path]);
    if (selectedScope && !selected.some(s => s.commandPaths.includes(entry.path))) continue;
    counts.capabilities++;
    const start = gaps.length;
    if (!bound.length) gaps.push(`unbound:${entry.path}`); else counts.bound++;
    const requirements = new Set(bound.flatMap(s => s.coverageBindings[entry.path].requirements || []));
    for (const r of entry.acceptance?.requirements || []) if (!requirements.has(r)) { gaps.push(`requirement:${entry.path}:${r}`); counts.missingRequirements++; }
    for (const option of entry.effectiveOptions || []) {
      const id = typeof option === 'string' ? option : option.name;
      const asserted = new Set(bound.flatMap(s => s.coverageBindings[entry.path].options?.[id] || []));
      const required = coverage.optionDefinitions?.[id]?.requiredAssertions || ['explicit-value'];
      for (const assertion of required) if (!asserted.has(assertion)) { gaps.push(`option:${entry.path}:${id}:${assertion}`); counts.missingOptionAssertions++; }
    }
    if (gaps.length !== start) counts.incomplete++;
  }
  for (const workflow of coverage.workflowRequirements || []) {
    // A seam is not proven by matching path sets; require explicit workflow proof.
    if (mode === 'readonly' && !['local-cli-lifecycle', 'readonly-vendor', 'performance-context'].includes(workflow.capability)) continue;
    if (!selected.some(s => s.workflowBindings?.includes(workflow.capability))) gaps.push(`workflow:${workflow.capability}`);
  }
  return { gaps, counts };
}
