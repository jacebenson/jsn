import assert from 'node:assert/strict';

// Parse emitted GraphQL input values rather than manufacturing a successful
// readback from the manifest. This fixture models persistence, not the provider.
export function readFlowPatch(query) {
  const start = query.indexOf('flowPatch:');
  assert.notEqual(start, -1);
  const tokens = query.slice(start + 10).match(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z_0-9]*|[[{}\]:,]/g);
  let pos = 0;
  function value() {
    const token = tokens[pos++];
    if (token === '{') {
      const out = {};
      while (tokens[pos] !== '}') {
        const key = tokens[pos++];
        assert.equal(tokens[pos++], ':');
        out[key] = value();
        if (tokens[pos] === ',') pos++;
      }
      pos++;
      return out;
    }
    if (token === '[') {
      const out = [];
      while (tokens[pos] !== ']') {
        out.push(value());
        if (tokens[pos] === ',') pos++;
      }
      pos++;
      return out;
    }
    return token.startsWith('"') || /^(true|false|null|-?\d)/.test(token) ? JSON.parse(token) : token;
  }
  return value();
}

export function persistFlowPatch(before, patch) {
  const after = structuredClone(before);
  for (const [key, field] of [['actions', 'actionInstances'], ['flowLogics', 'flowLogicInstances']]) {
    if (!patch[key]) continue;
    after[field] ||= [];
    for (const insert of patch[key].insert || []) after[field].push({ ...structuredClone(insert), id: `db-${insert.uiUniqueIdentifier}` });
    for (const update of patch[key].update || []) {
      const saved = after[field].find(s => s.uiUniqueIdentifier === update.uiUniqueIdentifier);
      assert.ok(saved, `missing update target ${update.uiUniqueIdentifier}`);
      for (const [name, val] of Object.entries(update)) {
        if (name === 'type' || name === 'uiUniqueIdentifier') continue;
        if (name === 'inputs') {
          for (const input of val) {
            const target = saved.inputs.find(i => i.name === input.name);
            assert.ok(target);
            target.value = structuredClone(input.value);
            if (input.displayValue !== undefined) target.displayValue = structuredClone(input.displayValue);
          }
        } else saved[name] = structuredClone(val);
      }
    }
  }
  if (patch.labelCache) after.labelCacheAsJsonString = JSON.stringify(patch.labelCache.insert || []);
  return after;
}
