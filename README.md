Database browser
================

A lightweight node.js-based web application, targeted towards developer teams. 

Shows the tables, the columns, the indices and other overview details of a database (or several). 
Has a primitive built-in authentication support.

Supports Mysql and Postgresql databases.

Use "npm i" to install prerequisites.


Configuration
-------------

Application expects to find config.js in the server-local directory at start. Configuration
defines domain and port the app will listen on, all the databases it would expose (allow accessing), 
the session storage settings, etc.

Please see config.js.example for details and examples. 

`DBB_CONFIG=/path/to/other-config.js node start.js` loads that file instead of
`./config.js` (a relative path is taken from the current directory).

Starting
--------

    node start.js

Add-ons
-------

Add-ons allow adding features, without rewriting the core app. It is an experiment.

A bundled example lives in `addons/fun/`. Its `show` feature needs the optional
`ect` template engine (`npm install ect`); without it the add-on still loads and
its SQL-template features keep working. `ect` is deliberately not a dependency of
db-browse, since nothing outside this example uses it.


Login with OpenID Connect
-------------------------

Instead of the plaintext `users.txt`, the app can send users to an OpenID
Connect provider (Google Workspace, Okta, Entra ID, Keycloak, ...) and admit
only those on an allowlist. Set `exports.oidc` (see config.js.example):

1. Register the app with the provider as a web application (authorization
   code flow), with the redirect / callback URL `<origin>/oidc/callback`,
   for example `https://dbb.example.com/oidc/callback`. Put the same URL in
   `oidc.redirect_uri`, and the provider's issuer URL, client id and client
   secret in `oidc.issuer`, `oidc.client_id`, `oidc.client_secret`.
2. Fill the allowlist: `allow_emails` (emails, compared case-insensitively),
   `allow_groups`
   (values of the `groups` claim, or of `groups_claim`), and/or
   `allow_global_userfile: true` to admit the emails listed as names in
   `authenticate_userfile` (their passwords are ignored). Any match admits.
   With none of them set everyone is refused, and startup says so. A login
   whose `email_verified` claim is false (`false` or the string `"false"`) is
   refused; a provider that omits the claim is trusted.

With `oidc` set there is no password login: `POST /login` does not exist,
`/login` redirects to the provider, and every page redirects there when the
browser is not signed in. `/logout` ends only the local session. Provider
logins and OAuth state live in `auth.sqlite` (`exports.auth_db`). Needs Node 20
or newer.

Use TLS (a reverse proxy) for anything beyond localhost: the session cookie and
the provider's code travel over this connection. Behind a proxy, also set
`exports.trust_proxy` (for example `1`, the number of proxies; not `true`) so
that `req.ip` is the client's address.


MCP interface (for agents)
--------------------------

Agents can browse the configured databases, read-only, over MCP (streamable
HTTP), at `<origin>/mcp`. There are two ways to authenticate them.

OAuth (recommended), with OIDC login configured as above:

    exports.mcp = { oauth: { public_url: 'https://dbb.example.com' } };

An MCP client that supports OAuth discovers the rest by itself: it gets a 401
pointing at `/.well-known/oauth-protected-resource/mcp`, registers itself
(`/register`), and sends the user through `/authorize` to the OIDC provider.
The same allowlist applies; each client gets its own access token (1 hour,
`access_ttl`) and refresh token (30 days, `refresh_ttl`), revocable at
`/revoke`. `public_url` is the address clients use to reach the app, and must
be just an origin (`https://host[:port]`, no path): the OAuth endpoints and
metadata are served at the root of the host, so the app cannot sit under a
path prefix of a proxy. It must be `https` unless it is `localhost` or
`127.0.0.1`. The OAuth endpoints are rate-limited per client address (per 15
minutes: 100 `/authorize`, 50 `/token`, 50 `/revoke`; 20 `/register` per hour)
— behind a proxy set `trust_proxy`, or all clients share one limit.

