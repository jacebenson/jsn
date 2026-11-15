// Global feature data: one canonical URL per capability.
import { readFileSync } from "node:fs";

const raw = JSON.parse(readFileSync(new URL("./showcase-data.json", import.meta.url), "utf8"));
const seo = JSON.parse(readFileSync(new URL("./seo-features.json", import.meta.url), "utf8"));
const seoById = new Map(seo.map((s) => [s.id, s]));

const slugOverrides = {
  skill: "servicenow-agent-skill-installer",
  docsWeb: "servicenow-documentation-browser",
  "docs-web": "servicenow-documentation-browser",
  flows: "servicenow-flow-subflow-context",
  catalog: "servicenow-catalog-variables",
  scripts: "servicenow-background-scripts",
  transactions: "servicenow-transaction-summaries",
  "scopes-domains": "servicenow-scopes-domain-separation",
  "form-behavior": "servicenow-form-ui-behavior",
  integrations: "servicenow-integration-artifacts",
  metadata: "servicenow-schema-platform-metadata",
  "record-tools": "servicenow-record-tools",
};

const groups = {
  auth: "Connect",
  skill: "Automate",
  "docs-cli": "Explore",
  "docs-web": "Explore",
  read: "Explore",
  create: "Change",
  "catalog-create": "Change",
  delete: "Change",
  bulk: "Change",
  cmdb: "Explore",
  flows: "Automate",
  catalog: "Explore",
  updatesets: "Change",
  atf: "Verify",
  scripts: "Automate",
  performance: "Diagnose",
  "platform-health": "Diagnose",
  transactions: "Diagnose",
  logs: "Diagnose",
  codesearch: "Explore",
  snippets: "Explore",
  "record-tools": "Explore",
  "scopes-domains": "Change",
  "flow-operations": "Diagnose",
  "form-behavior": "Explore",
  integrations: "Change",
  metadata: "Explore",
  rest: "Extend",
};

export default raw.map((s) => {
  const promoted = seoById.get(s.id);
  return {
    ...s,
    group: groups[s.id] || "Explore",
    canonicalSlug: promoted?.slug || slugOverrides[s.id] || `servicenow-${s.id}`,
    seoTitle: promoted?.title || s.title,
    seoDescription: promoted?.description || s.tagline,
    seoQuery: promoted?.query || "What can JSN do for this ServiceNow workflow?",
    demoText: s.demo
      ? readFileSync(new URL(`./demos/${s.demo}.txt`, import.meta.url), "utf8")
      : "",
  };
});
