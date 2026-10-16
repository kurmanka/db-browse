# OAuth / OIDC Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web login through an upstream OIDC provider, an allowlist (emails, groups, optionally the `authenticate_userfile` names), and an OAuth 2.1 authorization server in the app so `/mcp` accepts per-client revocable tokens.

**Architecture:** `oidc.js` runs the upstream authorization-code + PKCE flow for both web and MCP logins, keeping in-flight state in `auth_store.js` (SQLite), not the session. `allowlist.js` decides who may enter. `oauth_provider.js` implements the MCP SDK's `OAuthServerProvider` on top of the store and is mounted by `mcp.js` through the SDK's `mcpAuthRouter` / `requireBearerAuth`.

**Tech Stack:** Node (CJS), Express 4, `better-sqlite3`, `@modelcontextprotocol/sdk` 1.32.0 (`server/auth/*`), `jose` 6 (ESM-only: load with `await import('jose')`), plain-`assert` test scripts in `test/`.

**Spec:** `docs/superpowers/specs/2026-10-15-oauth-oidc-design.md`

## Global Constraints

- PKCE S256 only. Authorization codes are single use and expire within 60 s.
- Tokens are opaque 256-bit random values; only SHA-256 hashes are stored. Access tokens last 1 hour; refresh tokens rotate on use.
- Email match is case-insensitive and requires `email_verified !== false`. `groups_claim` defaults to `groups`.
- Fail closed: OIDC on with no `allow_emails`, `allow_groups`, or usable userfile (`allow_global_userfile`) refuses every login and logs why at startup.
- Dynamic-client redirect URIs: exact match; `http://localhost` / `127.0.0.1` allowed, otherwise `https` only. Unknown client or redirect URI never redirects.
- `client_secret` and tokens are never logged. `/mcp` keeps accepting `config.mcp.token`.
- With `config.oidc` unset, behaviour is unchanged (`users.txt` / `config.authenticate`, `POST /login`).
- MCP SDK needs Node ≥ 20 and is loaded only inside `mount()` (existing rule). New modules `require` nothing from the SDK or `jose` at top level.
- Code style: match the surrounding files (`'use strict'` only where the file has it, `var`/callbacks in app files, plain `assert` in tests).

## Review Focus

1. IdP releases no `email`, or `email_verified: false` → login refused with 403, no crash (Task 2, 3).
2. `/authorize` with an unknown `client_id` or an unregistered `redirect_uri` → error page, never a redirect (Task 4).
3. Callback `state` replayed or expired → 403; the second use of a code or refresh token fails (Tasks 1, 3, 4).
4. `to` parameter such as `//evil.example` or `https://evil.example` → redirect goes to `/` (Task 3).
5. `allow_global_userfile` with a missing or unreadable file → treated as empty and logged, not an exception (Task 2).

---

## File Structure

| File | Responsibility |
|---|---|
| `auth_store.js` (new) | SQLite persistence: clients, pending upstream logins, codes, tokens |
| `allowlist.js` (new) | `isAllowed`, `problems`: who may enter |
| `oidc.js` (new) | Upstream OIDC client + `/login`, `/oidc/login`, `/oidc/callback` routes |
| `oauth_provider.js` (new) | `OAuthServerProvider` for the SDK router, backed by the store |
| `mcp.js` (modify) | Mount auth router, accept OAuth or static bearer on `/mcp` |
| `start.js` (modify) | Wire OIDC; `loadUser` redirects to `/login` when OIDC is on |
| `test/oauth.js`, `test/helpers/mock_oidc.js` (new) | Tests and in-process mock IdP |
| `test/run.js`, `config.js.example`, `README.md`, `CLAUDE.md`, `.gitignore`, spec | Registration and docs |

---

### Task 1: Persistence — `auth_store.js`

**Files:**
- Create: `auth_store.js`
- Test: `test/oauth.js` (create; same `ok()` / pass-fail counters and exit code as `test/mcp.js`)

