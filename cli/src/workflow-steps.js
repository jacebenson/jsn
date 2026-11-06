// Number only already-loaded rows; this module performs no instance reads.
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const byNameId = (a, b) => compare(a.name, b.name) || compare(a.sys_id, b.sys_id);
const unconditional = edge => edge.condition_status === 'none'
  || (edge.condition_status === 'ok' && /^always$/i.test(edge.condition_name.trim()));
const exception = edge => edge.condition_status === 'ok'
  && /^(rejected|reject|failure|failed|error|skipped|cancelled|canceled|timeout|expired)$/i.test(edge.condition_name.trim());
const preference = edge => unconditional(edge) ? 0
  : edge.condition_status === 'ok'
    && /^(approved|approve|success|ok|true|yes|completed)$/i.test(edge.condition_name.trim()) ? 1
    : exception(edge) ? 3 : 2;
const byEdge = (a, b) => preference(a) - preference(b)
  || compare(a.to_name, b.to_name) || compare(a.to_id, b.to_id)
  || compare(a.condition_name, b.condition_name) || compare(a.condition_id, b.condition_id)
  || compare(a.sys_id, b.sys_id);

/** Deterministic iterative DFS preorder, starting only at the version's start. */
export function numberWorkflowSteps(activities, transitions, startId, components) {
  const stable = [...activities].sort(byNameId);
  const activityById = new Map(stable.map(activity => [activity.sys_id, activity]));
  const outgoing = new Map(stable.map(activity => [activity.sys_id, []]));
  for (const edge of transitions) outgoing.get(edge.from_id)?.push(edge);
  for (const edges of outgoing.values()) edges.sort(byEdge);
  let fallback_reason = null;
  if (!startId) fallback_reason = 'no start activity';
  else if (!activityById.has(startId)) fallback_reason = 'start activity not in the readable activities';
  else if (components.activities !== 'ok' || !['ok', 'not_applicable'].includes(components.transitions)) {
    fallback_reason = 'activities or transitions not readable';
  }
  const steps = [];
  const visited = new Set();
  const add = (activity, reached_from_start) => {
    visited.add(activity.sys_id);
    steps.push({ number: steps.length + 1, sys_id: activity.sys_id, name: activity.name, reached_from_start });
  };
  if (!fallback_reason) {
    const stack = [startId];
    while (stack.length) {
      const id = stack.pop();
      if (visited.has(id)) continue;
      add(activityById.get(id), true);
      // Reverse push preserves preferred-edge order without recursive stack limits.
      for (const edge of [...outgoing.get(id)].reverse()) {
        if (activityById.has(edge.to_id) && !visited.has(edge.to_id)) stack.push(edge.to_id);
      }
    }
  }
  for (const activity of stable) if (!visited.has(activity.sys_id)) add(activity, false);
  // Stable partition after traversal; fallback retains its disclosed name/ID order.
  if (!fallback_reason) {
    steps.sort((a, b) => Number(outgoing.get(a.sys_id).length === 0)
      - Number(outgoing.get(b.sys_id).length === 0));
    steps.forEach((step, index) => { step.number = index + 1; });
  }
  const byId = new Map(steps.map(step => [step.sys_id, step]));
  // Exactly one preferred edge may be implicit. Parallel conditions remain visible.
  for (const edge of transitions) edge.is_sequential = false;
  for (const step of steps) {
    if (!step.reached_from_start) continue;
    const edges = outgoing.get(step.sys_id);
    const next = edges[0];
    const target = byId.get(next?.to_id);
    if (next && (!exception(next) || edges.length === 1)
      && target?.reached_from_start && target.number === step.number + 1) next.is_sequential = true;
  }
  return { steps, step_order: { method: fallback_reason ? 'stable_fallback' : 'start_traversal', fallback_reason } };
}
