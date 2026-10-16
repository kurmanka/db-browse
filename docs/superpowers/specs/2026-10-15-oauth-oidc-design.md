# OAuth / OIDC authentication for db-browse — design

Date: 2026-10-15
Status: proposed

## Goal

Give every request to the app — web UI and MCP — a real, named identity that
comes from an external OpenID Connect provider, and let the operator say who
may use the app. Replace the single shared MCP bearer token with per-client,
revocable OAuth 2.1 tokens.

## Decisions

| Question | Decision |
|---|---|
| Identity source | Upstream OpenID Connect provider (generic OIDC: Google Workspace, Okta, Entra, Keycloak, ...). The app stores no passwords for OIDC users. |
| Web UI login | OIDC authorization-code flow with PKCE. Session stores `sub`, email and groups. |
| Authorization | Allowlist in config: emails, a group claim, and optionally the names in `authenticate_userfile` (`allow_global_userfile`); any match admits. All three sources are optional; if none yields an entry, everyone is refused. Same list gates web and MCP. |
| MCP | `/mcp` is an OAuth 2.1 protected resource. The app is also the authorization server MCP clients talk to, and brokers the user's login to the upstream provider. Tokens are issued by the app. |
| Per-database access | **Out of scope**; a possible future item. Everyone allowed sees every database, as today. |
| Existing logins | `users.txt` / `config.authenticate` keep working when `config.oidc` is not set. `config.mcp.token` stays as an admin fallback, documented as deprecated. |

## Components

### `oidc.js` — upstream login

- Reads `config.oidc`; does nothing when it is unset.
- Discovery (`/.well-known/openid-configuration`) is fetched lazily and cached.
- `GET /login` (when OIDC is on) starts the flow: random `state`, `nonce`,
  PKCE verifier kept in the session, redirect to the provider's authorization
  endpoint. `GET /oidc/callback` checks `state`, exchanges the code, and
  verifies the ID token with `jose` (signature against the provider's JWKS,
  `iss`, `aud`, `exp`, `nonce`).
- On success it runs the allowlist check (below), then sets
  `req.session.authentication = true` and `req.session.user` (email, falling
  back to `sub`) plus `req.session.groups`. `loadUser` in `start.js` is
  unchanged: it already keys on `req.session.authentication`.
- `/logout` is unchanged (local session only; no provider-side logout).
- The existing `POST /login` form handler is not mounted when OIDC is on, so
  the password path cannot be used to bypass the allowlist.

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

- Email match is case-insensitive and requires `email_verified !== false`.
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
  access until the access token expires (1 h) and the refresh is refused.

### MCP authorization server

Built on the MCP SDK's server auth helpers
(`@modelcontextprotocol/sdk/server/auth`: `mcpAuthRouter`, `requireBearerAuth`,
the `OAuthServerProvider` interface) where they fit; the plan must confirm the
installed SDK version's behaviour before relying on them.

Endpoints, mounted before `express_session` like `/mcp` today:

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource` | RFC 9728 metadata for `/mcp` |
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
Access tokens last 1 hour; refresh tokens rotate on use. `/mcp` accepts a
bearer token that is valid and unexpired, and (as today) the static
`config.mcp.token`. An unauthenticated call gets 401 with
`WWW-Authenticate: Bearer resource_metadata="…"`.

### `auth_store.js` — persistence

A separate SQLite file, `auth.sqlite`, opened lazily like `sqliteDB.js`:
`clients`, `codes` (short TTL, single use), `tokens` (hash, client, user,
kind, expiry, revoked). Expired rows are purged opportunistically. Web
sessions remain in the existing session store.

## Config

`config.oidc` as above, plus an optional `config.mcp.oauth` block (enable
flag, token lifetimes, `public_url` — the externally visible base URL used in
metadata and redirects, required when behind a proxy). `config.js.example`
and README get the new section; `CLAUDE.md` gets an "Authentication"
subsection.

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

- Redirect URIs for dynamically registered clients must be exact-match;
  `http://localhost` / `127.0.0.1` allowed for native clients, otherwise
  `https` only.
- Authorization codes are single use and expire within 60 s.
- `client_secret` and tokens are never logged.
- TLS is the operator's responsibility (as for the existing MCP token);
  `public_url` should be `https://` outside localhost, and startup warns if
  it is not.

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

## Out of scope

- Per-database or per-user permissions (future).
- Provider-side logout / single logout.
- Providers that are OAuth 2.0 only (e.g. GitHub) — would need a separate
  userinfo-based identity step.
- A UI for listing or revoking tokens (revocation is via `/revoke` and
  direct edits of `auth.sqlite`).

## Open for the plan

- Confirm `jose` as a direct dependency and its Node requirement versus the
  app's current minimum (MCP already needs Node ≥ 20).
- Confirm which SDK auth helpers can be used as-is versus wrapped.