**Interfaces:**
- Produces: `open(file: string) -> store` (opens lazily-created SQLite file, creates tables), `hash(s: string) -> string` (hex SHA-256), `randomToken() -> string` (32 random bytes, base64url). Store methods, all synchronous, times in epoch **seconds**:
  - `addClient(c: object)`, `getClient(id: string) -> object|undefined` (client info stored as JSON)
  - `putPending({state, nonce, verifier, kind: 'web'|'mcp', data: object, expires_at})`, `takePending(state) -> row|undefined` (atomic read+delete; `undefined` when absent or expired)
  - `putCode({code_hash, client_id, email, groups: string[], challenge, redirect_uri, resource, expires_at})`, `takeCode(code_hash) -> row|undefined` (atomic, single use, expiry honoured)
  - `putToken({token_hash, kind: 'access'|'refresh', client_id, email, groups, expires_at})`, `getToken(token_hash) -> row|undefined` (undefined when expired), `takeToken(token_hash) -> row|undefined` (atomic delete, for refresh rotation), `revoke(token_hash)`
  - `purgeExpired()` runs inside every `put*`.

- [ ] **Step 1: Write the failing tests** in `test/oauth.js`, section "store", using a temp file: `takeCode is single use` (second take → `undefined`); `expired code is not returned`; `takePending is single use and honours expiry`; `getToken / takeToken / revoke`; `purgeExpired removes only expired rows`; `secrets are stored hashed` (put a token via `hash(raw)`, read the file with a second `better-sqlite3` handle, assert no column contains `raw`).
- [ ] **Step 2: Run** `node test/oauth.js` → Expected: FAIL (`Cannot find module '../auth_store.js'`).
- [ ] **Step 3: Implement** `auth_store.js` with `better-sqlite3` in the style of `sqliteDB.js`; `takePending`/`takeCode`/`takeToken` use `DELETE ... RETURNING` (or a transaction) so they are atomic; JSON columns for `data`, `groups`, client info.
- [ ] **Step 4: Run** `node test/oauth.js` → Expected: all store tests PASS.
- [ ] **Step 5: Commit** — `git add auth_store.js test/oauth.js && git commit -m "feat: auth store (SQLite) for OAuth state"`

---

### Task 2: Allowlist — `allowlist.js`

**Files:**
- Create: `allowlist.js`
- Modify: `test/oauth.js` (section "allowlist")

**Interfaces:**
- Consumes: `util.getArrayOfStrings(text, done)` (as `start.js` uses for the userfile).
- Produces:
  - `isAllowed(config, claims: {email?: string, email_verified?: boolean, groups?: string|string[]}, done: (err, allowed: boolean) => void)`, reading `config.oidc.allow_emails`, `allow_groups`, `allow_global_userfile` and `config.authenticate_userfile`. `claims.groups` is already extracted from `groups_claim` by `oidc.finish` (Task 3).
  - `problems(config) -> string[]`: startup messages: OIDC on with no usable allowlist source; `allow_global_userfile` set but only a custom `config.authenticate` (flag has no effect).

- [ ] **Step 1: Write the failing tests** — each asserts `isAllowed` result: email in `allow_emails` with different case → true; `email_verified: false` → false; `email_verified` absent → true; no `email` → false without throwing; group array, group string, missing groups → true/true/false; userfile line `ann@example.com:pw` → true with `allow_global_userfile: true`, false without; password containing a colon (`ann@example.com:p:w`) still matches by name; line `ivan:pw` never matches; userfile path missing → false and no throw; rewriting the file between two calls changes the second result; nothing configured → false. `problems()`: returns a message for OIDC with an empty allowlist, none when a source exists, a warning for the custom-`authenticate` case.
- [ ] **Step 2: Run** `node test/oauth.js` → Expected: allowlist tests FAIL (module missing).
- [ ] **Step 3: Implement** both functions. Userfile read goes through `fs.readFile` + `util.getArrayOfStrings` on every call (no caching); name = text before the first `:`; read errors are logged with `console.log` and treated as an empty list.
- [ ] **Step 4: Run** `node test/oauth.js` → Expected: PASS.
- [ ] **Step 5: Commit** — `git add allowlist.js test/oauth.js && git commit -m "feat: OIDC allowlist with optional userfile names"`

---

### Task 3: Upstream login — `oidc.js` and the mock IdP

