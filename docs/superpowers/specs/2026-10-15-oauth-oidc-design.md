# OAuth / OIDC authentication for db-browse — design

Date: 2026-10-15
Status: implemented (amended 2026-10-17 to match the build)

## Goal

Give every request to the app — web UI and MCP — a real, named identity that
comes from an external OpenID Connect provider, and let the operator say who
may use the app. Replace the single shared MCP bearer token with per-client,
revocable OAuth 2.1 tokens.

## Decisions

| Question | Decision |
|---|---|
| Identity source | Upstream OpenID Connect provider (generic OIDC: Google Workspace, Okta, Entra, Keycloak, ...). The app stores no passwords for OIDC users. |
| Web UI login | OIDC authorization-code flow with PKCE. Session stores the user (email, else `sub`) and groups. |
| Authorization | Allowlist in config: emails, a group claim, and optionally the names in `authenticate_userfile` (`allow_global_userfile`); any match admits. All three sources are optional; if none yields an entry, everyone is refused. Same list gates web and MCP. |
| MCP | `/mcp` is an OAuth 2.1 protected resource. The app is also the authorization server MCP clients talk to, and brokers the user's login to the upstream provider. Tokens are issued by the app. |
| Per-database access | **Out of scope**; a possible future item. Everyone allowed sees every database, as today. |
| Existing logins | `users.txt` / `config.authenticate` keep working when `config.oidc` is not set. `config.mcp.token` stays as an admin fallback, documented as deprecated. |

## Components

### `oidc.js` — upstream login

- Reads `config.oidc`; does nothing when it is unset.
- Discovery (`/.well-known/openid-configuration`) is fetched lazily and cached.
- `GET /login` (and `/oidc/login`) starts the flow: random `state`, `nonce`
  and PKCE verifier, kept as a row of the store's `pending` table (10 min,
  single use), not in the session; redirect to the provider's authorization
  endpoint. `GET /oidc/callback` takes the pending row by `state`, exchanges
  the code, and verifies the ID token with `jose` (signature against the
  provider's JWKS, `iss`, `aud`, `exp`, `nonce`). Both routes are mounted
  right after the session middleware.
- A web login is also bound to the browser that began it: `/login` puts
  `state` into `req.session.oidc_state`, and the callback refuses a web login
  whose `state` does not match (login-CSRF defence). MCP logins are not bound
  this way: the MCP `/authorize` endpoint runs before the session middleware.
- On success it runs the allowlist check (below), regenerates the session,
  then sets `req.session.authentication = true`, `req.session.auth_via =
  'oidc'` and `req.session.user` (email, falling back to `sub`) plus
  `req.session.groups`. With OIDC on, `loadUser` in `start.js` accepts only
  sessions with `auth_via === 'oidc'` (a persisted password-login session
  has not passed the allowlist) and redirects anything else to
  `/login?to=<original URL>`; `to` is accepted only as a local path.
- `/logout` is unchanged (local session only; no provider-side logout).
- The existing `POST /login` form handler is not mounted when OIDC is on, so
  the password path cannot be used to bypass the allowlist. With OIDC off,
  the password login is unchanged.

### Allowlist

```js
exports.oidc = {
    issuer: 'https://accounts.example.com',
    client_id: '...',
    client_secret: '...',
    redirect_uri: 'https://dbb.example.com/oidc/callback',
    allow_emails: ['ann@example.com'],   // optional
    allow_groups: ['db-readers'],        // optional
    allow_global_userfile: false,        // optional, default false
    groups_claim: 'groups',              // default
};
```

- Email match is case-insensitive. A login whose `email_verified` claim is
  `false` or the string `"false"` is refused outright; a provider that omits
  the claim is trusted.
- Group match reads `groups_claim` from the ID token (array or string).
- `allow_global_userfile: true` also admits a user whose verified email equals
  the name part of an `authenticate_userfile` line (`name:password`, split on
  the first colon, compared case-insensitively). The password is ignored and
  never used for OIDC. The file is re-read at each check, as the password
  login does today, so edits take effect at the next login or token
  issue/refresh. Names that are not emails (e.g. `ivan`) simply never match.
- The flag applies only to `authenticate_userfile`. A custom
  `config.authenticate` function cannot be enumerated, so with only that set
  the flag has no effect and startup logs a warning.
- The check runs at login and when MCP tokens are issued or refreshed. A user
  removed from the list keeps web access until the session expires, and MCP
  access until the access token expires (`access_ttl`) and the refresh is
  refused. A refresh re-checks the email and groups captured at login: a
  group removed at the provider takes effect at the next login, or when the
  refresh token expires (`refresh_ttl`). The refresh token is consumed before
  the check, so a transient allowlist read error kills it (fail closed).

### MCP authorization server

`oauth_provider.js`, behind the MCP SDK's (1.32) `mcpAuthRouter` and
`requireBearerAuth`, used as-is with the SDK's default rate limits (per
`req.ip`). Enabled by the presence of `config.mcp.oauth`, which needs
`config.oidc` and a `public_url`.