Known limitation: there is no consent screen. Anyone can register a client
(`/register` is open) with a redirect URI of their own, and send an
allowlisted user a crafted `/authorize` link. The user sees only the
provider's real login page — or nothing at all, if already signed in there —
and once they complete it, the attacker's client receives a code and then
tokens for that user's identity. That is read access to every configured
database (and the raw `query` tool when `allow_clear_sql` is on) for as long as
the user stays on the allowlist: the refresh token (30 days) rotates on every
use. If that matters, do not enable `mcp.oauth` until a consent step exists,
and watch `auth.sqlite` for unexpected clients.

Revoking MCP access (the app has no UI for it): with the `sqlite3` CLI on the
store (`auth_db`, default `auth.sqlite`),

    sqlite3 auth.sqlite "SELECT client_id, info FROM clients;"
    sqlite3 auth.sqlite "SELECT client_id, email, kind, expires_at FROM tokens;"
    sqlite3 auth.sqlite "DELETE FROM tokens WHERE email = 'ann@example.com';"
    sqlite3 auth.sqlite "DELETE FROM tokens WHERE client_id = '<client id>';"
    sqlite3 auth.sqlite "DELETE FROM clients WHERE client_id = '<client id>';"

Deleting the tokens is what cuts access, at once. Deleting only a `clients`
row does not: existing access tokens are checked without looking the client
up (it does stop that client's refreshes and new logins). Removing a user from
the allowlist instead takes effect for MCP when their access token expires
(`access_ttl`, 1 hour by default) and the next refresh is refused, and for the
web UI when their session ends and they have to log in again.

With `mcp.oauth` on, the paths `/authorize`, `/token`, `/register` and
`/revoke` (and everything under them) belong to OAuth and shadow web-UI
databases with those ids. For confidential clients (those registered with a
secret), the SDK expires the client secret after 30 days, independent of
`refresh_ttl`.

Static token (deprecated; one shared token, no identity):

    exports.mcp = { token: 'a long random string' };

and point the agent at `http://host:port/mcp` with the header
`Authorization: Bearer <token>`. It can be set together with `oauth`, as an
admin fallback.

Tools: `list_databases`, `list_tables`,
`describe_table`, `count_rows`, `column_values`, `browse_rows`, and `query`
(raw read-only SQL; only available when `allow_clear_sql` is on).

Enabling MCP needs Node 20 or newer (the MCP SDK's HTTP server depends on
`@hono/node-server`, which requires it). With neither a token nor `oauth`
configured the SDK is not loaded, and the rest of the app's requirements are unchanged.

Every database in `config.db` is exposed. Read-only is enforced by the database
engine, never by inspecting the SQL: the MCP interface uses its own connections.
SQLite: the file is opened read-only, a statement runs only if SQLite reports it
as read-only (so `VACUUM INTO`, temporary tables and `PRAGMA journal_mode=...`
are refused), and any `ATTACH`ed database is detached after every call.
Postgres and MySQL: each call runs in a read-only transaction; MySQL also sets
the session read-only before every call (for DDL, which MySQL runs after an
implicit commit). MySQL's read-only handling has not been verified against a
real server.

Giving each database entry `readonly_user` / `readonly_password` for a role that
has only SELECT grants is strongly recommended. Without a separate role the
agent connects with the web UI's account, so it can, for example, end the web
UI's connections with Postgres `pg_terminate_backend()` or MySQL `KILL`. Do not
use a superuser (Postgres `COPY ... TO PROGRAM`) or an account with the FILE
privilege (MySQL `SELECT ... INTO OUTFILE`): a read-only transaction does not
stop those.

Notes:

- SQLite and Postgres are tested (`node test/mcp.js`; the Postgres tests run
  when `DBB_TEST_PG_URL=postgres://user@host:port/scratchdb` is set). MySQL
  support is implemented but has not been tested against a real server, so its
  read-only protection (including against DDL such as `DROP TABLE`) is
  unverified; its tests run with
  `DBB_TEST_MYSQL_URL=mysql://user:pass@host:port/scratchdb node test/mcp.js`.
  Run them against a scratch database before relying on MySQL. MariaDB is not
  supported for the statement timeout (it calls the variable `max_statement_time`).
- MySQL session state is shared by all MCP calls to a database (they use one
  connection) and is not undone by the per-call `ROLLBACK`: `SET SESSION ...`
  (`sql_select_limit`, `SET NAMES`, `time_zone`, `sql_mode`), temporary tables
  and `GET_LOCK()` survive, so one agent call can affect later ones. In Postgres
  `SET` is undone, but a session-level `pg_advisory_lock()` also survives.
- Plain HTTP sends the token in the clear; use a TLS proxy unless agents run on
  the same host.
- `/mcp` takes precedence over a database whose id is `mcp`.
- Results are cut to 1000 rows (`max_rows`), after the database has produced
  them; this protects the agent's context, not the server's memory.
- SQLite queries run inside the server process and cannot be timed out: a
  runaway query blocks every request until it finishes.
- The statement timeout (`timeout_ms`): Postgres applies it to every call. MySQL
  re-applies `max_execution_time` on every call, but it limits only SELECT
  statements, a `MAX_EXECUTION_TIME(0)` hint overrides it for one statement, and
  it does not cover other statements such as `DO SLEEP(...)`. SQLite has no
  timeout (above). In addition, a watchdog drops an MCP connection whose
  statement has not returned within the timeout plus a few seconds, so one stuck
  statement cannot wedge MCP for that database for good.
- Postgres: table, column and ordering names given to the structured tools must
  be plain identifiers, optionally schema-qualified (`orders`, `sales.orders`),
  because db_postgres.js does not quote them; quoted or mixed-case names are
  rejected here, although the web UI accepts them (the `query` tool, when
  `allow_clear_sql` is on, can still use them). `list_tables` shows only the
  `public` schema.
- The static token is one shared secret with no per-agent identity; prefer
  OAuth.


JSON support
------------

JSON values (a Postgres `json`/`jsonb` column, say) are rendered as a collapsible
tree with syntax highlighting, and deep or large values start collapsed. A
"raw" link on each cell shows the original indented text, so it can still be
copied, and with JavaScript disabled the cell is the plain indented block it
always was.

`static/js/json-format.js` does this with no dependency and no CDN; only the
tree-building part is shared with the tests (`test/drivers.js`).


Compact row view
----------------

A row listing with a long text or JSON column makes every record tall, so most
of the page is scrolling. The `short values` checkbox in the fixed header — on
by default, remembered in a cookie — shows only the start of such values, and
clicking a cell expands that one value in place: plain text as it is, a JSON
value as the collapsible tree above. The short form keeps
`config.compact_chars` characters (80 by default); set it to 0 to switch the
feature off and hide the checkbox. See [issue 17](issues/17-compact-row-view.md).

`static/js/row-compact.js` does the work; `static/js/json-format.js` builds a
tree only for a value that is actually shown in full.


Query-string filters
--------------------

Both views of a single column take `?column=value` pairs and show only the rows
where every one of them matches:

    /notes2/notes/domain/_ASC?name=NOTNULL      rows with a non-null name
    /notes2/notes/domain?name=README.md         counts of the domains that
                                                hold a README.md

`NOTNULL` means "is not null"; anything else is equality. The filter names are
escaped (MySQL, SQLite) or validated (Postgres) by the driver, and the values
are bound, so a query key can never contribute SQL. The links a page generates —
the view switch, "see more"/"see all", a value drilled into, "show more" on the
grouped page — keep the filters, so the restriction survives navigation. Two
query keys are not filters: `cols` picks the columns of the row view, and on the
grouped page `limit` is the number of groups to show. See
[issue 18](issues/18-query-params-on-column-page.md).


To do
-----

Everything that used to be listed here - the Pug transition (the legacy `view/`
directory is gone), link building, the fixed page layout, JSON support, column
selection, links to referring records, query-string filters and the compact row
view - is done. See `issues/` for what was found along the way, and the
Postgres/MySQL caveats in the MCP notes above.

