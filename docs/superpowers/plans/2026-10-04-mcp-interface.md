# MCP Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose db-browse's databases to agents through a read-only MCP server mounted at `/mcp` on the running Express app.

**Architecture:** `mcp_db.js` keeps a cache of dedicated read-only connections (separate from the web UI's), enforcing read-only per driver at the database level and serializing calls per connection. `mcp.js` mounts a stateless streamable-HTTP MCP endpoint behind bearer-token auth and registers seven tools that call the existing `db_*.js` functions on those connections.

**Tech Stack:** Node 22 (SDK needs >=18), Express 4, `@modelcontextprotocol/sdk` 1.x, `zod`, existing `pg` / `mysql2` / `better-sqlite3`.

**Spec:** `docs/superpowers/specs/2026-10-04-mcp-interface-design.md`

## Global Constraints

- Transport is streamable HTTP, mounted in the running Express app at `/mcp`. No stdio entry point.
- Read-only is enforced by the database session/transaction, **never** by parsing SQL.
- Expose every database in `config.db` (no per-database opt-in).
- `/mcp` is mounted only if `config.mcp.token` is set; auth is `Authorization: Bearer <token>`, constant-time compare (`crypto.timingSafeEqual`), failure → 401.
- MCP connections are separate from the web UI's `database` cache in `start.js`.
- `mount()` is called before `express_session` is registered (`start.js:61`).
- Stateless streamable-HTTP mode: fresh server + transport per request, no MCP session ids.
- Tools: `list_databases`, `list_tables`, `describe_table`, `count_rows`, `column_values`, `browse_rows`, `query`. `query` is registered only if `config.allow_clear_sql` is truthy.
- Database errors become MCP tool errors (`isError: true`), never unhandled exceptions.
- Result rows are sliced to 1000 by default after the driver returns, with `truncated: true` when that happens.
- Every call is logged with `console.log` (tool + args, truncated to ~200 chars).
- Never return credentials from any tool.
- New dependencies: only `@modelcontextprotocol/sdk` and `zod`.
- Known limitations are documented, not fixed: SQLite queries block the event loop; the row cap does not bound server memory; the token is static and shared.
- Match surrounding style: `var` and `function` in application code; tests use `'use strict'`, plain `assert`, PASS/FAIL lines.
- Do not modify the user's `config.js` (gitignored, theirs).

---

## File Structure

| File | Responsibility |
|---|---|
| `mcp_db.js` (new) | Read-only connection cache: per-driver read-only enforcement, per-connection queue, error-catching views, `callDb` |
| `mcp.js` (new) | Bearer auth, stateless MCP endpoint, tool registration, `mount(app, config)` |
| `db_sqlite.js` (modify, 1 line) | `createConnection` honours `cc.readonly` |
| `start.js` (modify, 2 lines) | require + call `mcp.mount` before the session middleware |
| `test/mcp.js` (new) | All MCP tests; Postgres/MySQL sections are opt-in via env vars |
| `test/run.js`, `package.json` | Register the new test; add deps and `test:mcp` script |
| `config.js.example`, `README.md`, `CLAUDE.md`, the spec | Documentation |

---

### Task 1: Read-only connection layer, SQLite driver

**Files:**
- Modify: `package.json` (via `npm install`), `db_sqlite.js:10-18`, `test/run.js:6`
- Create: `mcp_db.js`, `test/mcp.js`

**Interfaces:**
- Consumes: `db_sqlite.createConnection(cc)` (existing; gains `cc.readonly`).
- Produces (in `mcp_db.js`, used by Tasks 2-4):
  - `connectionConfig(c) → { host, user, password, database, port }` — `c` is a `config.db[id]` entry; uses `readonly_user`/`readonly_password` when `readonly_user` is set.
  - `wrap(runner, close) → { view(onError) → { query(sql, [params], cb) }, close }` — `runner(sql, params, cb)` executes one read-only statement and calls `cb` with the driver's native argument shape.
  - `getConnection(config, dbId) → Promise<connection>`
  - `callDb(config, dbId, fn) → Promise<result>` — `fn(connection, done)` calls a `db_*.js` function with a read-only connection view; resolves with what that function passes to `done`; rejects on error **or** if the function's callback throws.
- Task 2 adds the `pgDriver` / `mysqlDriver` branches inside `open()`.

- [ ] **Step 1: Install dependencies**

```bash
cd /Users/iku/dev/db-browse
npm install --save @modelcontextprotocol/sdk zod
```
Expected: both added under `dependencies` in `package.json`; `package-lock.json` updated (it is gitignored — fine). Also add the script: in `package.json` `scripts`, after `"test:routes"`, add `"test:mcp": "node test/mcp.js",`.

- [ ] **Step 2: Write the failing tests** — create `test/mcp.js`

```js
// Tests for the MCP interface (mcp_db.js, mcp.js).
// Self-contained: SQLite fixture + an in-process Express app on an ephemeral port.
// Postgres / MySQL sections run only if DBB_TEST_PG_URL / DBB_TEST_MYSQL_URL are set,
// e.g. DBB_TEST_PG_URL=postgres://user:pass@localhost:5432/scratchdb
// (they create and drop a table named mcp_test_items; use a scratch database).

'use strict';
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const Database = require('better-sqlite3');

const mcp_db    = require('../mcp_db.js');
const db_sqlite = require('../db_sqlite.js');

const T = 'mcp_test_items';

let passed = 0;
let failed = 0;

async function ok(label, fn) {
    try {
        await fn();
        console.log('  PASS  ' + label);
        passed++;
    } catch (e) {
        console.log('  FAIL  ' + label);
        console.log('        ' + e.message);
        failed++;
    }
}

// ---- SQLite fixture --------------------------------------------------------

const tmpFile = path.join(os.tmpdir(), 'db-browse-mcp-test-' + Date.now() + '.sqlite');
const attachFile = tmpFile + '.attached';

function makeFixture() {
    const db = new Database(tmpFile);
    db.exec('CREATE TABLE ' + T + ' (id INTEGER PRIMARY KEY, name TEXT)');
    const ins = db.prepare('INSERT INTO ' + T + ' (id, name) VALUES (?, ?)');
    for (let i = 1; i <= 12; i++) ins.run(i, i % 2 ? 'a' : 'b');
    db.close();
}

function countSqlite() {
    const db = new Database(tmpFile, { readonly: true });
    const n = db.prepare('SELECT count(*) AS n FROM ' + T).get().n;
    db.close();
    return n;
}

const sqliteConfig = {
    db: { lite: { type: 'sqlite', database: tmpFile, comment: 'fixture' } },
    mcp: { token: 'secret-token', max_rows: 5 },
    allow_clear_sql: true,
};

// ---- what must hold for every driver --------------------------------------

// Reads work; writes fail; trying to flip the session to read-write does not
// help; and the table is the same afterwards. `count` returns the row count
// via a separate, write-capable connection.
async function readOnlyContract(name, mod, config, dbId, count, bypassAttempts) {
    const sql = (s) => mcp_db.callDb(config, dbId, (c, done) => mod.getSQL(c, s, done));
    const insert = 'INSERT INTO ' + T + " (id, name) VALUES (99, 'x')";
    const before = await count();

    await ok(name + ': SELECT works', async () => {
        const rows = await sql('SELECT id FROM ' + T + ' ORDER BY id');
        assert.ok(Array.isArray(rows) && rows.length >= 1);
    });

    for (const w of [
        insert,
        'UPDATE ' + T + " SET name = 'z'",
        'DELETE FROM ' + T,
        'DROP TABLE ' + T,
        'CREATE TABLE mcp_test_new (id INTEGER)',
    ]) {
        await ok(name + ': rejects  ' + w, async () => { await assert.rejects(sql(w)); });
    }

    await ok(name + ': switching the session to read-write does not help', async () => {
        for (const s of bypassAttempts) {
            try { await sql(s); } catch (e) { /* refusing is fine; allowed is fine if harmless */ }
        }
        await assert.rejects(sql(insert));
    });

    await ok(name + ': table is unchanged afterwards', async () => {
        assert.strictEqual(await count(), before);
    });

    await ok(name + ': count on a missing table fails cleanly (no crash)', async () => {
        await assert.rejects(mcp_db.callDb(config, dbId, (c, done) => mod.rowsCounter(c, 'no_such_table_xyz', done)));
    });
}

// ---- Task 1: connection layer ---------------------------------------------

async function connectionLayerTests() {
    console.log('\n-- mcp_db: connection layer (sqlite) --');
    makeFixture();

    await ok('connectionConfig: uses the normal credentials by default', () => {
        const c = { host: 'h', user: 'u', password: 'p', database: 'd', port: 1, readonly_user: undefined };
        assert.deepStrictEqual(mcp_db.connectionConfig(c),
            { host: 'h', user: 'u', password: 'p', database: 'd', port: 1 });
    });

    await ok('connectionConfig: readonly_user / readonly_password take over when set', () => {
        const cc = mcp_db.connectionConfig({ host: 'h', user: 'u', password: 'p', database: 'd',
                                             readonly_user: 'ro', readonly_password: 'rp' });
        assert.strictEqual(cc.user, 'ro');
        assert.strictEqual(cc.password, 'rp');
    });

    await ok('getConnection: unknown database id rejects', async () => {
        await assert.rejects(mcp_db.getConnection(sqliteConfig, 'nope'), /No such database: nope/);
    });

    await ok('queries on one connection never overlap, and run in order', async () => {
        let active = 0, maxActive = 0;
        const runner = (sql, params, cb) => {
            active++; maxActive = Math.max(maxActive, active);
            setTimeout(() => { active--; cb(null, [sql]); }, 10);
        };
        const view = mcp_db.wrap(runner).view(() => {});
        const results = await Promise.all([1, 2, 3].map((n) =>
            new Promise((res) => view.query('q' + n, (err, rows) => res(rows[0])))));
        assert.deepStrictEqual(results, ['q1', 'q2', 'q3']);
        assert.strictEqual(maxActive, 1);
    });

    await ok('an exception thrown by a db callback goes to onError; the queue keeps going', async () => {
        const runner = (sql, params, cb) => setImmediate(() => cb(null, [sql]));
        let seen = null;
        const view = mcp_db.wrap(runner).view((e) => { seen = e; });
        view.query('boom', () => { throw new Error('kaboom'); });
        const rows = await new Promise((res) => view.query('next', (err, r) => res(r)));
        assert.strictEqual(seen.message, 'kaboom');
        assert.deepStrictEqual(rows, ['next']);
    });

    await ok('callDb: rejects (instead of crashing) when the db function callback throws', async () => {
        await assert.rejects(
            mcp_db.callDb(sqliteConfig, 'lite', (c, done) =>
                c.query('SELECT 1', () => { throw new Error('callback blew up'); })),
            /callback blew up/);
    });

    await readOnlyContract('sqlite', db_sqlite, sqliteConfig, 'lite', async () => countSqlite(), [
        'PRAGMA query_only = OFF',
        "ATTACH DATABASE '" + attachFile + "' AS x",
        'CREATE TABLE x.t (id INTEGER)',
    ]);

    await ok('sqlite: ATTACH cannot be used to create files', () => {
        assert.ok(!fs.existsSync(attachFile));
    });
}

// ---- main ------------------------------------------------------------------

(async () => {
    try {
        await connectionLayerTests();
    } finally {
        for (const f of [tmpFile, attachFile]) { try { fs.unlinkSync(f); } catch (_) {} }
    }
    console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
    process.exit(failed ? 1 : 0);
})();
```

- [ ] **Step 3: Register the test in the runner**

In `test/run.js` change line 6 to:

```js
const scripts = ['sqlite.js', 'routes.js', 'mcp.js'];
```

- [ ] **Step 4: Run to verify it fails**

Run: `node test/mcp.js`
Expected: crash with `Cannot find module '../mcp_db.js'`.

- [ ] **Step 5: Let `db_sqlite.createConnection` open read-only on request**

In `db_sqlite.js` replace

```js
                db = new Database(cc.database);
```
with
```js
                db = new Database(cc.database, { readonly: !!cc.readonly });
```

- [ ] **Step 6: Write `mcp_db.js`**

```js
// Dedicated read-only database connections for the MCP interface.
//
// These are kept apart from the web UI's connection cache in start.js: the web
// UI can run arbitrary SQL on its connections (/:db:sql), so sharing a session
// would let a read-only transaction interleave with a web query.
//
// Read-only is enforced by the database, never by looking at the SQL text:
//   sqlite   - the file is opened read-only
//   postgres - every call runs inside BEGIN READ ONLY ... ROLLBACK
//   mysql    - every call runs inside START TRANSACTION READ ONLY ... ROLLBACK
// (session-wide settings would not do: the caller's own SQL can switch them off)

'use strict';
var pg        = require('pg');
var mysql     = require('mysql2');
var db_sqlite = require('./db_sqlite.js');

var DEFAULT_TIMEOUT_MS = 30000;

var connections = {};   // dbId -> Promise of a connected connection


// Credentials for the MCP connection. If readonly_user is set, use it: a DB
// role with only SELECT grants backs up the transaction-level protection.
function connectionConfig(c) {
    var cc = {
        host    : c.host,
        user    : c.user,
        password: c.password,
        database: c.database,
        port    : c.port
    };
    if (c.readonly_user) {
        cc.user     = c.readonly_user;
        cc.password = c.readonly_password;
    }
    return cc;
}


// Runs one job at a time. A job is function(release) and must call release()
// exactly once when it is finished.
function makeQueue() {
    var pending = [];
    var busy = false;

    function next() {
        if (busy || !pending.length) { return; }
        busy = true;
        pending.shift()(function () {
            busy = false;
            next();
        });
    }

    return function enqueue(job) {
        pending.push(job);
        next();
    };
}


// runner(sql, params, cb) executes ONE statement read-only and calls cb with
// the driver's native arguments, which the db_*.js modules expect:
//   sqlite (err, rows) / postgres (err, result) / mysql (err, rows, fields)
//
// Calls are serialized: the multi-step BEGIN..ROLLBACK sequences must not
// interleave, and e.g. getTableDetails() fires several queries at once.
//
// view(onError) gives one tool call its own handle on the connection. If a
// db_*.js callback throws (rowsCounter() does on a missing table), onError gets
// the exception, instead of it escaping into the driver and killing the process.
function wrap(runner, close) {
    var enqueue = makeQueue();

    return {
        view: function (onError) {
            return {
                query: function (sql, params, cb) {
                    if (typeof params === 'function') {
                        cb = params;
                        params = undefined;
                    }
                    enqueue(function (release) {
                        runner(sql, params, function () {
                            try {
                                cb.apply(null, arguments);
                            } catch (e) {
                                onError(e);
                            } finally {
                                release();
                            }
                        });
                    });
                }
            };
        },
        close: close
    };
}


function sqliteDriver(cc) {
    var conn = db_sqlite.createConnection(Object.assign({}, cc, { readonly: true }));
    return {
        open  : conn.connect,
        runner: function (sql, params, cb) { conn.query(sql, params || [], cb); }
    };
}


function pingSql(type) {
    return (type == 'sqlite') ? 'SELECT 1' : 'SELECT NOW()';
}

function ping(conn, type) {
    return new Promise(function (resolve, reject) {
        conn.view(reject).query(pingSql(type), function (err) {
            if (err) { reject(err); } else { resolve(); }
        });
    });
}


// onLost() is called if the connection dies on its own, so it gets dropped from the cache
function open(config, dbId, onLost) {
    var c = config.db[dbId];
    var cc = connectionConfig(c);
    var timeoutMs = (config.mcp && config.mcp.timeout_ms) || DEFAULT_TIMEOUT_MS;
    var driver;

    if (c.type == 'sqlite') {
        driver = sqliteDriver(cc);
    } else {
        return Promise.reject(new Error("Unsupported database type '" + c.type + "'"));
    }

    var conn = wrap(driver.runner, driver.close);
    return new Promise(function (resolve, reject) {
        driver.open(function (err) {
            if (err) { reject(err); } else { resolve(conn); }
        });
    });
}


function forget(dbId, promise) {
    if (connections[dbId] === promise) { delete connections[dbId]; }
}

// A connected, read-only connection for config.db[dbId]; opened lazily, pinged
// on reuse, reopened if the ping fails.
function getConnection(config, dbId) {
    var c = config.db[dbId];
    if (!c) {
        return Promise.reject(new Error('No such database: ' + dbId));
    }

    var cached = connections[dbId];
    if (cached) {
        var reopen = function () {
            forget(dbId, cached);
            return getConnection(config, dbId);
        };
        return cached.then(function (conn) {
            return ping(conn, c.type).then(function () { return conn; }, function () {
                try { if (conn.close) { conn.close(); } } catch (e) {}
                return reopen();
            });
        }, reopen);
    }

    var p;
    p = open(config, dbId, function () { forget(dbId, p); });
    connections[dbId] = p;
    p.catch(function () { forget(dbId, p); });
    return p;
}


// fn(connection, done) calls a db_*.js function with a read-only connection.
// Resolves with what that function hands to done; rejects on an error, and also
// if one of its callbacks throws.
function callDb(config, dbId, fn) {
    return getConnection(config, dbId).then(function (conn) {
        return new Promise(function (resolve, reject) {
            fn(conn.view(reject), function (err, result) {
                if (err) { reject(err); } else { resolve(result); }
            });
        });
    });
}


exports.connectionConfig = connectionConfig;
exports.wrap             = wrap;       // exported for tests
exports.getConnection    = getConnection;
exports.callDb           = callDb;
```

- [ ] **Step 7: Run to verify it passes**

Run: `node test/mcp.js`
Expected: every line PASS, ending `N passed, 0 failed`, exit 0. If `sqlite: rejects  CREATE TABLE ...` or the ATTACH test fails, read the failure: it shows what the read-only handle actually allows — stop and report rather than loosening the test.

- [ ] **Step 8: Commit**

```bash
git add package.json db_sqlite.js mcp_db.js test/mcp.js test/run.js
git commit -m "add read-only connection layer for MCP (sqlite driver)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Postgres and MySQL read-only drivers

**Files:**
- Modify: `mcp_db.js` (add `pgDriver`, `mysqlDriver`, extend `open()`), `test/mcp.js`

**Interfaces:**
- Consumes: Task 1's `wrap`, `open`, `getConnection`, `callDb`, `readOnlyContract(name, mod, config, dbId, count, bypassAttempts)`, constants `T`, helpers `ok`.
- Produces: `open()` handles `type: 'postgres'` and `type: 'mysql'`. A driver is `{ open(done), runner(sql, params, cb), close() }`.

- [ ] **Step 1: Write the failing tests** — in `test/mcp.js`, add above the `// ---- main` section:

```js
// ---- Task 2: postgres / mysql (opt-in) -------------------------------------

async function postgresTests() {
    console.log('\n-- postgres --');
    const url = process.env.DBB_TEST_PG_URL;
    if (!url) { console.log('  SKIP  set DBB_TEST_PG_URL to run these'); return; }

    const pg = require('pg');
    const db_postgres = require('../db_postgres.js');
    const u = new URL(url);
    const admin = new pg.Client(url);
    await admin.connect();
    await admin.query('DROP TABLE IF EXISTS ' + T);
    await admin.query('CREATE TABLE ' + T + ' (id integer PRIMARY KEY, name text)');
    await admin.query('INSERT INTO ' + T + " VALUES (1,'a'),(2,'b'),(3,'a')");
    const count = async () => Number((await admin.query('SELECT count(*) AS n FROM ' + T)).rows[0].n);

    const config = {
        db: { pgtest: { type: 'postgres', host: u.hostname, port: Number(u.port) || 5432,
                        user: decodeURIComponent(u.username),
                        password: decodeURIComponent(u.password) || undefined,
                        database: u.pathname.slice(1) } },
        mcp: { timeout_ms: 500 },
    };
    const sql = (s) => mcp_db.callDb(config, 'pgtest', (c, done) => db_postgres.getSQL(c, s, done));
    const ins = (id) => 'INSERT INTO ' + T + " VALUES (" + id + ", 'y')";

    try {
        await readOnlyContract('postgres', db_postgres, config, 'pgtest', count, [
            'SET default_transaction_read_only = off',
            'SET TRANSACTION READ WRITE',
            'COMMIT',
            'SELECT 1; ' + ins(98),
            'COMMIT; ' + ins(97),
            'COMMIT; SET default_transaction_read_only = off; ' + ins(96),
            'WITH w AS (' + ins(95) + ' RETURNING 1) SELECT * FROM w',
            "DO $$ BEGIN EXECUTE 'SET TRANSACTION READ WRITE'; " + ins(94) + "; END $$",
        ]);

        await ok('postgres: several commands in one string are refused', async () => {
            await assert.rejects(sql('SELECT 1; SELECT 2'), /multiple commands/);
        });

        await ok('postgres: structured db functions work on the read-only connection', async () => {
            const tables = await mcp_db.callDb(config, 'pgtest', (c, d) => db_postgres.showAllTable(c, d));
            assert.ok(tables.includes(T));
            const details = await mcp_db.callDb(config, 'pgtest', (c, d) => db_postgres.getTableDetails(c, T, d));
            assert.strictEqual(details.length, 6);
            const n = await mcp_db.callDb(config, 'pgtest', (c, d) => db_postgres.rowsCounter(c, T, d));
            assert.strictEqual(Number(n), 3);
            const rows = await mcp_db.callDb(config, 'pgtest', (c, d) =>
                db_postgres.showValueRequest(c, T, { name: 'a' }, { order_by: 'id', direction: 'ASC', limit: 10 }, d));
            assert.strictEqual(rows.length, 2);
        });

        await ok('postgres: the statement timeout cancels a long query', async () => {
            const t0 = Date.now();
            await assert.rejects(sql('SELECT pg_sleep(5)'));
            assert.ok(Date.now() - t0 < 3000, 'took ' + (Date.now() - t0) + 'ms');
        });

        await ok('postgres: the connection is still usable after errors', async () => {
            const rows = await sql('SELECT 1 AS one');
            assert.strictEqual(rows[0].one, 1);
        });
    } finally {
        await admin.query('DROP TABLE IF EXISTS ' + T);
        await admin.end();
    }
}

async function mysqlTests() {
    console.log('\n-- mysql --');
    const url = process.env.DBB_TEST_MYSQL_URL;
    if (!url) { console.log('  SKIP  set DBB_TEST_MYSQL_URL to run these'); return; }

    const mysqlp = require('mysql2/promise');
    const db_mysql = require('../db_mysql.js');
    const u = new URL(url);
    const admin = await mysqlp.createConnection(url);
    await admin.query('DROP TABLE IF EXISTS ' + T);
    await admin.query('CREATE TABLE ' + T + ' (id INT PRIMARY KEY, name VARCHAR(20))');
    await admin.query('INSERT INTO ' + T + " VALUES (1,'a'),(2,'b'),(3,'a')");
    const count = async () => Number((await admin.query('SELECT count(*) AS n FROM ' + T))[0][0].n);

    const config = {
        db: { mytest: { type: 'mysql', host: u.hostname, port: Number(u.port) || 3306,
                        user: decodeURIComponent(u.username),
                        password: decodeURIComponent(u.password) || undefined,
                        database: u.pathname.slice(1) } },
        mcp: { timeout_ms: 500 },
    };
    const sql = (s) => mcp_db.callDb(config, 'mytest', (c, done) => db_mysql.getSQL(c, s, done));
    const ins = (id) => 'INSERT INTO ' + T + " VALUES (" + id + ", 'y')";

    try {
        await readOnlyContract('mysql', db_mysql, config, 'mytest', count, [
            'SET SESSION TRANSACTION READ WRITE',
            'START TRANSACTION READ WRITE',
            'COMMIT',
            'SET autocommit = 1',
            'SELECT 1; ' + ins(98),
        ]);

        await ok('mysql: structured db functions work on the read-only connection', async () => {
            const tables = await mcp_db.callDb(config, 'mytest', (c, d) => db_mysql.showAllTable(c, d));
            assert.ok(tables.includes(T));
            const details = await mcp_db.callDb(config, 'mytest', (c, d) => db_mysql.getTableDetails(c, T, d));
            assert.strictEqual(details.length, 3);
            const n = await mcp_db.callDb(config, 'mytest', (c, d) => db_mysql.rowsCounter(c, T, d));
            assert.strictEqual(Number(n), 3);
            const rows = await mcp_db.callDb(config, 'mytest', (c, d) =>
                db_mysql.showValueRequest(c, T, { name: 'a' }, { order_by: 'id', direction: 'ASC', limit: 10 }, d));
            assert.strictEqual(rows.length, 2);
        });

        await ok('mysql: a long query does not run past the timeout', async () => {
            const t0 = Date.now();
            try { await sql('SELECT SLEEP(5)'); } catch (e) { /* an error is fine too */ }
            assert.ok(Date.now() - t0 < 3000, 'took ' + (Date.now() - t0) + 'ms');
        });

        await ok('mysql: the connection is still usable after errors', async () => {
            const rows = await sql('SELECT 1 AS one');
            assert.strictEqual(rows[0].one, 1);
        });
    } finally {
        await admin.query('DROP TABLE IF EXISTS ' + T);
        await admin.end();
    }
}
```

And in `main`, after `await connectionLayerTests();` add:

```js
        await postgresTests();
        await mysqlTests();
```

- [ ] **Step 2: Start a throwaway local Postgres and run to verify the tests fail**

```bash
PGDIR=$(mktemp -d /private/tmp/claude-501/pgtest.XXXXXX)
initdb -D "$PGDIR" -U dbb --auth=trust >/dev/null
pg_ctl -D "$PGDIR" -o "-p 54329 -k $PGDIR" -l "$PGDIR/log" -w start
createdb -h localhost -p 54329 -U dbb mcptest
echo "$PGDIR" > /private/tmp/claude-501/pgtest.dir
DBB_TEST_PG_URL=postgres://dbb@localhost:54329/mcptest node test/mcp.js
```
Expected: the sqlite section passes; the postgres section FAILs with `Unsupported database type 'postgres'`. (If `initdb` is not on PATH, use `$(brew --prefix postgresql@16)/bin/initdb` or whichever `ls /opt/homebrew/opt | grep postgres` shows.)

- [ ] **Step 3: Add the drivers to `mcp_db.js`**

Add these two functions after `sqliteDriver`:

```js
// Postgres: BEGIN READ ONLY / SET LOCAL statement_timeout / <statement> / ROLLBACK.
// The caller's statement is sent with queryMode 'extended', which makes pg use
// the extended protocol even when there are no parameters; that protocol refuses
// several commands in one string, so nobody can smuggle in "COMMIT; ...".
// (Not the `rows` option: with it pg 8.20 sends no Sync after an error, and the
// connection hangs on the next statement.)
function pgDriver(cc, timeoutMs, onLost) {
    var client = new pg.Client(cc);
    client.on('error', onLost);

    function run(sql, params, cb) {
        client.query('BEGIN READ ONLY', function (err) {
            if (err) { return cb(err); }
            client.query('SET LOCAL statement_timeout = ' + Number(timeoutMs), function (err) {
                if (err) { return finish(err); }
                client.query({ text: sql, values: params || [], queryMode: 'extended' }, finish);
            });
        });

        function finish(err, result) {
            client.query('ROLLBACK', function () { cb(err, result); });
        }
    }

    return {
        open  : function (done) { client.connect(done); },
        runner: run,
        close : function () { client.end(function () {}); }
    };
}

// MySQL: SET SESSION max_execution_time / START TRANSACTION READ ONLY /
// <statement> / ROLLBACK. mysql2 runs one statement per call (multipleStatements
// is off). The timeout is a session variable, which ROLLBACK does not undo and
// the caller's own SQL can change, so it is set again on every call.
function mysqlDriver(cc, timeoutMs, onLost) {
    var conn = mysql.createConnection(cc);
    var warned = false;
    conn.on('error', onLost);

    function run(sql, params, cb) {
        // MariaDB calls this max_statement_time: there the SET fails, the
        // statement runs without a timeout, and we say so once
        conn.query('SET SESSION max_execution_time = ' + Number(timeoutMs), function (err) {
            if (err && !warned) {
                warned = true;
                console.log('MCP: could not apply the statement timeout on a mysql connection: ' + err.message);
            }
            conn.query('START TRANSACTION READ ONLY', function (err) {
                if (err) { return cb(err); }
                var args = params ? [sql, params] : [sql];
                conn.query.apply(conn, args.concat(finish));
            });
        });

        function finish(err, rows, fields) {
            conn.query('ROLLBACK', function () { cb(err, rows, fields); });
        }
    }

    return {
        open  : function (done) { conn.connect(function (err) { done(err); }); },
        runner: run,
        close : function () { conn.end(function () {}); }
    };
}
```

In `open()`, replace

```js
    if (c.type == 'sqlite') {
        driver = sqliteDriver(cc);
    } else {
```
with
```js
    if (c.type == 'postgres') {
        driver = pgDriver(cc, timeoutMs, onLost);
    } else if (c.type == 'mysql') {
        driver = mysqlDriver(cc, timeoutMs, onLost);
    } else if (c.type == 'sqlite') {
        driver = sqliteDriver(cc);
    } else {
```

- [ ] **Step 4: Run Postgres tests**

Run: `DBB_TEST_PG_URL=postgres://dbb@localhost:54329/mcptest node test/mcp.js`
Expected: all PASS, including `postgres: several commands in one string are refused`, `postgres: switching the session to read-write does not help`, and `postgres: table is unchanged afterwards`.

If any fails, **stop and diagnose** (`superpowers:systematic-debugging`) rather than weakening the test. In particular: if `queryMode: 'extended'` does not force the extended protocol, the "several commands" test fails — then switch to a unique `name` per statement plus `DEALLOCATE`, and say so. (Do not use the `rows` option for this: pg 8.20 sends no Sync after a failed statement when `rows` is set, so the connection hangs after the first error. The first version of this plan used it; it was replaced.) These tests are the verification the spec asks for ("Postgres rejects `SET TRANSACTION READ WRITE`…").

- [ ] **Step 5: Run MySQL tests if a server is available**

```bash
docker run -d --rm --name mcp-mysql-test -e MYSQL_ROOT_PASSWORD=t -e MYSQL_DATABASE=mcptest -p 33069:3306 mysql:8
# wait until ready (about 20-30s):
until docker exec mcp-mysql-test mysqladmin ping -uroot -pt --silent 2>/dev/null; do sleep 2; done
DBB_TEST_MYSQL_URL=mysql://root:t@127.0.0.1:33069/mcptest node test/mcp.js
docker stop mcp-mysql-test
```
Expected: all PASS. If Docker is unavailable, skip this step and **report that the MySQL path is unverified** (the section prints SKIP). If DDL (`CREATE TABLE`) is accepted inside the read-only transaction, the contract test fails — diagnose, don't weaken.

- [ ] **Step 6: Stop the throwaway Postgres**

```bash
pg_ctl -D "$(cat /private/tmp/claude-501/pgtest.dir)" -m fast stop
rm -rf "$(cat /private/tmp/claude-501/pgtest.dir)" /private/tmp/claude-501/pgtest.dir
```

- [ ] **Step 7: Commit**

```bash
git add mcp_db.js test/mcp.js
git commit -m "MCP read-only drivers for postgres and mysql" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Auth, endpoint, `list_databases`, wiring into `start.js`

**Files:**
- Create: `mcp.js`
- Modify: `start.js` (near line 24 and after line 59), `test/mcp.js`

**Interfaces:**
- Consumes: `mcp_db` (Task 1/2) — not yet used by tools in this task.
- Produces (in `mcp.js`):
  - `mount(app, config) → boolean` — `false` (and nothing mounted) if `config.mcp.token` is unset.
  - internal `register(server, name, description, shape, fn)` — `shape` is a zod raw shape; `fn(args)` returns a JSON-serializable value or throws; the wrapper logs, serializes to a text content block, and turns exceptions into `isError` results.
  - internal `buildServer(config) → McpServer` — Task 4 adds the other tools here.

- [ ] **Step 1: Write the failing tests** — in `test/mcp.js` add near the top requires:

```js
const express = require('express');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const mcp = require('../mcp.js');
```

and above `// ---- main`:

```js
// ---- Task 3/4: the HTTP endpoint -------------------------------------------

function startApp(config) {
    const app = express();
    const mounted = mcp.mount(app, config);
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () =>
            resolve({ mounted, port: server.address().port, close: () => server.close() }));
    });
}

async function connect(port, token) {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(
        new URL('http://127.0.0.1:' + port + '/mcp'),
        { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    return client;
}

const call = (client, name, args) => client.callTool({ name, arguments: args || {} });
const data = (result) => JSON.parse(result.content[0].text);

async function rawPost(port, headers) {
    return fetch('http://127.0.0.1:' + port + '/mcp', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json',
                                 Accept: 'application/json, text/event-stream' }, headers),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
}

async function endpointTests() {
    console.log('\n-- mcp: endpoint, auth, list_databases --');

    const config = Object.assign({}, sqliteConfig, {
        db: Object.assign({}, sqliteConfig.db, {
            secretdb: { type: 'postgres', host: 'nowhere.invalid', user: 'u', password: 'hunter2', database: 'd' },
        }),
    });
    const app = await startApp(config);

    try {
        await ok('mount() reports it mounted', () => assert.strictEqual(app.mounted, true));

        await ok('no token → 401', async () => {
            const r = await rawPost(app.port, {});
            assert.strictEqual(r.status, 401);
        });

        await ok('wrong token → 401', async () => {
            const r = await rawPost(app.port, { Authorization: 'Bearer nope' });
            assert.strictEqual(r.status, 401);
        });

        await ok('GET with a valid token → 405 (stateless: no SSE stream)', async () => {
            const r = await fetch('http://127.0.0.1:' + app.port + '/mcp',
                { headers: { Authorization: 'Bearer secret-token' } });
            assert.strictEqual(r.status, 405);
        });

        await ok('list_databases: ids, types, comments; never credentials', async () => {
            const client = await connect(app.port, 'secret-token');
            const r = await call(client, 'list_databases');
            const text = r.content[0].text;
            assert.ok(!text.includes('hunter2'));
            assert.ok(!text.includes('nowhere.invalid'));
            const list = data(r);
            assert.deepStrictEqual(list.find((d) => d.id === 'lite'),
                { id: 'lite', type: 'sqlite', comment: 'fixture' });
            assert.deepStrictEqual(list.find((d) => d.id === 'secretdb'),
                { id: 'secretdb', type: 'postgres', comment: null });
            await client.close();
        });
    } finally {
        app.close();
    }

    await ok('no token configured → nothing mounted, /mcp is a 404', async () => {
        const bare = await startApp({ db: {}, mcp: {} });
        try {
            assert.strictEqual(bare.mounted, false);
            const r = await rawPost(bare.port, { Authorization: 'Bearer anything' });
            assert.strictEqual(r.status, 404);
        } finally {
            bare.close();
        }
    });
}
```

and in `main`, after `await mysqlTests();`:

```js
        await endpointTests();
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/mcp.js`
Expected: crash `Cannot find module '../mcp.js'`.

- [ ] **Step 3: Write `mcp.js`**

```js
// MCP (Model Context Protocol) interface: read-only database access for agents.
// Mounted at /mcp by start.js; see docs/superpowers/specs/2026-10-04-mcp-interface-design.md
//
// Streamable HTTP in stateless mode: every request gets a fresh server and
// transport, there are no MCP sessions. The tools hold no state.

'use strict';
var crypto     = require('crypto');
var bodyParser = require('body-parser');
var McpServer  = require('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
var StreamableHTTPServerTransport =
        require('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport;

var pkg = require('./package.json');


function sha256(s) {
    return crypto.createHash('sha256').update(String(s)).digest();
}

// Authorization: Bearer <token>. Both sides are hashed first, so the compare is
// constant-time whatever the lengths.
function bearerAuth(token) {
    var expected = sha256(token);
    return function (req, res, next) {
        var m = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
        if (m && crypto.timingSafeEqual(sha256(m[1]), expected)) {
            return next();
        }
        res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' });
    };
}


function jsonReplacer(key, value) {
    return (typeof value === 'bigint') ? value.toString() : value;
}

function failure(err) {
    return { isError: true, content: [{ type: 'text', text: String((err && err.message) || err) }] };
}

// Registers a tool. fn(args) returns a JSON-serializable value, or throws /
// rejects; the latter becomes a tool error rather than an unhandled exception.
function register(server, name, description, shape, fn) {
    server.registerTool(name, { description: description, inputSchema: shape }, async function (args) {
        console.log('mcp %s %s', name, JSON.stringify(args || {}).slice(0, 200));
        try {
            var value = await fn(args || {});
            return { content: [{ type: 'text', text: JSON.stringify(value, jsonReplacer, 2) }] };
        } catch (e) {
            return failure(e);
        }
    });
}


function buildServer(config) {
    var server = new McpServer({ name: 'db-browse', version: pkg.version });

    register(server, 'list_databases',
        'List the databases available through this server (id, type, comment). ' +
        'Use an id as the `db` argument of the other tools.',
        {},
        async function () {
            return Object.keys(config.db).map(function (id) {
                var c = config.db[id];
                return { id: id, type: c.type, comment: c.comment || null };
            });
        });

    return server;
}


// Returns true if mounted. Needs config.mcp.token; without it nothing is mounted.
function mount(app, config) {
    if (!config.mcp || !config.mcp.token) {
        return false;
    }

    var auth = bearerAuth(config.mcp.token);

    app.post('/mcp', auth, bodyParser.json(), async function (req, res) {
        var server = buildServer(config);
        var transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', function () {
            transport.close();
            server.close();
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (e) {
            console.log('mcp error:', e);
            if (!res.headersSent) {
                res.status(500).json({ jsonrpc: '2.0', id: null,
                                       error: { code: -32603, message: 'Internal server error' } });
            }
        }
    });

    // stateless: no SSE stream (GET) and no session to end (DELETE)
    app.all('/mcp', auth, function (req, res) {
        res.status(405).set('Allow', 'POST').json({
            jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } });
    });

    return true;
}

exports.mount = mount;
```

- [ ] **Step 4: Wire it into `start.js`**

After `var util = require('./util.js');` (line ~24) add:

```js
var mcp = require('./mcp.js');
```

After `app.use(morgan('tiny'));` (line ~59) and before the `// sessions` comment, add:

```js
// MCP interface (a no-op unless config.mcp.token is set). It has to come before
// the session middleware, or every agent request would create a session file.
mcp.mount(app, config);
```

- [ ] **Step 5: Run to verify it passes**

Run: `node test/mcp.js`
Expected: all PASS (Postgres/MySQL SKIP lines are fine).

- [ ] **Step 6: Commit**

```bash
git add mcp.js start.js test/mcp.js
git commit -m "MCP endpoint at /mcp with bearer auth and list_databases" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Browse tools and the `query` tool

**Files:**
- Modify: `mcp.js`, `test/mcp.js`

**Interfaces:**
- Consumes: `register(server, name, description, shape, fn)`, `buildServer(config)` (Task 3); `mcp_db.callDb(config, dbId, fn)` (Task 1); `db_mysql`/`db_postgres`/`db_sqlite` functions `showAllTable(c, done)`, `getTableDetails(c, table, done)`, `rowsCounter(c, table, done)`, `showColumnRequest(c, column, table, limit, done)`, `showValueRequest(c, table, where, {order_by, direction, limit}, done)`, `getSQL(c, sql, done)`.
- Produces: tools `list_tables`, `describe_table`, `count_rows`, `column_values`, `browse_rows`, `query` (the last only if `config.allow_clear_sql`); `config.mcp.max_rows` (default 1000).

Note on `browse_rows`: `order_by` is **required**. `showValueRequest` throws on a missing `order_by` and returns the whole table without a `LIMIT` when no ordering is passed, so a required `order_by` is the safe contract. The string `NOTNULL` as a `where` value means `IS NOT NULL` (that is how the db modules work).

- [ ] **Step 1: Write the failing tests** — add to `test/mcp.js`, above `// ---- main`:

```js
async function toolTests() {
    console.log('\n-- mcp: tools (sqlite) --');
    const app = await startApp(sqliteConfig);
    const client = await connect(app.port, 'secret-token');

    try {
        await ok('tools/list has all seven tools', async () => {
            const names = (await client.listTools()).tools.map((t) => t.name).sort();
            assert.deepStrictEqual(names, ['browse_rows', 'column_values', 'count_rows',
                'describe_table', 'list_databases', 'list_tables', 'query']);
        });

        await ok('list_tables', async () => {
            assert.ok(data(await call(client, 'list_tables', { db: 'lite' })).includes(T));
        });

        await ok('describe_table: labelled parts with the columns', async () => {
            const d = data(await call(client, 'describe_table', { db: 'lite', table: T }));
            assert.deepStrictEqual(d.columns.map((c) => c.column_name), ['id', 'name']);
            assert.ok(d.create_sql);
        });

        await ok('count_rows', async () => {
            assert.deepStrictEqual(data(await call(client, 'count_rows', { db: 'lite', table: T })), { count: 12 });
        });

        await ok('column_values: grouped counts', async () => {
            const rows = data(await call(client, 'column_values', { db: 'lite', table: T, column: 'name' }));
            assert.deepStrictEqual(rows.map((r) => [r.name, r.count]).sort(), [['a', 6], ['b', 6]]);
        });

        await ok('browse_rows: order, direction, limit', async () => {
            const r = data(await call(client, 'browse_rows',
                { db: 'lite', table: T, order_by: 'id', direction: 'DESC', limit: 3 }));
            assert.deepStrictEqual(r.rows.map((x) => x.id), [12, 11, 10]);
            assert.strictEqual(r.truncated, false);
        });

        await ok('browse_rows: where filter and NOTNULL', async () => {
            const a = data(await call(client, 'browse_rows',
                { db: 'lite', table: T, order_by: 'id', where: { name: 'a' }, limit: 5 }));
            assert.deepStrictEqual(a.rows.map((x) => x.id), [1, 3, 5, 7, 9]);
            const nn = data(await call(client, 'browse_rows',
                { db: 'lite', table: T, order_by: 'id', where: { name: 'NOTNULL' }, limit: 2 }));
            assert.strictEqual(nn.rows.length, 2);
        });

        await ok('query: SELECT works; rows are capped with truncated: true', async () => {
            const r = data(await call(client, 'query', { db: 'lite', sql: 'SELECT * FROM ' + T + ' ORDER BY id' }));
            assert.strictEqual(r.rows.length, 5);     // sqliteConfig.mcp.max_rows
            assert.strictEqual(r.row_count, 12);
            assert.strictEqual(r.truncated, true);
        });

        await ok('query: a write is a tool error and changes nothing', async () => {
            const r = await call(client, 'query', { db: 'lite', sql: 'DELETE FROM ' + T });
            assert.strictEqual(r.isError, true);
            assert.strictEqual(countSqlite(), 12);
        });

        await ok('errors are tool errors and the server keeps serving', async () => {
            const bad = await call(client, 'count_rows', { db: 'lite', table: 'no_such_table' });
            assert.strictEqual(bad.isError, true);
            const unknown = await call(client, 'list_tables', { db: 'nope' });
            assert.strictEqual(unknown.isError, true);
            assert.match(unknown.content[0].text, /No such database/);
            assert.ok(data(await call(client, 'list_tables', { db: 'lite' })).includes(T));
        });
    } finally {
        await client.close();
        app.close();
    }

    await ok('query tool is absent when allow_clear_sql is off', async () => {
        const off = await startApp(Object.assign({}, sqliteConfig, { allow_clear_sql: false }));
        const c = await connect(off.port, 'secret-token');
        try {
            const names = (await c.listTools()).tools.map((t) => t.name);
            assert.ok(!names.includes('query'));
            assert.ok(names.includes('browse_rows'));
        } finally {
            await c.close();
            off.close();
        }
    });
}
```

and in `main`, after `await endpointTests();`:

```js
        await toolTests();
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/mcp.js`
Expected: the new tests FAIL (the tools do not exist: `tools/list has all seven tools` fails and the `call(...)` assertions fail).

- [ ] **Step 3: Implement the tools in `mcp.js`**

Add the requires after `var pkg = require('./package.json');`:

```js
var z      = require('zod').z;
var mcp_db = require('./mcp_db.js');

var db_modules = {
    mysql   : require('./db_mysql.js'),
    postgres: require('./db_postgres.js'),
    sqlite  : require('./db_sqlite.js')
};

// getTableDetails() returns an unlabelled array whose order depends on the driver
var DETAIL_NAMES = {
    postgres: ['columns', 'indexes', 'status', 'referenced_by', 'triggers', 'foreign_keys'],
    mysql   : ['columns', 'create_table', 'details'],
    sqlite  : ['columns', 'create_sql']
};

var DEFAULT_MAX_ROWS = 1000;
```

Add these helpers before `buildServer`:

```js
// calls fn(dbModule, connection, done) with a read-only connection for config.db[dbId]
function withDb(config, dbId, fn) {
    var c = config.db[dbId];
    if (!c) { throw new Error('No such database: ' + dbId); }
    var mod = db_modules[c.type];
    if (!mod) { throw new Error("Unsupported database type '" + c.type + "'"); }

    return mcp_db.callDb(config, dbId, function (conn, done) {
        fn(mod, conn, done);
    });
}

// the cap protects the agent's context window; it does not bound server memory
function capRows(rows, max) {
    if (!Array.isArray(rows)) { return { rows: rows, truncated: false }; }
    return { row_count: rows.length, truncated: rows.length > max, rows: rows.slice(0, max) };
}
```

Replace the body of `buildServer` (keep `list_databases`) so it reads:

```js
function buildServer(config) {
    var server = new McpServer({ name: 'db-browse', version: pkg.version });
    var maxRows = (config.mcp && config.mcp.max_rows) || DEFAULT_MAX_ROWS;
    var db = z.string().describe('database id, from list_databases');

    register(server, 'list_databases',
        'List the databases available through this server (id, type, comment). ' +
        'Use an id as the `db` argument of the other tools.',
        {},
        async function () {
            return Object.keys(config.db).map(function (id) {
                var c = config.db[id];
                return { id: id, type: c.type, comment: c.comment || null };
            });
        });

    register(server, 'list_tables',
        'List the tables of a database.',
        { db: db },
        function (a) {
            return withDb(config, a.db, function (mod, conn, done) { mod.showAllTable(conn, done); });
        });

    register(server, 'describe_table',
        'Describe a table: columns, and, depending on the database type, indexes, ' +
        'create statement, foreign keys, triggers and other details.',
        { db: db, table: z.string() },
        function (a) {
            var type = config.db[a.db] && config.db[a.db].type;
            return withDb(config, a.db, function (mod, conn, done) {
                mod.getTableDetails(conn, a.table, done);
            }).then(function (parts) {
                var out = {};
                DETAIL_NAMES[type].forEach(function (name, i) { out[name] = parts[i]; });
                return out;
            });
        });

    register(server, 'count_rows',
        'Count the rows in a table.',
        { db: db, table: z.string() },
        function (a) {
            return withDb(config, a.db, function (mod, conn, done) {
                mod.rowsCounter(conn, a.table, done);
            }).then(function (n) { return { count: Number(n) }; });
        });

    register(server, 'column_values',
        'The most frequent values of a column with their row counts (GROUP BY, most frequent first).',
        { db: db, table: z.string(), column: z.string(),
          limit: z.number().int().min(1).max(maxRows).default(Math.min(50, maxRows)) },
        function (a) {
            return withDb(config, a.db, function (mod, conn, done) {
                mod.showColumnRequest(conn, a.column, a.table, a.limit, done);
            });
        });

    register(server, 'browse_rows',
        'Rows of a table, ordered by a column, optionally filtered by equality on columns. ' +
        'In `where`, the value NOTNULL means "is not null".',
        { db: db, table: z.string(),
          order_by: z.string().describe('column to order by (required)'),
          direction: z.enum(['ASC', 'DESC']).default('ASC'),
          limit: z.number().int().min(1).max(maxRows).default(Math.min(30, maxRows)),
          where: z.record(z.string(), z.string()).optional()
                  .describe('column -> required value; all must match') },
        function (a) {
            var order = { order_by: a.order_by, direction: a.direction, limit: a.limit };
            return withDb(config, a.db, function (mod, conn, done) {
                mod.showValueRequest(conn, a.table, a.where || {}, order, done);
            }).then(function (rows) { return capRows(rows, maxRows); });
        });

    if (config.allow_clear_sql) {
        register(server, 'query',
            'Run read-only SQL (in the database\'s own dialect). Writes fail. ' +
            'At most ' + maxRows + ' rows are returned; `truncated` says if there were more.',
            { db: db, sql: z.string() },
            function (a) {
                return withDb(config, a.db, function (mod, conn, done) {
                    mod.getSQL(conn, a.sql, done);
                }).then(function (rows) { return capRows(rows, maxRows); });
            });
    }

    return server;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test/mcp.js`
Expected: all PASS.

- [ ] **Step 5: Re-run the Postgres suite against a real server through the tools' code paths**

The structured db functions were exercised on Postgres in Task 2, but `describe_table` labelling and `count_rows` on a missing table through the tool layer were not. Repeat the Task 2 Step 2 commands to start the scratch Postgres, then run:

```bash
DBB_TEST_PG_URL=postgres://dbb@localhost:54329/mcptest node test/mcp.js
```
Expected: all PASS. Then stop and remove the scratch Postgres as in Task 2 Step 6.

- [ ] **Step 6: Commit**

```bash
git add mcp.js test/mcp.js
git commit -m "MCP tools: list_tables, describe_table, count_rows, column_values, browse_rows, query" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Documentation, spec amendments, and a smoke test of the real wiring

**Files:**
- Modify: `config.js.example`, `README.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-10-04-mcp-interface-design.md`

**Interfaces:**
- Consumes: everything above. Produces: docs only.

- [ ] **Step 1: `config.js.example`** — after the `exports.addons` comment block at the end of the file, append:

```js

// MCP interface for agents: read-only database access at POST /mcp.
// Off unless a token is set. Agents authenticate with "Authorization: Bearer <token>".
// Use a long random string, and TLS (a reverse proxy) if agents are not on localhost.
/*
exports.mcp = {
    token: 'a long random string',
    // optional: rows returned per call (default 1000)
    //max_rows: 1000,
    // optional: statement timeout, milliseconds (default 30000)
    //timeout_ms: 30000,
};
*/

// For MCP, a database entry above can also carry credentials of a role that has
// only SELECT grants (and is not a superuser / has no FILE privilege):
//   readonly_user: 'dbb_ro', readonly_password: '...',
```

- [ ] **Step 2: `README.md`** — add before the "JSON support" section:

```markdown
MCP interface (for agents)
--------------------------

Agents can browse the configured databases, read-only, over MCP (streamable
HTTP). Set a token in config.js to enable it:

    exports.mcp = { token: 'a long random string' };

and point the agent at `http://host:port/mcp` with the header
`Authorization: Bearer <token>`. Tools: `list_databases`, `list_tables`,
`describe_table`, `count_rows`, `column_values`, `browse_rows`, and `query`
(raw read-only SQL; only available when `allow_clear_sql` is on).

Every database in `config.db` is exposed. Read-only is enforced by the database:
the MCP interface uses its own connections (SQLite: opened read-only; Postgres
and MySQL: each call runs in a read-only transaction). For defence in depth give
a database entry `readonly_user` / `readonly_password` for a role that has only
SELECT grants. Do not use a superuser (Postgres `COPY ... TO PROGRAM`) or an
account with the FILE privilege (MySQL `SELECT ... INTO OUTFILE`): a read-only
transaction does not stop those.

Notes:

- Plain HTTP sends the token in the clear; use a TLS proxy unless agents run on
  the same host.
- `/mcp` takes precedence over a database whose id is `mcp`.
- Results are cut to 1000 rows (`max_rows`), after the database has produced
  them; this protects the agent's context, not the server's memory.
- SQLite queries run inside the server process and cannot be timed out: a
  runaway query blocks every request until it finishes.
- The statement timeout (`timeout_ms`) is best effort; the agent's own SQL can
  change it.
- One shared static token: no per-agent identity.
```

- [ ] **Step 3: `CLAUDE.md`** — in the Architecture section, after "### Caching layer" block and before "### SQL history", add:

```markdown
### MCP interface

`mcp.js` mounts `POST /mcp` (streamable HTTP, stateless) when `config.mcp.token` is set; `start.js` calls `mcp.mount(app, config)` before the session middleware. Tools call the same `db_*.js` functions as the web UI, but on **separate read-only connections** from `mcp_db.js` (not the `database` cache in `start.js`): SQLite opened read-only, Postgres/MySQL via a per-call read-only transaction, calls serialized per connection. `callDb(config, dbId, fn)` also converts exceptions thrown inside `db_*.js` callbacks into rejections. Tests: `node test/mcp.js`; Postgres/MySQL sections need `DBB_TEST_PG_URL` / `DBB_TEST_MYSQL_URL`. Design: `docs/superpowers/specs/2026-10-04-mcp-interface-design.md`.
```

- [ ] **Step 4: Amend the spec** to match what was built — in `docs/superpowers/specs/2026-10-04-mcp-interface-design.md`:

1. In the tools table, change the `browse_rows` arguments to `db, table, order_by, where?, direction?, limit?` and add under the table: "`order_by` is required: `showValueRequest` fails without it and returns the whole table without a `LIMIT` if no ordering is passed."
2. In "Config additions", extend the code block with `// mcp.max_rows (default 1000), mcp.timeout_ms (default 30000)`.
3. In the `mcp_db.js` section, add a paragraph: "`callDb` hands each tool call a *view* of the connection; an exception thrown inside a `db_*.js` callback (e.g. `rowsCounter` on a missing table in the Postgres/MySQL modules) rejects the call instead of escaping into the driver and crashing the process."
4. In the "To verify" paragraph, append: "Verified by the Postgres tests in `test/mcp.js` (see the plan)." — only if Task 2 Step 4 actually passed; otherwise state what was found.
5. Add to "Known limitations": "The statement timeout is best effort — the agent's own SQL can change it. Superusers / FILE-privilege accounts can still write files through `COPY ... TO PROGRAM` / `INTO OUTFILE` (README tells operators to use a plain role)."

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: `sqlite.js`, `routes.js` and `mcp.js` sections all pass (routes.js starts the real server on port 1888 using your `config.js`; stop any running instance first). Importantly `routes.js` passing proves `start.js` still boots with `mcp.js` required and no `config.mcp` set.

- [ ] **Step 6: Smoke-test the real wiring (`start.js` with MCP enabled)**

`config.js` is the user's file and is read from the app directory, so run a copy:

```bash
SP=/private/tmp/claude-501/-Users-iku-dev-db-browse/e299553e-52d9-4ff3-a85e-a2b2d23dbf86/scratchpad
rm -rf $SP/smoke && mkdir -p $SP/smoke
rsync -a --exclude node_modules --exclude config.js --exclude users.txt --exclude usersRequests.sqlite --exclude .git ./ $SP/smoke/
ln -s "$PWD/node_modules" $SP/smoke/node_modules
sqlite3 $SP/smoke/demo.sqlite "create table t(id integer primary key, v text); insert into t(v) values ('x'),('y');"
cat > $SP/smoke/config.js <<EOF
var session = require('express-session');
exports.listen = { host: '127.0.0.1', port: 18999 };
exports.db = { demo: { type: 'sqlite', database: '$SP/smoke/demo.sqlite', comment: 'smoke' } };
exports.session_config = { resave: false, saveUninitialized: true, secret: 's', store: new session.MemoryStore() };
exports.allow_clear_sql = true;
exports.mcp = { token: 'smoke-token' };
EOF
(cd $SP/smoke && node start.js > server.log 2>&1 &) ; sleep 2
# 1. no token -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:18999/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# 2. with token -> tool list
curl -s -X POST http://127.0.0.1:18999/mcp -H 'Authorization: Bearer smoke-token' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400; echo
# 3. a query through the real server
curl -s -X POST http://127.0.0.1:18999/mcp -H 'Authorization: Bearer smoke-token' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"query","arguments":{"db":"demo","sql":"select * from t"}}}' | head -c 400; echo
# 4. the web UI still serves, and MCP calls created no session
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18999/
pkill -f "node start.js" -P 1 2>/dev/null; pkill -f "$SP/smoke" 2>/dev/null; true
```
Expected: `401`; a JSON-RPC tool list naming the seven tools; a result containing `x` and `y`; `200` or a redirect for the web UI. `sqlite3` CLI is on macOS by default; if not, create the fixture with `node -e` and better-sqlite3. After checking, make sure no smoke server is left running (`lsof -i :18999`).

- [ ] **Step 7: Commit**

```bash
git add config.js.example README.md CLAUDE.md docs/superpowers/specs/2026-10-04-mcp-interface-design.md
git commit -m "document the MCP interface; amend spec to match the build" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** HTTP at `/mcp` (T3) · bearer auth, constant-time, 401, not mounted without token (T3) · stateless transport, before session middleware (T3) · dedicated connections separate from web cache (T1) · SQLite/Postgres/MySQL enforcement incl. extended protocol and per-call RO txn (T1/T2) · serialization queue (T1) · `readonly_user`/`readonly_password` (T1 `connectionConfig`, tested; docs T5) · Postgres `SET TRANSACTION READ WRITE` verification (T2 contract, real Postgres) · 7 tools (T3/T4) · `query` gated by `allow_clear_sql` (T4) · errors as `isError` (T3 `register`, T4 tests) · 1000-row cap with `truncated` (T4) · logging (T3 `register`) · config additions + README/example (T5) · tests incl. opt-in PG/MySQL bypass attempts and timeout (T1/T2) · known limitations documented (T5). Gaps found while writing and handled: `browse_rows.order_by` must be required, and callback exceptions would crash the process (new `view(onError)`); both go back into the spec in T5 Step 4.

**Placeholder scan:** none; all code steps contain code.

**Type consistency:** `callDb(config, dbId, fn)`, `wrap(runner, close).view(onError).query`, `connectionConfig`, `register(server, name, description, shape, fn)`, `withDb(config, dbId, fn(mod, conn, done))`, `capRows(rows, max)` are used with the same names and signatures across tasks. Test helpers `startApp`, `connect`, `call`, `data`, `rawPost`, `readOnlyContract`, constant `T` are defined before use.
