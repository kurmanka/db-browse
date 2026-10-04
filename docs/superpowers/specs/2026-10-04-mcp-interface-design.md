# MCP interface for db-browse — design

Date: 2026-10-04
Status: implemented; amended to match the build

## Goal

Let agents use db-browse for **read-only** database access through an MCP
server, without changing the existing web UI or its handlers.

## Decisions

| Question | Decision |
|---|---|
| Transport | Streamable HTTP, mounted in the running Express app at `/mcp`. No stdio entry point. |
| Query scope | Structured browse tools **and** a read-only raw SQL tool. |
| Exposure | Every database in `config.db`. No per-database opt-in. |
| Read-only enforcement | Dedicated MCP connections, read-only enforced by the database session/transaction. Never by parsing SQL. |
| Auth | Static bearer token from `config.mcp.token`. Route not mounted if unset. |

## Components

### `mcp_db.js` — dedicated read-only connections

Returns a connection per `dbId`, cached and lazily opened, with the same
ping-and-reconnect behaviour as `prepare_dbconnection` in `start.js`. It is
**separate from the web UI's `database` cache**, so MCP and web traffic never
share a session. (The web UI runs arbitrary SQL on its connections through
`/:db:sql`; sharing a session would let a read-only transaction interleave
with a web query.)

The connection object exposes the same `connect(done)` / `query(sql, [params], done)`
shape as the rest of the app, so the existing `db_*.js` functions run on it
unchanged. Read-only is enforced inside `.query()` itself, so every tool,
structured or raw, is covered:

| Driver | Enforcement |
|---|---|
| SQLite | Open with `readonly: true`. That alone is not enough (such a handle can still run `VACUUM INTO '<file>'`, create temp tables, and `ATTACH` any SQLite file the process can read), so on a read-only connection `db_sqlite.js` also: refuses every statement for which SQLite's own `sqlite3_stmt_readonly()` (better-sqlite3 `stmt.readonly`) is false — `VACUUM INTO`, `CREATE TEMP ...`, `PRAGMA journal_mode=...`; and after every statement, failed or not, detaches every schema other than `main`/`temp`, so an `ATTACH` (always its own call: better-sqlite3 refuses several statements in one string) is gone before the next call. If detaching fails the handle is closed and reopened on the next call. The web UI never sets `readonly` and is unaffected. |
| Postgres | Each call: `BEGIN READ ONLY` → `SET LOCAL statement_timeout` → query → `ROLLBACK`. The caller's statement is sent via the extended protocol (`queryMode: 'extended'`), which rejects multi-command strings (closes `COMMIT; BEGIN READ WRITE; ...`). The `rows` query option must not be used for this: pg 8.20 sends no Sync after a failed statement when it is set, and the connection hangs. |
| MySQL | Each call: `SET SESSION max_execution_time` → `SET SESSION TRANSACTION READ ONLY` → `START TRANSACTION READ ONLY` → query → `ROLLBACK`. The timeout is a session variable that survives `ROLLBACK` and that the agent's own SQL could switch off, so it is applied on every call; a failure to set it logs a warning once per connection (MariaDB calls the variable `max_statement_time`, so there the timeout is not applied). The session-level `READ ONLY` is for DDL (`DROP`, `TRUNCATE`, `CREATE`, `ALTER`, `RENAME`, `GRANT`, `CREATE USER`, `LOCK TABLES`): MySQL implicitly commits the open transaction before such a statement, so the read-only transaction probably does not cover it, and `ROLLBACK` cannot undo DDL; the session default should. It is set again on every call, and a failure to set it fails the call. **Unverified: none of this has been run against a real MySQL server.** mysql2 runs a single statement per call (`multipleStatements` off). |

Session-level settings alone (`default_transaction_read_only`,
`SET SESSION TRANSACTION READ ONLY`) are **not** relied on: the agent's own SQL
can switch them off. (MySQL sets the session one again before every call, in
addition to the transaction.)

**Watchdog.** The per-connection queue is strictly serial, so a statement that
never returns would stall every later call to that database. `wrap(runner,
close, timeoutMs)` fails a call whose statement has not answered within
`timeout_ms` plus a 5 s grace (`STUCK_GRACE_MS`), closes the connection hard
(pg: destroys the socket; mysql2: `destroy()` and the socket), drops it from the
cache so the next call opens a new one, lets the queue move on, and ignores the
dead statement's late answer. SQLite is synchronous and cannot get stuck this
way (it has no timeout either; see Known limitations).

`callDb` hands each tool call a *view* of the connection; an exception thrown inside a `db_*.js` callback (e.g. `rowsCounter` on a missing table in the Postgres/MySQL modules) rejects the call instead of escaping into the driver and crashing the process.

The database id is untrusted agent input, so `getConnection` only resolves ids that `config.db` defines itself (inherited names such as `constructor` or `__proto__` are "No such database").

