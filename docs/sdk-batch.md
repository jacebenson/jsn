# Optional SDK batch reads

`SDKClient.batch(requests, options)` is an explicit transport for independent,
read-only calls to the selected instance. Ordinary SDK/record commands stay
unbatched. This follows the compatibility audit's initial read-only batch scope;
writes continue through normal SDK methods and their safety/history contracts.

```js
const output = await sdk.batch([
  { id: 'incident', url: '/api/now/table/incident?sysparm_limit=1' },
  { id: 'task', method: 'GET', url: '/api/now/table/task?sysparm_limit=1' },
], { fallback: true, chunkSize: 50 });
for (const item of output.results) {
  if (item.ok) consume(item.data); // normal API envelope, e.g. { result: [...] }
  else report(item.id, item.status, item.error);
}
```

Requests accept an optional unique `id` (otherwise their one-based index), a
same-instance `/api/` URL, optional `GET` method, and optional header object.
External origins, authentication-header overrides, nested batches, request bodies,
and write methods fail validation before any requests are sent. Auth and domain
selection come from the existing SDK. Credential last-seen metadata is not touched.

The implementation uses the official
[ServiceNow Batch API](https://www.servicenow.com/docs/r/xanadu/api-reference/rest-apis/batch-api.html):
`POST /api/now/v1/batch` with `batch_request_id` and `rest_requests`. Response
`serviced_requests` carry base64 bodies; `unserviced_requests` contain IDs. Results
are correlated by ID and returned in input order, even if the server reorders them.
JSON item bodies become objects, other bodies stay text, and empty bodies are null.

The result includes `transport` (`batch`, `individual`, `mixed`, or `none`),
`counts` (`total`, `successful`, `failed`), and `results`. Each item contains `id`,
`ok`, HTTP `status`, `data`, `error`, and `serviced`. Explicit unserviced items have
`serviced: false`; absent responses have `serviced: null` because execution is
unknown. Both are errors, never empty success. Item HTTP failures and malformed
body errors retain their item correlation. Malformed aggregate envelopes,
unknown/duplicate response IDs, and wrong batch IDs fail the aggregate operation.

By default, only outer HTTP 404/405/501 triggers sequential individual GET fallback.
Unsupported endpoint state is cached for this SDK instance. `fallback: false`
requires native batch support. No fallback hides outer authentication, ACL,
rate-limit, server, timeout, or malformed-response failures. Item failures,
unserviced requests, and missing responses are never automatically retried.
Existing SDK auth recovery applies only to a definitive outer 401, not failed
items in an otherwise accepted batch. No writes can be replayed through this API.

`chunkSize` defaults to 50 and accepts 1–1000; chunks run sequentially. `timeout`
defaults to the SDK timeout and applies to each native batch or fallback read,
not the entire operation. Platform payload/processing limits can still leave
items unserviced; batching does not promise parallel transactions or atomicity.
Successful earlier chunks may have been read if a later aggregate request fails.
