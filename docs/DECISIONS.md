# JSN decisions

## The capability registry is authoritative

Command safety capabilities live in `src/capabilities.js`. Middleware derives mutation and daily-check behavior from that registry. New commands must declare their capabilities instead of adding names to separate lists.

## Output goes through one controller

Command data goes through `app.output` so JSON, Markdown, CSV, styled output, and `--get` remain consistent. Handlers must not print data directly with `console.log`.

## Mutations stay guarded

Mutation commands require the instance, respect read-only profile boundaries, and follow the confirmation path in `src/mutations.js`. Verification recipes use read-only commands unless a disposable mutation lane is explicitly established.

## Verification is project-owned

The pstack-shaped launch, drive, proof, evidence, and cleanup instructions live in `.agents/skills/verify/`. General product knowledge lives in `docs/`, so verification procedures and product description do not drift into one document.
