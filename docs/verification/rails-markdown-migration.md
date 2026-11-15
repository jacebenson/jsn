# Rails Markdown migration verification

Base: `b4b9916f8e25e48fd76322a5d7bb72fbd233aae8`, canonical `jacebenson/jsn` main.
No merge, deployment, release, production configuration or instance writes.
The separate active `jsn-markdown-preview` was read only.

## Ownership and compatibility

- Public guide allowlist: `site/config/guides.json`, 22 maintained Markdown sources.
- Original Eleventy build inventory: 54 non-feature HTML URLs, preserved verbatim
  as a set in `site/config/preserved-urls.json`. Five existing `/docs/*/` routes
  remain 200. All other original URLs have explicit 301 mappings, either to the
  new guide route or the exact contributor record on canonical GitHub.
- All 29 canonical feature pages are exercised in the Rails suite. Original
  showcase/SEO/demo data moves from `docs/_data/` to `site/data/`, not from a
  stale generated public tree. Generated `site/config/features.json` is unchanged.
- Public assets/CSS move from `docs/assets/` and `docs/css/` to `site/static/`.
  Two documentation images and the explicitly referenced flow-search fixture
  image move there too, with source Markdown links adjusted. No evidence text
  or verification source is deleted. The ServiceNow corpus implementation and
  `/documentation` routes are unchanged.
- WebMCP source bytes are unchanged. SHA-256 before and after:
  `8ac72ac2c4fdf1a63df676a6f882452fbcf4433b65dffb76a7b632d8ee2b24ac`.

## Removed build machinery

`docs/.eleventy.js`, `docs/package.json`, `docs/package-lock.json`,
`docs/_data/featureGroups.js`, `docs/_data/seoFeatures.js`, `docs/_data/site.json`,
`docs/_includes/comparison.njk`, `docs/home.njk`, `docs/features-catalog.njk`,
`docs/features/feature.njk`, `docs/llms.njk`, `docs/robots.njk`, `docs/sitemap.njk`.
Five guide frontmatters lose only the unused Nunjucks layout key.
`llms.txt` editorial text now lives in `site/data/llms.txt`; asset preparation
produces its feature list, robots and sitemap without npm dependencies.

## Build consumers audited

`site/Dockerfile`, root and CLI npm scripts, `site/README.md`, `site/WEBMCP.md`,
`scripts/changed-components.mjs`, CLI changed-component/workflow contract tests,
and `.github/workflows/docs-site.yml`. The latter still builds the actual image,
runs the full Rails and Node suites, and extracts `tmp/preserved-urls.json`.
No CI workflow files were modified, avoiding the parallel CI acceptance work.

## Execution

1. Before migration: installed original docs dependencies and ran original build.
   Eleventy wrote 88 files and copied 14; inventory contained 54 HTML guide/evidence
   URLs after excluding Rails-owned root/features. npm reported three high
   vulnerabilities in that now-removed docs dependency project.
2. The new guide test was red before implementation: 5 runs, 13 assertions,
   2 failures and 2 errors, including missing renderer constant and setup link.
3. Before deleting docs build dependencies, the implemented renderer plus original
   site suite passed: 75 runs, 1414 assertions, zero failures/errors/skips.
   The first baseline run had failed because CLI dependencies were absent;
   installing the existing CLI bundle resolved that harness problem.
4. After removal and final regressions: isolated portable preview test command,
   77 runs, 1607 assertions, zero failures/errors/skips. Includes allowlisting,
   traversal rejection, sanitizer/link policy, heading fragments/duplicates,
   explicit image sources, all guide links, all original URL mappings, all feature
   routes, and existing corpus/API/account/snapshot/sync tests.
5. Node site tests: 17 passed, including all six WebMCP registrations/executions
   under mock capability and error/cancellation/source separation cases.
6. CLI suite: 2259 tests, 2257 pass, 2 explicit live-instance opt-in skips,
   zero failures. `npm run lint` and `git diff --check` pass.
7. Real Chromium against isolated Rails on localhost: guide index/install/setup/
   safety/output, homepage, feature library/detail, all 54 legacy URLs, CSS,
   images, sitemap/robots/llms and versioned WebMCP bundle. Desktop 1280px and
   mobile 390px had no document overflow. Screenshots were visually inspected.
   Feature filter changed 29 visible cards to 1 for `auth`.
8. Chromium native `document.modelContext` with `WebMCPTesting` enabled discovered
   all six tools on the guide page and executed all six on the feature page.
   Native JSN catalog search returned the real rendered Auth feature. Native
   ServiceNow search against the unseeded local corpus returned the honest 503
   error; no live/proxy transport or invented successful corpus results used.
   JSON and screenshots: `site/test/evidence/rails-guides/`.

## Limitations and review notes

- Local container build attempted and blocked by Docker socket permission.
  `sudo -n docker` also requires a password. Local Rails HTTP/browser proof is
  real, but is not a container-build pass. Container CI must be checked on the PR.
- AGENTS.md still describes the old docs project. Updating that protected
  instruction file was denied by tool policy; it was not retried or bypassed.
  `docs/README.md`, the ADR and site documentation describe current ownership.
- PR #480 remains open. Only its root README ownership line and removal of the
  unused layout key in install/safety overlap; its prose was not copied or replaced.
  `docs/cli-guide.md` and its new release guide remain in place for that PR to land.
- Parent owns independent review. This report does not claim production delivery.
