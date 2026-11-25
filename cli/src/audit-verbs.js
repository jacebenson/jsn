// The `tables audit` switch verbs. One list, imported by the eager capability
// declaration and by the command module, so a verb cannot exist in one place
// and be missing from the mutation guard in the other. The declaration has to
// be complete at buildCLI(): the guard reads the registry then, before any
// deferred family loads.
export const AUDIT_VERBS = ['enable', 'disable', 'exclude', 'include', 'deletes'];

/** Mutation paths `tables` declares for those verbs, in capability form. */
export const AUDIT_MUTATION_PATHS = AUDIT_VERBS.map(verb => `audit ${verb}`);
