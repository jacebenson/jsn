// Compare explicit keys without depending on the host locale.
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const byNameId = (a, b) => compare(a.name, b.name) || compare(a.sys_id, b.sys_id);
const byEdge = (a, b) => compare(a.to_name, b.to_name) || compare(a.sys_id, b.sys_id);

/** Pure analysis of already-loaded rows. Iterative Kosaraju avoids stack limits. */
export function analyzeWorkflowGraph(activities, transitions) {
  const members = activities.map(({ sys_id, name }) => ({ sys_id, name })).sort(byNameId);
  const activity_ids = new Set(members.map(member => member.sys_id));
  const outgoing = new Map(members.map(member => [member.sys_id, []]));
  const reverse = new Map(members.map(member => [member.sys_id, []]));
  const groups = new Map(members.map(member => [member.sys_id, { ...member, transitions: [] }]));
  for (const edge of transitions) {
    // Retain malformed source links in the grouped view too, without treating
    // the missing source as an activity in the sampled graph.
    if (!groups.has(edge.from_id)) groups.set(edge.from_id, {
      sys_id: edge.from_id, name: edge.from_name, transitions: [],
    });
    groups.get(edge.from_id).transitions.push(edge);
    if (activity_ids.has(edge.from_id) && activity_ids.has(edge.to_id)) {
      outgoing.get(edge.from_id).push(edge.to_id);
      reverse.get(edge.to_id).push(edge.from_id);
    }
  }
  const visited = new Set();
  const finished = [];
  for (const { sys_id } of members) {
    if (visited.has(sys_id)) continue;
    visited.add(sys_id);
    const stack = [[sys_id, 0]];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const neighbors = outgoing.get(frame[0]);
      if (frame[1] === neighbors.length) {
        finished.push(frame[0]);
        stack.pop();
      } else {
        const next = neighbors[frame[1]++];
        if (!visited.has(next)) {
          visited.add(next);
          stack.push([next, 0]);
        }
      }
    }
  }
  const componentOf = new Map();
  const components = [];
  for (const id of finished.reverse()) {
    if (componentOf.has(id)) continue;
    const index = components.length;
    const component = [];
    const stack = [id];
    componentOf.set(id, index);
    while (stack.length) {
      const current = stack.pop();
      component.push(current);
      for (const next of reverse.get(current)) {
        if (!componentOf.has(next)) {
          componentOf.set(next, index);
          stack.push(next);
        }
      }
    }
    components.push({ ids: component, edges: [], entries: new Set() });
  }
  for (const edge of transitions) {
    const target = componentOf.get(edge.to_id);
    if (target === undefined) continue;
    if (componentOf.get(edge.from_id) === target) components[target].edges.push(edge);
    else components[target].entries.add(edge.to_id);
  }
  const memberById = new Map(members.map(member => [member.sys_id, member]));
  const loops = components.filter(component => component.ids.length > 1
    || component.edges.some(edge => edge.from_id === edge.to_id)).map(component => ({
    members: component.ids.map(id => memberById.get(id)).sort(byNameId),
    // Every internal SCC edge participates in a cycle, not just a DFS back-edge.
    edges: component.edges.sort((a, b) => compare(a.from_name, b.from_name)
      || compare(a.from_id, b.from_id) || byEdge(a, b)),
    entry_points: [...component.entries].map(id => memberById.get(id)).sort(byNameId),
  })).sort((a, b) => byNameId(a.members[0], b.members[0]));
  return {
    activity_ids,
    groups: [...groups.values()].sort(byNameId).map(group => ({
      ...group, transitions: group.transitions.sort(byEdge),
    })),
    loops,
  };
}
