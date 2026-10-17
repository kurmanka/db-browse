# 19 — OAuth / OIDC authentication for the web UI and MCP

**Severity:** medium (feature; closes a security gap)
**Area:** `auth_store.js`, `allowlist.js`, `oidc.js`, `oauth_provider.js` (new);
`mcp.js`, `start.js`
**Source:** user request — the MCP interface authenticates every agent with one
shared static token, and the web UI with a plaintext `users.txt`. Neither gives
a named, revocable identity.

## Goal

Both the web UI and `/mcp` get a real user identity from an external OpenID
Connect provider, an operator-controlled allowlist decides who may enter, and
MCP clients get per-client revocable OAuth 2.1 tokens issued by the app.

## Scope

- Web login: OIDC authorization-code flow with PKCE (generic OIDC).
- Allowlist: `allow_emails`, `allow_groups`, and `allow_global_userfile` (the
  names in `authenticate_userfile`); any match admits, none configured refuses
  everyone.
- MCP: the app is the OAuth 2.1 authorization server (dynamic client
  registration, PKCE, refresh rotation, revocation) and `/mcp` a protected
  resource. The static `config.mcp.token` remains as a deprecated admin
  fallback. State is kept in a separate SQLite file, `auth.sqlite`.
- `DBB_CONFIG` selects the config file, so tests can start the real server.
- Without `config.oidc` nothing changes.

Out of scope: per-database access (future), provider-side logout,
OAuth-2.0-only providers such as GitHub, a UI for token management.

## References

- Spec: `docs/superpowers/specs/2026-10-15-oauth-oidc-design.md`
- Plan: `docs/superpowers/plans/2026-10-16-oauth-oidc.md`

## Status

- [x] implemented (tasks 1–6 of the plan)
- [ ] follow-up: a per-client consent screen (without it, a crafted `/authorize`
  link can hand an attacker's client long-lived read access as the user who
  logs in), and per-database access (see the
  spec's "Out of scope / known limitations")
