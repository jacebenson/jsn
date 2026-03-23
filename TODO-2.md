i thought i saw a lot of confusion between using `--data` and `--json`
You're right — let me look back at the actual mistakes more carefully.

$ jsn rest --help 2>&1

Make arbitrary REST API calls to any endpoint on the ServiceNow instance.

Supports GET, POST, PATCH, and DELETE methods for calling custom, scoped,
or out-of-box REST APIs beyond the Table API.

The path should start with "/" and is appended to the instance URL.

Examples:
  jsn rest get /api/now/table/incident?sysparm_limit=5
  jsn rest post /api/now/table/incident --data '{"short_description":"test"}'
  jsn rest patch /api/now/table/incident/sys_id --data '{"state":"2"}'
  jsn rest delete /api/now/table/incident/sys_id
  jsn rest get /api/x_myapp/custom_api/resource
  jsn rest post /api/now/import/my_import_set --data '{"field":"value"}'
  jsn rest get /api/now/stats/incident?sysparm_count=true

Usage:
  jsn rest [command]

Available Commands:
  delete      Perform a DELETE request
  get         Perform a GET request
  patch       Perform a PATCH request
  post        Perform a POST request

Flags:
  -h, --help   help for rest

Global Flags:
      --agent            Agent mode (JSON + quiet + no interactive prompts)
      --config string    config file (default is $HOME/.config/servicenow/config.json)
      --jq string        Apply jq filter to JSON output
      --json             Output as JSON
      --md               Output as Markdown
      --no-interactive   Disable interactive prompts (for scripts/CI)
  -p, --profile string   profile to use
  -q, --quiet            Quiet output (data only, no envelope)

Use "jsn rest [command] --help" for more information about a command.
$ jsn rest post --help 2>&1

Perform a POST request to any endpoint on the instance.

Use --data to provide a JSON request body.

Examples:
  jsn rest post /api/now/table/incident --data '{"short_description":"Created via REST"}'
  jsn rest post /api/x_myapp/custom_api/action --data '{"param":"value"}'
  jsn rest post /api/now/import/my_import_set --data '{"field":"value"}'
  jsn rest post /api/sn_sc/servicecatalog/items/sys_id/order_now --data '{"sysparm_quantity":1}'

Usage:
  jsn rest post <path> [flags]

Flags:
  -d, --data string      JSON request body
  -H, --header strings   Custom headers (e.g., -H 'X-Custom: value')
  -h, --help             help for post

Global Flags:
      --agent            Agent mode (JSON + quiet + no interactive prompts)
      --config string    config file (default is $HOME/.config/servicenow/config.json)
      --jq string        Apply jq filter to JSON output
      --json             Output as JSON
      --md               Output as Markdown
      --no-interactive   Disable interactive prompts (for scripts/CI)
  -p, --profile string   profile to use
  -q, --quiet            Quiet output (data only, no envelope)
Yeah, now I see the problem clearly. --data is the flag for the request body, and --json is a global output formatting flag. They do completely different things but I constantly conflated them. Let me update the file.

Good call — that's probably the #1 issue honestly. The --json/--data confusion hit me in almost every command I wrote. The core problem:

jsn rest post/patch: --data = input body, --json = output format
jsn records create: --json = input body (and also output format??)
jsn records update: neither works — only -f flags
Same flag name, three different meanings across three subcommands. I'd try --body, --file, --json with a value, and --data in random order before landing on the right one every single time. Added it as #11 and moved it to the top of the priority table. File's at /tmp/jsn-improvements.md.
