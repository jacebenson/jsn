# Raw REST

## Sub-features

`rest` is the escape hatch for an endpoint or table shorthand. GET is the only method allowed in the safe kitchen lane. `--raw` preserves non-JSON response text.

## How to get to it (user POV)

With a disposable authenticated read-only profile, run:

```bash
node bin/jsn.js --profile <disposable-read-only-profile> rest --method GET --table incident --query "sysparm_limit=3" --json
```

## Driving it with the JSN CLI

Doctor first. Then check exit 0, `ok: true`, and a JSON response body. For a raw diagnostic endpoint, use the documented `--raw` option and assert text rather than parsing JSON.

## Gotchas

The last verified `pdi` run was authenticated and verified against `dev354702.service-now.com`, but `read_only` is false. Keep live drives to GET/list commands. Do not use POST, PUT, PATCH, or DELETE in the default verification skill. Do not use `rest` when a specific JSN command exists. The current live read evidence covers records; raw REST remains a separate GET-only check.
