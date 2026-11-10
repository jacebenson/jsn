// Table API reads omit reference URLs by default. Explicit provider parameters
// take precedence, including inspection callers that require a particular shape.
export function tableReadParams(params, { includeReferenceLinks = false } = {}) {
  const query = new URLSearchParams(params);
  if (!includeReferenceLinks && !query.has('sysparm_exclude_reference_link')) {
    query.set('sysparm_exclude_reference_link', 'true');
  }
  return query;
}
