# Production publish guard

`publish-prod.yml` accepts only existing `vMAJOR.MINOR.PATCH` tags with no
leading zeroes or prerelease suffix. The tag must peel to a commit on the
history fetched from `https://github.com/jacebenson/jsn.git` main, and its
version must match `cli/package.json` at that commit. Branch names, arbitrary
SHAs and off-main tags are not publish inputs.

The verification job checks out canonical main, not the requested tag, and
runs its dependency-free verifier before any candidate package scripts. It
fetches the exact tag and complete main history, including when its starting
repository is shallow. Annotated and lightweight tags are supported. Tag-push
runs also compare the fetched tag with the event SHA. Publication checks out
only the verified immutable commit, checks HEAD and version again before
`npm ci`, and retains tests, lint, the prod environment and npm OIDC publishing.
Moving a tag after verification cannot change the selected source commit.
Main ancestry means reachable history, not only the current main tip.

No new release step is required. `release-prod.yml` already commits the version
bump, creates its tag, pushes both `HEAD:main` and the tag, then dispatches
`publish-prod.yml --ref main` with that tag. Manual retries use the same main
workflow ref and existing version tag. Development publishing is unchanged.

## Trust boundary

This is repository workflow hardening, not an independent authorization rule
at npm or GitHub. GitHub loads a tag-push workflow from the tagged revision,
and a manual workflow from its selected ref. A revision that replaces the
workflow itself could remove the checks. Older tags may contain the old
workflow. The updated workflow refuses non-main manual dispatches and loads
its helper from canonical main, so candidate source cannot supply its own
verifier within this workflow. That does not force a different workflow
revision to run these checks. Main policy and GitHub-hosted runner tools are
trusted. A normal main advance after the fetch does not invalidate ancestry;
a later forced history rewrite is outside this snapshot check.

External enforcement would require separately managed repository/environment
ref restrictions or publisher policy. This change does not edit those settings
or add approval steps. No live publishing or OIDC exchange is exercised by the
local tests.

`.github/tests/production-release.test.js` documents the intentional workflow
ordering and source-selection invariants alongside offline Git fixtures.
Run it with `node --test .github/tests/production-release.test.js`, or use
`npm run test:workflows` for the complete workflow-tooling suite, after
`npm --prefix cli ci --ignore-scripts`.