**Files:**
- Create: `oidc.js`, `test/helpers/mock_oidc.js`
- Modify: `package.json` (`npm install jose@^6` to make it a direct dependency), `test/oauth.js` (section "web login")

**Interfaces:**
- Consumes: store methods from Task 1; `isAllowed` from Task 2.
- Produces:
  - `create(config, store) -> oidc | null` (`null` when `config.oidc` is unset). Methods:
    - `begin(kind: 'web'|'mcp', data: object) -> Promise<string>`: stores a pending row (10 min TTL) with random `state`, `nonce`, PKCE `verifier`, and returns the provider's authorization URL (`code_challenge_method=S256`, scope `openid email profile`).
    - `finish(query: {code?, state?, error?}) -> Promise<{pending, claims: {sub, email, email_verified, groups: string[]}}>`: takes the pending row (so `state` is single use), exchanges the code, verifies the ID token with `jose` (signature via the issuer's JWKS, `iss`, `aud` = `client_id`, `exp`, `nonce`), builds `groups` from `groups_claim` (array or string → array). Rejects with an `Error` whose `.status` is 403 for any validation failure and 502 when the provider is unreachable.
    - `mountWeb(app, hooks: {mcp: (pending, claims, res) => void})`: registers, **after** the session middleware, `GET /login` and `GET /oidc/login` (both call `begin('web', {to: safeLocal(req.query.to)})` and redirect), and `GET /oidc/callback` (calls `finish`, then `isAllowed`; disallowed → 403 plain text that does not say which check failed; `web` → set `req.session.authentication = true`, `req.session.user = email || sub`, `req.session.groups`, redirect to `data.to`; `mcp` → `hooks.mcp(...)`).
  - `safeLocal(to) -> string`: returns `to` only when it starts with a single `/` (not `//`, no scheme), else `/`; also `/login` → `/`.
  - Mock IdP: `start() -> Promise<{issuer: string, config(): object, next(overrides): void, close(): Promise<void>}>`, an Express app on an ephemeral port serving discovery, JWKS (`jose.generateKeyPair`, RS256), an auto-approving `/authorize` (redirects to `redirect_uri` with `code` and `state`), and `/token` (checks `code_verifier` against the stored challenge, returns an ID token built from `next()` overrides: `email`, `email_verified`, `groups`, `sub`, `aud`, `expired`, `badSignature`, `nonce`).

- [ ] **Step 1: Write the failing tests** in-process: Express app with `express-session` (memory store), `oidc.mountWeb`, and a test route `GET /whoami` returning `req.session.user`; a cookie-carrying `fetch` helper with `redirect: 'manual'`. Tests: `web login: full flow sets the session user` (authorization URL has `code_challenge_method=S256`, `state`, `nonce`); `denied by allowlist → 403`; `unverified email → 403`; `no email claim → 403`; `forged signature → 403`; `wrong audience → 403`; `expired ID token → 403`; `bad nonce → 403`; `state replay → 403` (second callback with the same `state`); `unknown state → 403`; `to=//evil.example → redirect to /`; `to=/ds/table → redirect to /ds/table`; `provider down → 502`; `group-only user admitted`.
- [ ] **Step 2: Run** `node test/oauth.js` → Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the mock IdP, then `oidc.js`: discovery fetched lazily with `fetch`, cached on success only; `jose` loaded with `await import('jose')` on first use; JWKS via `createRemoteJWKSet`. Log failures with a reason server-side, never tokens or secrets.
- [ ] **Step 4: Run** `node test/oauth.js` → Expected: PASS.
- [ ] **Step 5: Commit** — `git add oidc.js test/helpers/mock_oidc.js test/oauth.js package.json package-lock.json && git commit -m "feat: OIDC web login (code flow + PKCE, ID token verification)"`

---

### Task 4: Authorization server — `oauth_provider.js`

**Files:**
- Create: `oauth_provider.js`
- Modify: `test/oauth.js` (section "oauth provider")

**Interfaces:**
- Consumes: `store`, `oidc` (Tasks 1, 3), `isAllowed` (Task 2).
- Produces: `create(config, store, oidc) -> provider` implementing the SDK's `OAuthServerProvider` (`clientsStore`, `authorize`, `challengeForAuthorizationCode`, `exchangeAuthorizationCode`, `exchangeRefreshToken`, `verifyAccessToken`, `revokeToken`) plus `complete(pending, claims, res)`, the `hooks.mcp` handler for Task 3. Config read: `config.mcp.oauth.access_ttl` (default 3600), `refresh_ttl` (default 2592000).
  - `clientsStore.registerClient` rejects redirect URIs that are neither `https:` nor `http://localhost|127.0.0.1[:port]`.
  - `authorize(client, params, res)` calls `oidc.begin('mcp', {client_id, redirect_uri, state, challenge: params.codeChallenge, resource})` and redirects `res` to the returned URL.
  - `complete` issues a code (60 s, hash stored) and redirects to the client's `redirect_uri` with `code` and the client's original `state`.
  - Code exchange, refresh rotation (`takeToken`; the old refresh token dies, a new access + refresh pair is issued; the allowlist is re-checked with the stored `email`/`groups`), `verifyAccessToken → AuthInfo` with `clientId`, `expiresAt`, `resource`, `extra: {email}`; `revokeToken` removes the matching token hash.

- [ ] **Step 1: Write the failing tests** by mounting the SDK's `mcpAuthRouter({provider, issuerUrl, resourceServerUrl})` (loaded with `require` inside the test) plus `oidc.mountWeb(app, {mcp: provider.complete})` in the in-process app and driving it with `fetch`: `register → authorize → mock IdP → callback → code → token` gives a valid access token; `PKCE mismatch is rejected`; `reused code is rejected`; `unknown client_id on /authorize → error page, no redirect`; `unregistered redirect_uri → error page, no redirect`; `registration with http://evil.example redirect is rejected`; `http://127.0.0.1:8765/cb is accepted`; `refresh rotates and the old refresh token fails`; `refresh refused after the user leaves the allowlist`; `revoked access token fails verifyAccessToken`; `expired access token fails`; `disallowed user never gets a code (403 at callback)`.
- [ ] **Step 2: Run** `node test/oauth.js` → Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `oauth_provider.js`. `clientsStore.getClient` / `registerClient` use the store; `registerClient` is synchronous-compatible and returns the client unchanged apart from validation.
- [ ] **Step 4: Run** `node test/oauth.js` → Expected: PASS.
- [ ] **Step 5: Commit** — `git add oauth_provider.js test/oauth.js && git commit -m "feat: OAuth 2.1 authorization server provider for MCP"`

---

### Task 5: Protect `/mcp` — `mcp.js`

**Files:**
- Modify: `mcp.js` (`mount`, `bearerAuth` neighbourhood, lines ~48–60 and ~221–259)
- Modify: `test/oauth.js` (section "mcp")

**Interfaces:**
- Consumes: `provider` from Task 4.
- Produces: `mount(app, config, authProvider?)` — mounts when `config.mcp.token` **or** `authProvider` is set. With `authProvider`: `app.use(mcpAuthRouter({provider, issuerUrl: new URL(config.mcp.oauth.public_url), resourceServerUrl: new URL(public_url + '/mcp')}))` before the `/mcp` routes; `/mcp` middleware accepts the static token (existing constant-time check) **or** `requireBearerAuth({verifier: provider, resourceMetadataUrl, expectedResource})`; failure → 401 with `WWW-Authenticate: Bearer resource_metadata="<url>"` where `<url>` is the protected-resource metadata URL the SDK router actually serves (read it from the installed SDK, do not guess the path). `console.log` of a tool call also logs the token's `extra.email` when present. Static-token-only behaviour is otherwise unchanged.

- [ ] **Step 1: Write the failing tests**: `OAuth token can call tools/list through the SDK client` (`StreamableHTTPClientTransport` with `requestInit.headers.Authorization`); `static token still works`; `no token → 401 with resource_metadata`; `revoked token → 401`; `protected-resource and authorization-server metadata are served`; `token issued for another resource is refused`; `mcp.mount returns false with neither token nor provider`.
- [ ] **Step 2: Run** `node test/oauth.js` → Expected: mcp tests FAIL.
- [ ] **Step 3: Implement** the changes; keep `loadSdk()` the only place the SDK is `require`d (add the `server/auth/router.js` and `middleware/bearerAuth.js` imports there).
- [ ] **Step 4: Run** `node test/oauth.js && node test/mcp.js` → Expected: all PASS (existing MCP tests unchanged).
- [ ] **Step 5: Commit** — `git add mcp.js test/oauth.js && git commit -m "feat: accept OAuth access tokens on /mcp"`

---

### Task 6: Wire into the app, config and docs

**Files:**
- Modify: `start.js` (near lines 61–75 session/mcp mount, 143–200 login, 413–419 `loadUser`)
- Modify: `config.js.example`, `README.md`, `CLAUDE.md`, `.gitignore`, `test/run.js`, `docs/superpowers/specs/2026-10-15-oauth-oidc-design.md`

**Interfaces:**
- Consumes: all of the above. Config added: `exports.oidc`, `exports.mcp.oauth = {public_url, access_ttl, refresh_ttl}`, `exports.auth_db` (default `'auth.sqlite'`).

- [ ] **Step 1: Wire `start.js`.** Build `store`/`oidc`/`provider` once (`auth_store.open(config.auth_db || 'auth.sqlite')` only when `config.oidc` is set); pass `provider` as third argument to `mcp.mount` (before the session middleware, as today); call `oidc.mountWeb(app, {mcp: provider.complete})` right after `app.use(express_session(...))`; do not register `POST /login` when `oidc` is set; in `loadUser`, when `oidc` is set, unauthenticated requests `res.redirect('/login?to=' + encodeURIComponent(req.originalUrl))`. Log each string from `allowlist.problems(config)` at startup. `config.mcp.oauth` without `config.oidc` is a startup error (exit with message).
- [ ] **Step 2: Docs and housekeeping.** Document the new config in `config.js.example` (copy the spec's config block, mark `config.mcp.token` deprecated) and `README.md` (provider setup, callback URL, TLS note); add an "Authentication" subsection to `CLAUDE.md` (module map, request flow, store tables); add `auth.sqlite` to `.gitignore` if `usersRequests.sqlite` is listed there; add `'oauth.js'` to the `scripts` list in `test/run.js` and an `npm run test:oauth` script.
- [ ] **Step 3: Amend the spec** so it matches the build: pending upstream-login state lives in the store (`pending` table), not the session; `config.mcp.oauth` is enabled by its presence (no separate flag) and adds `refresh_ttl` (default 30 days); the callback route is mounted after the session middleware.
- [ ] **Step 4: Run the full suite** `node test/run.js` → Expected: sqlite, drivers, routes, mcp, oauth all PASS (routes still prove the `users.txt` login unchanged with OIDC off).
- [ ] **Step 5: Smoke-run with OIDC on.** Start `start.js` with a temporary config (`DBB_PORT` free port, `DBB_SESSION_MEMORY=1`) whose `oidc` points at a running mock IdP (`node -e` using `test/helpers/mock_oidc.js`); confirm `GET /` redirects to `/login?to=%2F`, the flow lands back on `/`, and `curl -i -X POST /mcp` without a token returns 401 with `resource_metadata`. Report anything not run.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: wire OIDC login and OAuth for MCP into the app"`

---

## Self-Review

- **Spec coverage:** OIDC login (3, 6); allowlist incl. `allow_global_userfile` and fail-closed (2, 6); MCP as protected resource + authorization server, metadata, registration, PKCE, tokens, refresh, revocation (4, 5); SQLite store (1); config/docs/CLAUDE.md (6); testing list (1–5); out-of-scope items untouched. `users.txt` unchanged when OIDC is off and the static token fallback (5, 6).
- **Open items from the spec resolved:** `jose` becomes a direct dependency, loaded lazily via dynamic `import()` because v6 is ESM-only; the SDK's `mcpAuthRouter` / `requireBearerAuth` / `OAuthServerProvider` (1.32.0) are used as-is.
- **Known gap:** `start.js` wiring is verified by the smoke run in Task 6 and by the existing route tests, not by an automated OIDC-on test, because `start.js` loads the fixed `./config.js`.