Endpoints, mounted at the root of `public_url` before `express_session`,
like `/mcp`:

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 metadata for `/mcp` |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata |
| `POST /register` | RFC 7591 dynamic client registration |
| `GET /authorize` | PKCE (S256 only) authorization request |
| `POST /token` | code → access + refresh token; refresh grant |
| `POST /revoke` | RFC 7009 token revocation |

Flow: client → `/authorize` → app redirects the user to the upstream OIDC
login (same code path as the web UI) → callback runs the allowlist → app
issues its own one-time authorization code bound to client, redirect URI and
PKCE challenge → client posts the code and verifier to `/token`.

Tokens are opaque 256-bit random values. Only SHA-256 hashes are stored.
Access tokens last `access_ttl` (default 1 hour); refresh tokens last
`refresh_ttl` (default 30 days) and rotate on use. Every grant is for one
resource, `<public_url>/mcp`: a request without `resource` gets it, and
`/authorize` refuses any other. `/mcp` accepts a bearer token that is valid,
unexpired and issued for that resource, and (as today) the static
`config.mcp.token`. An unauthenticated call gets 401 with
`WWW-Authenticate: Bearer resource_metadata="…"`.

There is no per-client consent screen: the user is sent straight to the
provider (see the known limitations below).

### `auth_store.js` — persistence

A separate SQLite file, `config.auth_db` (default `auth.sqlite`, relative to
the working directory), opened at startup when `config.oidc` is set:
`clients` (registered clients), `pending` (in-flight upstream logins: state,
nonce, verifier, kind `web`/`mcp`, data), `codes` (hash, 60 s, single use),
`tokens` (hash, kind `access`/`refresh`, client, email, groups, nullable
`resource`, expiry; revocation deletes the row). Expired rows are purged on
every write. The file (and its `-wal`/`-shm`) is created with mode 0600. Web sessions remain in the existing session store.

## Config

```js
exports.oidc = { /* as above */ };
exports.mcp = {
    token: '...',                 // optional, deprecated static admin token
    oauth: {                      // present = OAuth for MCP on (needs oidc)
        public_url: 'https://dbb.example.com',  // required; an origin, no path
        access_ttl: 3600,         // seconds, default 1 hour
        refresh_ttl: 2592000,     // seconds, default 30 days
    },
};
exports.auth_db = 'auth.sqlite';  // the store, default auth.sqlite
exports.trust_proxy = 1;          // optional: Express 'trust proxy'
```

- `public_url` is the issuer and the base of every OAuth URL. The SDK serves
  the endpoints at the host root, so it must be an origin: startup exits
  with a message if it is missing, unparseable, or has a path, query or
  fragment, or if `mcp.oauth` is set without `oidc`.
