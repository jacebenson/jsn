// Reusable, provider-independent impact analysis. No CLI, prompts or writes.
const raw = value => String(value?.value ?? value ?? '');
const BOOKKEEPING_FIELDS = new Set(['sys_id', 'sys_created_on', 'sys_created_by', 'sys_updated_on',
  'sys_updated_by', 'sys_mod_count', 'sys_recorded_at', 'sys_update_name']);
export const isImpactField = field => !BOOKKEEPING_FIELDS.has(field);
const decode = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Deliberately accepts only the observed flat record_update payload shape.
// Unknown XML constructs are evidence gaps, never silently discarded changes.
export function baselineFields(payload, artifact) {
  if (!payload || /<!DOCTYPE|<!ENTITY/i.test(payload)) return null;
  const table = artifact.table;
  if (!/^[a-z][a-z0-9_]*$/.test(table || '')) return null;
  const outer = payload.replace(/^\s*<\?xml[^?]*\?>\s*/, '').trim();
  const match = outer.match(/^<record_update\s+table="([a-z0-9_]+)">\s*<([a-z0-9_]+)\s+action="INSERT_OR_UPDATE">([\s\S]*)<\/\2>\s*<\/record_update>$/);
  if (!match || match[1] !== table || match[2] !== table) return null;
  const fields = {};
  let rest = match[3];
  while (rest.trim()) {
    const field = rest.match(/^\s*<([a-z0-9_]+)(?:\s+[^<>]*?)?(?:\s*\/>|>([\s\S]*?)<\/\1>)/);
    if (!field || Object.hasOwn(fields, field[1])) return null;
    let value = field[2] ?? '';
    if (value.startsWith('<![CDATA[') && value.endsWith(']]>')) value = value.slice(9, -3);
    else {
      if (/[<>]/.test(value) || /&(?!lt;|gt;|quot;|apos;|amp;)/.test(value)) return null;
      value = decode(value);
    }
    fields[field[1]] = value;
    rest = rest.slice(field[0].length);
  }
  if (fields.sys_id !== artifact.sys_id) return null;
  return fields;
}

export function analyzeImpact({ artifact, current, baseline, dependencies = [], unknown = [] }) {
  const fields = baselineFields(baseline?.payload, artifact);
  const gaps = [...unknown, 'Dynamic script references, transitive dependencies and runtime outcomes are unknown; no execution testing was performed.'];
  const changes = [];
  if (!fields) gaps.push('The exact base payload is unavailable or its XML shape/identity is unsupported.');
  if (!current) gaps.push('The current artifact is unavailable.');
  if (fields && current) {
    for (const field of Object.keys(fields).sort()) {
      if (!isImpactField(field)) continue;
      if (!Object.hasOwn(current, field)) {
        gaps.push(`Current field ${field} was not returned; its revert impact is unknown.`);
        continue;
      }
      if (raw(current[field]) !== fields[field]) {
        changes.push({ field, current: raw(current[field]), base: fields[field],
          effect: field === 'script' ? 'Replace the executable script with the base script; runtime behavior is unverified.'
            : field === 'active' ? `Set activation to ${fields[field]}; execution eligibility changes.`
              : `Replace ${field} with the base value; behavior beyond this field change is unknown.` });
      }
    }
    gaps.push('Fields absent from the base payload and provider-generated normalization are unknown.');
  }
  return { artifact, evidence: { baseline_version: baseline?.sys_id || null,
    baseline_source: baseline?.source || null, baseline_source_table: baseline?.source_table || null },
  direct_behavior: { status: fields && current ? 'field_comparison' : 'unknown',
    summary: fields && current ? `${changes.length} observed field change(s) on return to base; this is not a runtime simulation.` : 'Unknown without both current artifact and a supported exact base payload.' },
  changes, known_dependencies: dependencies, unknown: gaps,
  recommendation: { action: 'retain', basis: changes.length
    ? 'Preserve the customization pending validation of the observed changes and unknown dependencies.'
    : 'Preserve the customization until the unknown runtime and dependency effects are validated.',
  automatic: false } };
}
