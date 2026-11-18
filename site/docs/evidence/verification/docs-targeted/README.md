# Public docs capture

These are real stdout captures, rendered as scrollable terminal-style HTML and
screenshotted with headless Chromium. They are not fresh interactive terminal
screenshots. The images show viewports, not every line of the full JSON/page.
Open the HTML to scroll, or read the adjacent `.stdout` logs for complete output.
All stderr logs are empty. No credentials or private instance data were used.

Baseline is `77292ac027ce9df5e4b5b31d8b094c425495dcde`. Branch is the implementation
in this PR. Both contacted `https://jsn.jace.pro`, reading
`api-reference/web-services/scripted-graph-ql.md`, release `australia`, revision
`96d32129bb43ac72057be47de4ffd83cf128813c`. The hosted service was not deployed or
changed. Targeted branch captures explicitly report `client-fallback` and full
network transfer. Native shared server behavior is separately exercised by
`cli/test/docs-targeted-cli.test.js` with a local fixture index.

## Reproduce

From each checkout root after `npm --prefix cli ci`, run the commands recorded
verbatim in `measurements.json`. Baseline has no outline/section options.
For a live walkthrough on this branch:

```sh
export JSN_DOCS_URL=https://jsn.jace.pro
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --json > full.json
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --lines 200 --styled
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --outline --styled
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --outline --json > outline.json
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --section Limitations --styled
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --section Limitations --json > section.json
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --get data.body
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --section missing --json
# For source-bound selection, copy an ID and revision from the outline:
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --section '<ID>' --revision '<revision>' --json
cd cli && node --test test/docs-sections.test.js test/docs-section-boundaries.test.js test/docs-targeted-cli.test.js
```

Use a separate baseline checkout rather than resetting the candidate. The exact
captured IDs become invalid when the source changes; refresh the outline then.
`--get` still returns a JSON string unless `--raw` is also supplied.

`measurements.json` counts Unicode characters and UTF-8 bytes, not tokens. Full
JSON drops from 12,924 characters / 13,028 bytes to 8,366 / 8,368 while its body
remains byte-identical. The outline is 2,124 bytes, selected Limitations plus
preamble/ancestor context and omitted-section references is 2,425 bytes. This is
not a complete answer to building a GraphQL API: the prerequisite heading is
explicitly exposed for follow-up.

## Render again

Open each `.html` directly in Chromium, or capture it with:

```sh
chromium --headless --no-sandbox --disable-gpu --hide-scrollbars --window-size=1600,1100 --screenshot=json-comparison.png "file://$PWD/docs/verification/docs-targeted/json-comparison.html"
# human-walkthrough.html uses 1600,2200; section-json.html uses 1600,1100.
```

The HTML contains only escaped verbatim saved output, measured sizes, commands
and presentation labels. No third-party images or proprietary assets are used.
