// Select exact scenarios and their transitive dependencies, without widening scope.
export function selectExactScenario(scenarios, id) {
  if (!id) return scenarios;
  const selected = new Set();
  const visiting = new Set();
  const add = key => {
    if (visiting.has(key)) throw Error('scenario: cyclic dependency');
    if (selected.has(key)) return;
    const scenario = scenarios.find(s => s.id === key);
    if (!scenario) throw Error('scenario: exact scenario or dependency unavailable in selected mode');
    visiting.add(key);
    for (const dependency of scenario.requires || []) add(dependency);
    visiting.delete(key);
    selected.add(key);
  };
  add(id);
  return scenarios.filter(s => selected.has(s.id));
}
