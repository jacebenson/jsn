# Credential destination policy

Project `.servicenow/config.json` files can select connection settings, but cannot
approve a destination for ambient `SERVICENOW_OAUTH_TOKEN` or Basic environment
credentials. Approve the exact origin outside the project: use `--instance URL`,
set `SERVICENOW_INSTANCE_URL` in the process environment, or configure that origin
as your user-global default. Merely saving another profile does not authorize a
project to redirect ambient credentials to its origin. Binding precedence is an
explicit instance, an explicitly selected global profile, the process instance,
then the global default. A project cannot approve an origin merely by
naming a profile. Explicitly selecting a globally saved profile uses its global
entry, not a same-named project shadow.

Environment variables are trusted process inputs, not project-file inputs. This
policy cannot protect a process after shell startup hooks, an untrusted dotenv
loader, or other code has already changed its environment. Direct SDK callers
and programmatically constructed config objects are responsible for selecting
their trusted destination; configuration loaded from project files retains its
origin provenance in memory. Stored credentials remain keyed to their instance
and username; this change does not grant project-selected origins access to
credentials for another origin.

The SDK rejects authenticated requests outside its configured instance origin.
Authenticated API requests and OAuth code/refresh grants do not follow redirects,
including same-origin redirects. Configure the canonical instance origin instead
of relying on a redirecting proxy. UI session bootstrap also rejects automatic
redirects. The existing MFA success response remains a manually inspected,
same-origin 302; it is not automatically followed.

Credential-bearing SDK and authentication requests require HTTPS. Loopback HTTP
(`localhost`, IPv4 127/8, and `::1`) remains available for local development.
For a legacy non-loopback HTTP instance, set `JSN_ALLOW_INSECURE_HTTP=1` explicitly
in the invoking process. This permits cleartext credential transmission and
should not be used on untrusted networks. Neither a project config key nor a
profile setting enables this escape hatch. It does not relax origin binding or
redirect rejection.

Transport inventory: OAuth grants and browser-session verification live in
`auth.js`; API/processor/raw-response/attachment requests, recovery verification,
UI bootstrap, MFA exchanges and AMB session acquisition live in `sdk.js`.
`amb.js` separately transmits AMB cookies/tokens and pins its destination to the
original instance origin, including when callers change its public baseUrl/path.
AMB paths must be local routes, not absolute URLs or protocol-relative references.
`midserver-install.js` validates explicit MID Basic credentials through a separate
sender. Both senders use the shared origin/HTTPS policy and reject redirects.
