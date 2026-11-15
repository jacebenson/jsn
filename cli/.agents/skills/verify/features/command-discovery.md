# Command discovery

## Sub-features

The top-level `--help` output exposes command families. A command's `--help` output exposes supported subcommands and flags. `completion` generates shell completion text.

## How to get to it (user POV)

Run:

```bash
node bin/jsn.js --help
node bin/jsn.js records list --help
node bin/jsn.js rest --help
```

## Driving it with the JSN CLI

Capture stdout and exit codes. Check that the documented entry points `records`, `auth`, `rest`, `docs`, and `version` appear in top-level help. Check that `records list` exposes `--table`, `--query`, `--columns`, and `--limit`.

## Gotchas

Do not invent aliases or copy commands from an older JSN release. The installed binary and command help are the source of truth.
