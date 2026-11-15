# Releases and channels

## Install and update

For the newest changes from `main`, including changes that may be unstable:

```bash
npm install -g @jacebenson/jsn@dev
```

Dev builds check the dev channel for updates during normal use, at most once
per day. Run `jsn version --check` to check immediately. To install the newest
dev build, run `jsn upgrade` (alias: `jsn update`). It preserves your installed
channel and skips installation when no newer version is available. Use
`--dry-run` to print the npm command without network access or installation,
`--force` to reinstall, or `--channel dev|latest` to switch channels explicitly.
For example, `jsn upgrade --channel latest` returns to stable. npm installation
permissions still apply; the command does not elevate privileges automatically.

## Supported versions

Only the current release and the two preceding releases in each channel are
supported (three stable releases and three dev builds). For example, with
stable `4.3.11`, versions `4.3.11`, `4.3.10`, and `4.3.9` are supported.
Update to the newest version in your channel before reporting an issue.

Publishing uses npm trusted publishing (OIDC) and advances the channel's dist-tag.
CI/CD does not deprecate older versions or require an `NPM_TOKEN` secret. Older
versions remain available; their availability does not extend the support window.

The optional maintenance script `scripts/deprecate-old-versions.mjs` can preview
older versions with `node scripts/deprecate-old-versions.mjs latest` (or `dev`).
Applying deprecations with `--apply` requires npm authentication and
`NODE_AUTH_TOKEN`; it is separate from publishing. The script requires the
checkout's package version to match the channel's current npm tag.

## Publishing from the repository

Package commands run in `cli/`; the repository root is private and must not be published.
Production releases use the `Release production` GitHub Actions workflow with
`patch`, `minor`, or `major`. The workflow tests and lints, bumps the version,
pushes the commit and tag, dispatches npm publishing, and creates the GitHub release.
Do not push release tags or publish locally as a substitute.

Pushes to `main` promote the commit to `dev` and publish a tested prerelease
under npm's `dev` tag. Versions include the workflow run number and attempt
(for example, `4.3.9-dev.123.1`); they do not move npm's stable `latest` tag.
The npm trusted publisher for `publish-dev.yml` must authorize the repository's
`dev` GitHub environment, alongside the production publishing configuration.


See [contribution rules](../AGENTS.md) and the workflow definitions under
[.github/workflows](../.github/workflows/).