- `trust_proxy`, when set, goes to `app.set('trust proxy', ...)`; behind a
  reverse proxy it gives each client its own `req.ip`, and so its own rate
  limit bucket.
- `DBB_CONFIG` (environment) names a config file to load instead of
  `./config.js`; tests use it to run `start.js` with OIDC on.

`config.js.example` and README get the new section; `CLAUDE.md` gets an
"Authentication" subsection.

## Error handling

- Provider unreachable or discovery fails: login page shows an error with
  HTTP 502; nothing is cached as failed forever.
- Any ID-token validation failure, `state` mismatch, or disallowed user: 403
  with a plain message that does not say which check failed.
- Invalid OAuth requests follow RFC 6749 error responses; unknown client or
  redirect URI never redirects (shown as an error page).
- Fail closed: misconfiguration (OIDC on, but no `allow_emails`,
  `allow_groups`, or usable userfile with `allow_global_userfile`) refuses all
  logins and logs why at startup.

## Security notes

- Redirect URIs for dynamically registered clients must be `https`, or
  `http://localhost` / `127.0.0.1` for native clients, without a fragment.
  They match exactly, except that a loopback URI matches with any port
  (RFC 8252 section 7.3, the SDK's rule).
- Authorization codes are single use and expire within 60 s.
- `client_secret`, codes and tokens are never logged; the request log omits
  the query string of `/oidc/callback`.
- TLS is the operator's responsibility (as for the existing MCP token). The
  SDK refuses to start with a `public_url` that is not `https://`, except on
  `localhost` / `127.0.0.1`.

## Testing

`test/oauth.js`, added to `test/run.js`, with a mock OIDC provider started
in-process (discovery, JWKS, authorization, token). No real provider is
needed. Cases: web login allowed / denied by email and by group; empty
allowlist; userfile email admitted with `allow_global_userfile` and refused
without it; userfile entry with a non-email name never matches; userfile edit
picked up at the next login; unverified email refused; forged signature, wrong `aud`, expired token, bad `nonce`, `state`
mismatch; full MCP flow (register → authorize → token → `/mcp` call);
PKCE mismatch; reused code; revoked and expired tokens; refresh rotation; the
static admin token still works; `users.txt` login unchanged when OIDC is off.
The "app wiring" section spawns `start.js` with `DBB_CONFIG` pointing at a
temporary config (OIDC and `mcp.oauth` on) and checks the redirects, the
missing `POST /login`, the full web and MCP flows and the startup refusals.

## Out of scope / known limitations

- Per-database or per-user permissions (future).
- No consent screen (follow-up). With dynamic registration, anyone can
  register a client with their own redirect URI. An allowlisted user who
  completes the provider login for a crafted `/authorize` link (the
  provider's real login page, or no prompt at all with an existing provider
  session) delivers a code for their identity to that redirect URI. The
  attacker then reads every configured database (and the raw `query` tool
  with `allow_clear_sql`) for as long as the user stays allowlisted, since
  the 30-day refresh token rotates. MCP authorization guidance recommends
  per-client consent. Until then, revocation is by deleting `tokens` rows
  (by `email` or `client_id`) in `auth.sqlite`; deleting a `clients` row
  alone does not invalidate its access tokens (README, "Revoking MCP
  access").
- Provider-side logout / single logout.
- Providers that are OAuth 2.0 only (e.g. GitHub) — would need a separate
  userinfo-based identity step.
- A UI for listing or revoking tokens (revocation is via `/revoke` and
  direct edits of `auth.sqlite`).

## Resolved in the plan

- `jose` (v6, ESM-only) is a direct dependency, loaded with a dynamic
  `import()`; it needs Node >= 20, as MCP already does.
- The SDK's `mcpAuthRouter`, `requireBearerAuth` and `OAuthServerProvider`
  (1.32) are used as-is; PKCE is checked by the provider at code exchange
  (`skipLocalPkceValidation`), after the code is taken.
