# Raw REST

## Sub-features

`rest` is the escape hatch for an endpoint or table shorthand. GET is the only method allowed in the read-only verification lane. `--raw` preserves non-JSON response text.

## How to get to it (user POV)

With a disposable authenticated read-only profile, run:

```bash
node bin/jsn.js --profile <disposable-read-only-profile> rest --method GET --table incident --query "sysparm_limit=3" --json
```

## Driving it with the JSN CLI

Doctor first. Then check exit 0, `ok: true`, and a JSON response body. For a raw diagnostic endpoint, use the documented `--raw` option and assert text rather than parsing JSON.

## Gotchas

Use an explicitly configured read-only profile. Authentication does not establish write safety. No local account or instance state is assumed.
