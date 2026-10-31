// Shared interpretation for CLI help, saved-report views and comparisons.
// Keep this independent of capture/storage so older captures remain readable.
export function customizationGuidance() {
  return {
    capture: 'Capture uses bounded GET-only table reads and saves reports locally. Authentication may refresh OAuth credentials locally or bootstrap a session/GCK with authentication POSTs. Saved list/show/compare/html operations are offline.',
    evidence: {
      upgrade_skips: 'Raw upgrade dispositions 4 and 104 are historical skipped-customization evidence; reviewed_reverted rows are excluded. Display labels and other skip reasons are not equivalent. A skip does not prove a current OOTB baseline deviation.',
      ownership: 'Customer scopes must be declared explicitly. Matching a scope verifies its identity, not customer or publisher ownership. Non-global scope and updater names do not establish ownership.',
      metadata: 'The broad sys_metadata read is an arbitrary sys_id-ordered bounded sample, not an inventory. Declared-customer and unclassified categories are not complete inventories; they can include sampled artifacts and artifacts found by skipped-history lookups.',
      resolution: 'Every observed skipped file_name is resolved by chunked sys_metadata.sys_update_name lookups. Unresolved names and failed lookup chunks remain coverage gaps. A resolved artifact may lack a scope name when its scope was outside the bounded sys_scope read.',
    },
    limitations: [
      'All captures are incomplete. No findings is not proof of no customizations; ACLs, pagination limits, unmatched evidence and concurrent changes can hide artifacts.',
      'Current baseline, full source payloads, runtime reversion impact and dependencies are not established. An empty dependency list does not prove none exist.',
    ],
    comparison: 'Comparisons cover captured metadata and evidence only. Added/removed means newly observed/no longer observed, not proven creation/deletion. Changed declarations or coverage can change categories without an artifact change.',
    next_steps: [
      'Review coverage, evidence and per-artifact confidence before drawing conclusions.',
      'Verify ownership and compare with a trusted baseline for the exact release; investigate dependencies and test in non-production before changing records. Never recommend automatic reversion.',
    ],
    automated_remediation: false,
  };
}

export function formatCustomizationGuidance() {
  const guidance = customizationGuidance();
  return [
    ...Object.values(guidance.evidence), ...guidance.limitations,
    guidance.comparison, ...guidance.next_steps.map(step => `Next: ${step}`),
  ].join('\n');
}
