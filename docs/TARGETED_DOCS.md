# Targeted documentation retrieval

The document reader supports `--outline` and `--section` alongside `--path`.
Full-document reads remain the default. No ServiceNow connection is needed.

```sh
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --json
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --outline --styled
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --outline --json
# Copy an ID from that outline, rather than guessing a slug:
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --section '<ID>' --styled
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --section '<ID>' --json
# Exact unique displayed heading text is also accepted.
# Pin the revision returned by the outline to reject a changed index:
node cli/bin/jsn.js docs --path '<exact-path>' --revision '<revision>' --section '<ID>' --json
```

IDs bind the document path, release, revision, body and heading ordinal. They are
not browser anchors and do not survive changes. Duplicate exact headings produce
an ambiguity error listing candidates. Overloads with distinct signatures remain
distinct headings. A missing section is an error, never a full-document fallback.
Revision selection is a mismatch guard, not historical snapshot access.

CommonMark parses top-level ATX and setext headings. Headings inside blockquotes,
lists, fenced or indented code, and HTML blocks are not selection boundaries.
Selection ends before the next equal-or-shallower heading, retaining descendants.
Source text is sliced verbatim, including tables, code and lists. No section is
cut to fit `--lines`; that flag controls only full-document human previews.

Selections always include the document preamble and each ancestor's introduction.
This retains warnings and prerequisites placed before child headings. It cannot
identify all semantically relevant context: warnings in siblings and linked pages
may still matter. `subtree_complete` means syntactic completeness, not a complete
answer. `semantic_completeness` is always `unknown`. Use the outline and full page
for broader questions. Included source spans use zero-based UTF-16 offsets with
exclusive ends. Outline line numbers are one-based and inclusive.

JSON carries the document body once, without a duplicate `_formatted` preview.
The `commonmark` dependency supplies established CommonMark parsing and source
positions rather than a homegrown fence/heading recognizer. It does not render or
rewrite the selected body. `context_sections` lists omitted heading IDs/titles so
prerequisites in siblings are discoverable without claiming they are irrelevant.
Identity, release, revision, service and selection metadata remain available, as
are `--get data.body` and `--raw --get data.body`. Human views retain Markdown
content with source provenance and explicit context limits.

The shared local/hosted HTTP implementation accepts `outline=true` or
`section=<ID-or-exact-title>` on document endpoints and advertises
`section_protocol: sections-v1`. This PR does not deploy that service. When an
older service ignores these parameters and returns a full document without the
protocol marker, the CLI uses the same parser locally. Retrieval metadata says
`execution: client-fallback` and `full_document_transferred: true`; this saves
stdout/context, not network transfer. A service error is not silently retried.
