# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install       # install dependencies
node start.js     # start the server (requires config.js)
```

No test suite, no linter configured.

## Architecture

Single-process Express 4 app. All routes defined in `start.js`, all handlers in `requestHandlers.js`.

### Request flow

Every DB route runs this middleware chain:

```
prepare_req_params → loadUser → prepare_dbconnection → prepare_locals → [handler]
```

`prepare_dbconnection` resolves the DB connection from the `database` object (module-level cache). Pings with `SELECT NOW()` on reuse; reconnects on failure. Connection stored at `req.params.connect` and `req.dbconnection`.

`prepare_locals` populates `res.locals` with everything templates need: `connection`, `dbType`, `table`, `column`, `value`, `dbId`, `sql`, `user`, breadcrumbs, etc.

### DB abstraction

`db_mysql.js` and `db_postgres.js` expose the same interface:

- `showAllTable(connection, done)`
- `getTableDetails(connection, table, done)`
- `showColumnRequest(connection, column, table, limit, done)`
- `showValueRequest(connection, table, where, order_limit_offset, done)`
- `rowsCounter(connection, table, done)`
- `getSQL(connection, sql, done)`

`getDbType(dbType)` in `requestHandlers.js` selects the right module. MySQL uses `mysql.escapeId()` for identifiers; postgres uses a local `escape()` regex — not a full escaper.

### Two template engines (legacy situation)

- **JUST** — older handlers, templates in `view/*.html`
- **Pug** — newer handlers, templates in `views/*.pug`

`respond()` / `finish()` use JUST. `res.render()` / `finish_pug()` use Pug. When adding new templates, use Pug.

### Caching layer

`cache_wrapper(req, res, handler)` in `requestHandlers.js` wraps handlers that opt in by declaring:

```js
handler.cache_key      = function(req) { return ...; }   // key source
handler.produce_locals = ['key1', 'key2'];               // locals to cache
handler.template       = 'templateName';
handler.pug            = true;                           // optional
handler.cache_ttl      = 600;                            // optional, seconds
```

Cache backend is Memcached (disabled by default via `config.cache = false`). When disabled, `cache_wrapper` calls the handler directly with no overhead.

### SQL history

`sqliteDB.js` manages a local `usersRequests.sqlite` file. The `sql` table stores executed queries with metadata (name, comment, dbid, user, timestamps, use count). Connection is lazy — opened on first use.

### Addon system

`init_addons()` in `start.js` loads modules from `addons/<name>/index.js`. Each addon can expose:

- `a.features` — map of feature-name → Express handler
- `a.sqlt` — map of feature-name → sqlt definition (processed by `sqlt.js`)
- `a.setup(app, config, path)` — arbitrary setup
- `a.init(app, config, path)` — init hook
- `addons/<name>/static/` — served at `/ao/<name>/`, auth-gated at root

`sqlt.js` provides a SQL-template system for addons: templates use `{param}` placeholders, params are typed (`string`, `date`, `int`), queries are parameterized per-driver.

### Config

`config.js` (not in repo — copy from `config.js.example`). Key fields:

```js
exports.listen               // { host, port }
exports.db                   // { [id]: { type, host, user, password, database, ... } }
exports.session_config       // express-session config
exports.authenticate_userfile // path to plaintext user:pass file
exports.authenticate         // custom auth fn(name, pass, done) — alternative to userfile
exports.cache                // bool — enable Memcached
exports.cache_memcached      // 'host:port'
exports.pg_dump_path         // path to pg_dump binary
exports.allow_clear_sql      // bool — enable raw SQL execution feature
exports.addons               // { [name]: { ... } }
```

`db_map` on a DB entry enables cross-table navigation links in row detail views (loaded from YAML, see `sudb_table_index.yml` for example shape).

`table_groups` on a DB entry is a path to a text file grouping tables into named sections in the table list view.
