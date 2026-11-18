// GENERATED FILENAME: keep in sync with site/config/docs-links.json.
// The npm package ships only cli/, so this projection is checked in and verified
// by site/test/docs_links_test.rb. Edit the registry, then regenerate this file.
export const SITE_ORIGIN = 'https://jsn.jace.pro';
export const DOC_LINKS = Object.freeze({
  codesearch: '/features/servicenow-code-search-cli/',
  docs: '/docs/cli-guide/#jsn-cli-guide',
  flows: '/docs/flows/#flow-definition-search',
  records: '/docs/records/#watching-a-servicenow-record',
  updatesets: '/docs/updatesets/#transfer-an-update-set',
  midservers: '/docs/midservers/#remote-mid-management-over-ssh',
  setup: '/docs/setup/#connect-an-instance',
  auth: '/docs/setup/#authentication-lifecycle-review',
  skill: '/docs/agents/#use-jsn-with-ai-agents',
});

/** Absolute documentation URL for one registered command family. */
export function docLink(name) {
  const path = DOC_LINKS[name];
  return path ? `${SITE_ORIGIN}${path}` : `${SITE_ORIGIN}/docs/`;
}
