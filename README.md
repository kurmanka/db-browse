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


MCP interface (for agents)
--------------------------

Agents can browse the configured databases, read-only, over MCP (streamable
HTTP). Set a token in config.js to enable it:

    exports.mcp = { token: 'a long random string' };

and point the agent at `http://host:port/mcp` with the header
`Authorization: Bearer <token>`. Tools: `list_databases`, `list_tables`,
`describe_table`, `count_rows`, `column_values`, `browse_rows`, and `query`
(raw read-only SQL; only available when `allow_clear_sql` is on).

Enabling MCP needs Node 20 or newer (the MCP SDK's HTTP server depends on
`@hono/node-server`, which requires it). With no token configured the SDK is
not loaded, and the rest of the app's requirements are unchanged.

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
- One shared static token: no per-agent identity.


JSON support
------------

Currently, the JSON values in a database are output in an indented form, but with no syntax highlighting 
or anything on top. Would be great to add JSON folding/unfolding support to that, e.g. with 
https://github.com/pgrabovets/json-view or https://github.com/mohsen1/json-formatter-js


To do
-----

These are some of the things I'd like to do:

* fix URL building in links properly; e.g. horizontal / vertical links don't take possible query params into account
* fix page layout — the top and the bottom should be fixed, non-scrollable
* add JSON support
* add selecting columns for view in /:db/:table/:column/:value
* add links for referring records — to find records pointing to this one. 
    e.g. when looking at a product, find all documents refering to this product or 
    when looking at a company, find all products of that company (the reverse 
    of foreign key `references` relation) 