The wrapper serializes calls through a per-connection queue, so the multi-step
sequences above cannot interleave (e.g. `getTableDetails` issues several
queries at once).

**Optional hardening.** If a database entry sets `readonly_user` /
`readonly_password`, the MCP connection uses those credentials instead of
`user` / `password`. A DB role with only `SELECT` grants then backs up the
session-level protection. Off by default; strongly recommended in the README
(without it, an agent's `pg_terminate_backend()` / MySQL `KILL` can also end
the web UI's connections, which use the same account).

**To verify, not assume:** that Postgres rejects `SET TRANSACTION READ WRITE`
inside an already read-only transaction. Covered by a test (below) that must
pass against a real Postgres before the Postgres path is considered done.
Verified: the Postgres tests in `test/mcp.js` (see the plan) passed against a
real PostgreSQL 14 server, including the bypass attempts. The MySQL tests did
**not** run: no MySQL server was available, so the MySQL driver is implemented
but untested against a real server.

### `mcp.js` — tools, auth, mounting

`mount(app, config)` is called once from `start.js`, **before**
`express_session` is registered (`start.js:61`); otherwise each agent request
creates a session file (`saveUninitialized: true`). It does nothing if
`config.mcp.token` is unset.

Uses `@modelcontextprotocol/sdk` streamable-HTTP transport in **stateless
mode**: a fresh server + transport per request, no MCP session ids. Tools hold
no state.

**Auth.** `Authorization: Bearer <token>`, compared in constant time
(`crypto.timingSafeEqual`). Failure → 401. Independent of the web login. The
token travels in clear over plain HTTP; fine for the default `localhost`
listen address, otherwise put it behind a TLS proxy (README note).

**Tools** (`db` is always a key of `config.db`):

| Tool | Arguments | Backed by |
|---|---|---|
| `list_databases` | — | `config.db`: id, type, comment. Never credentials. |
| `list_tables` | `db` | `showAllTable` |
| `describe_table` | `db, table` | `getTableDetails`, returned as labelled parts per driver: postgres `columns, indexes, status, referenced_by, triggers, foreign_keys`; mysql `columns, create_table, details`; sqlite `columns, create_sql` |
| `count_rows` | `db, table` | `rowsCounter` |
| `column_values` | `db, table, column, limit?` | `showColumnRequest` |
| `browse_rows` | `db, table, order_by, where?, direction?, limit?` | `showValueRequest` |
| `query` | `db, sql` | `getSQL` |

`order_by` is required: `showValueRequest` fails without it and returns the whole table without a `LIMIT` if no ordering is passed.

- `query` is registered only if `config.allow_clear_sql` is truthy, so MCP does
  not bypass the operator's switch for raw SQL in the web UI.
- Database errors are returned as MCP tool errors (`isError: true` with the
  database's message), never as an unhandled exception.
- Result rows are sliced to 1000 (default) after the driver returns; the
  response includes `truncated: true` when that happens. This protects the
  agent's context window; it does **not** bound server memory (see below).
- Every call is logged with `console.log`: tool, db, and SQL truncated to ~200
  chars.
- The weak Postgres `escape()` in the structured functions adds no exposure
  *only when `query` is available*; see "Identifier handling" below.

**Identifier handling.** `db_postgres.js` never quotes identifiers, so a table,
column or `order_by` given to a structured tool would be spliced into SQL as it
is, letting an agent run arbitrary read expressions even with `allow_clear_sql`
off. `checkIdentifiers` in `mcp.js` therefore rejects, for Postgres, any
`table`, `column`, `order_by` or `where` key that is not a simple identifier,
optionally schema-qualified (`/^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/`).
Quoted or mixed-case Postgres names are rejected by the structured tools, even
though the web UI accepts them (its `escape()` leaves `"` alone); with
`allow_clear_sql` on, `query` can still be used for such tables. `list_tables`
shows only the `public` schema, as the existing module does. SQLite and MySQL quote properly
(`escapeId` in `db_sqlite.js`, `mysql.escapeId` in `db_mysql.js`).
The database id is validated the same way as in `mcp_db.js`: `dbEntry(config, id)`
accepts only ids `config.db` defines itself.

### Config additions

```js
exports.mcp = { token: 'long random string' };   // enables /mcp

// optional: mcp.max_rows (default 1000), mcp.timeout_ms (default 30000)

// per database, optional:
//   readonly_user: '...', readonly_password: '...'
```

`config.js.example` and `README.md` get matching documentation.

### Dependencies

`@modelcontextprotocol/sdk` and its peer `zod`. Both are loaded only in
`mount()` once a token is configured: the SDK's streamable-HTTP server depends
on `@hono/node-server`, which declares Node >= 20, and the rest of the app must
keep starting on older Node versions with MCP off.

## Testing

New `test/mcp.js`, added to `test/run.js`, in the style of the existing tests
(plain `assert`, PASS/FAIL lines). Self-contained: builds a temp SQLite file,
mounts MCP on a bare Express app with a fake config on an ephemeral port, and
talks to it with the SDK's client over streamable HTTP.

SQLite, always run:
- 401 without a token or with a wrong token; success with the right one.
- `/mcp` not mounted when `config.mcp.token` is unset.
- `list_databases` returns id/type/comment and no credentials.
- `list_tables`, `describe_table`, `count_rows`, `column_values`, `browse_rows`
  return expected data.
- `query` runs a `SELECT`; `INSERT`, `UPDATE`, `DROP TABLE`, and `ATTACH`-based
  writes are rejected and the file is unchanged afterwards. `VACUUM INTO` is
  rejected and writes no file; `CREATE TEMP TABLE` / `VIEW` are rejected; an
  `ATTACH`ed database is gone in the next call.
- The watchdog (fake runners, a fake mysql2 connection, and opt-in against a
  real Postgres), the MySQL driver's statement sequence (fake mysql2), MySQL
  `NOTNULL` where-key quoting, and that the SDK is not loaded without a token.
- Result truncation sets `truncated: true`.
- `query` absent from the tool list when `allow_clear_sql` is false.
- A failing query returns `isError: true` and the server keeps serving.

Postgres and MySQL, **opt-in** via env vars holding a test DSN (skipped with a
notice otherwise):
- Writes rejected through `query`.
- Bypass attempts rejected: `SET default_transaction_read_only = off` followed
  by a write; `COMMIT; DROP TABLE ...` as one string; `SET TRANSACTION READ WRITE`
  (Postgres); `SET SESSION TRANSACTION READ WRITE` (MySQL).
- Statement timeout cancels a long-running query (`pg_sleep` / `SLEEP`).

## Known limitations (not addressed now)

- **SQLite blocks the server.** `better-sqlite3` is synchronous and in-process,
  and has no timeout, so a runaway agent query (e.g. a large cross join) freezes
  the web UI and all other requests. Later option: run MCP SQLite queries in a
  `worker_threads` worker that the main thread terminates on timeout.
- **Row cap does not bound memory.** Rows are sliced after the driver has
  materialized the full result. Later option: driver-native streaming
  (`iterate()` for SQLite, mysql2 stream, `pg-cursor` for Postgres).
- **Static shared token**, no per-agent identity or revocation beyond changing
  the config and restarting.
- **The statement timeout is best effort.** Postgres applies it with
  `SET LOCAL` per call; the timer is armed when the statement starts, so the
  statement cannot switch it off for itself. MySQL re-applies
  `max_execution_time` per call, but it limits only `SELECT` statements, a
  `/*+ MAX_EXECUTION_TIME(0) */` hint overrides it for one statement, and it does
  not cover non-SELECT statements such as `DO SLEEP(...)`. It does not apply to
  SQLite, and MariaDB is not supported for it. The watchdog (see `mcp_db.js`)
  drops a connection whose statement has not returned within the timeout plus a
  few seconds, so such a statement cannot wedge MCP for that database for good.
  Superusers / FILE-privilege accounts can still write files through
  `COPY ... TO PROGRAM` / `INTO OUTFILE` (README tells operators to use a plain
  role).
- **MySQL session state persists across agent calls.** All MCP calls to a
  database share one cached connection. In MySQL, `SET SESSION ...`
  (`sql_select_limit`, `SET NAMES`, `time_zone`, `sql_mode`), user variables,
  `CREATE TEMPORARY TABLE` (allowed in a read-only transaction; a temporary
  table can shadow a real one) and `GET_LOCK()` are not undone by `ROLLBACK`, so
  one agent call can affect every later MCP call to that database. Postgres
  `SET` is transactional and undone, but a session-level `pg_advisory_lock()`
  also survives `ROLLBACK`. Not addressed; a separate `readonly_user` role
  limits the damage.
- **MySQL is untested against a real server**, including the read-only
  protection against DDL. Run `DBB_TEST_MYSQL_URL=mysql://user:pass@host:port/scratchdb node test/mcp.js`
  against a scratch database before relying on it.
- **Postgres names are restricted** to plain, optionally schema-qualified
  identifiers in the structured tools (see "Identifier handling"), and
  `list_tables` shows only `public`. MCP is stricter than the web UI here: quoted
  or mixed-case names work in the web UI but are rejected by the MCP structured
  tools (`query` can still reach them when `allow_clear_sql` is on). A possible
  follow-up: accept double-quoted identifiers that contain none of `'`, `;`,
  `,`, `%`.

## Out of scope

Write access, stdio transport, per-database exposure opt-in, MCP resources or
prompts, MCP sessions.
