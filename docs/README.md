# Documentation sources

## Guides

Start with [install](docs-install.md), [setup](docs-setup.md),
[safety](docs-safety.md), [output](docs-output.md), [agents](docs-agents.md),
or the [CLI guide](cli-guide.md). See [releases and channels](releases.md) for
installation channels and release maintenance.

Rails publishes only the sources in [the guide allowlist](../site/config/guides.json)
at `/docs/<key>/`. Adding Markdown here does not publish it. Website data and
public assets belong to `site/data/` and `site/static/`; `docs/` is not an npm project.
The ServiceNow corpus reader at `/documentation` is separate from these JSN guides.

## Contributor references

- [Working rules](../AGENTS.md), [domain model](../GLOSSARY.md), and [decisions](DECISIONS.md)
- [Authentication lifecycle](AUTH_LIFECYCLE.md) and [credential destination policy](security-credential-transport.md)
- [Feature map](FEATURE_MAP.md) and [verification instructions](verification/README.md)
- [Test audit](TEST_AUDIT.md), [bounded regression baseline](BOUNDED_BASELINE.md), and [task measurements](RESULTS_MEASUREMENTS.md)
- [Acceptance CI](acceptance-ci.md) and [acceptance build identity](ACCEPTANCE_BUILD_IDENTITY.md)
- [Source-backed research](research/README.md)

Historical parity reports and referenced captures remain evidence, not current
verification or public guides. [Legacy redirects](../site/config/legacy-guide-urls.json)
link to exact source records. Preserve those targets and their linked logs,
screenshots and other assets; the guide allowlist alone is not a deletion list.

## Website checks

Run from the repository root:

```sh
npm run docs
node --test site/test/*.test.mjs
site/bin/preview --test
```

Asset preparation writes generated files under `site/`. Rails tests need the
Ruby and gems documented in [the website README](../site/README.md). For an
interactive preview, run `npm run docs:serve`. CLI checks remain `npm test` and
`npm run lint`; live integration tests are a separate, explicit opt-in.
