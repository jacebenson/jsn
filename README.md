# JSN

JSN is a command-line interface for ServiceNow, with a documentation website.

- [`cli/`](cli/README.md): the published `@jacebenson/jsn` npm package, tests and bundled agent skill.
- [`site/`](site/README.md): the Rails website and public documentation API.
- [`docs/`](docs/): the Eleventy source for the website’s static reference pages.

The documentation engine is shipped inside the CLI package and reused by the website.
There is one search implementation and no separate search package to publish.

## Development

```sh
npm --prefix cli ci
npm test
npm run lint
node cli/bin/jsn.js --help
```

Run package commands from `cli/`, including `npm pack`. Production releases use
GitHub Actions; do not publish from the private repository-root package.
See [AGENTS.md](AGENTS.md), [GLOSSARY.md](GLOSSARY.md) and [docs/DECISIONS.md](docs/DECISIONS.md).
