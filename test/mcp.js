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
const express = require('express');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const mcp_db    = require('../mcp_db.js');
const db_sqlite = require('../db_sqlite.js');
const mcp       = require('../mcp.js');

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
const vacuumFile = tmpFile + '.vacuum';
const otherFile  = tmpFile + '.other';

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

    for (const id of ['constructor', 'toString', '__proto__']) {
        await ok('getConnection: inherited property name "' + id + '" rejects (does not throw)', async () => {
            await assert.rejects(mcp_db.getConnection(sqliteConfig, id), /No such database/);
        });
        await ok('callDb: inherited property name "' + id + '" rejects (does not throw)', async () => {
            await assert.rejects(mcp_db.callDb(sqliteConfig, id, (c, done) => done(null, [])), /No such database/);
        });
    }

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

    await ok('watchdog: a stuck statement fails, the connection is closed once, the queue moves on', async () => {
        mcp_db.setStuckGraceMs(10);
        try {
            let late = null, closed = 0;
            const runner = (sql, params, cb) => {
                if (sql === 'stuck') { late = () => cb(null, ['late']); return; }
                setTimeout(() => cb(null, [sql]), 5);
            };
            const view = mcp_db.wrap(runner, () => { closed++; }, 20).view(() => {});
            const stuckCalls = [];
            const t0 = Date.now();
            const failed = new Promise((res) => view.query('stuck', function () {
                stuckCalls.push(Array.from(arguments)); res();
            }));
            const next = new Promise((res) => view.query('next', (err, rows) => res(rows)));
            await failed;
            assert.ok(Date.now() - t0 < 1000, 'took ' + (Date.now() - t0) + 'ms');
            assert.match(stuckCalls[0][0].message, /did not return in time; connection dropped/);
            assert.deepStrictEqual(await next, ['next']);
            assert.strictEqual(closed, 1);

            late();                      // the dead runner answers after all
            const after = await new Promise((res) => view.query('after', (err, rows) => res(rows)));
            assert.deepStrictEqual(after, ['after']);
            assert.strictEqual(stuckCalls.length, 1);
            assert.strictEqual(closed, 1);
        } finally {
            mcp_db.setStuckGraceMs();
        }
    });

    await ok('watchdog: a late answer does not release the queue a second time', async () => {
        mcp_db.setStuckGraceMs(10);
        try {
            let late = null, active = 0, maxActive = 0;
            const runner = (sql, params, cb) => {
                if (sql === 'stuck') { late = () => cb(null, []); return; }
                active++; maxActive = Math.max(maxActive, active);
                setTimeout(() => { active--; cb(null, [sql]); }, 20);
            };
            const view = mcp_db.wrap(runner, () => {}, 20).view(() => {});
            await new Promise((res) => view.query('stuck', res));
            const a = new Promise((res) => view.query('a', (e, r) => res(r)));
            const b = new Promise((res) => view.query('b', (e, r) => res(r)));
            late();                      // while 'a' runs: must not start 'b' early
            assert.deepStrictEqual([await a, await b], [['a'], ['b']]);
            assert.strictEqual(maxActive, 1);
        } finally {
            mcp_db.setStuckGraceMs();
        }
    });

    await ok('watchdog: off without a timeout; a statement that answers in time is not affected', async () => {
        mcp_db.setStuckGraceMs(10);
        try {
            let closed = 0;
            const runner = (sql, params, cb) => setTimeout(() => cb(null, [sql]), 60);
            const noTimeout = mcp_db.wrap(runner, () => { closed++; }).view(() => {});
            assert.deepStrictEqual(await new Promise((res) => noTimeout.query('slow', (e, r) => res(r))), ['slow']);
            const inTime = mcp_db.wrap(runner, () => { closed++; }, 200).view(() => {});
            assert.deepStrictEqual(await new Promise((res) => inTime.query('ok', (e, r) => res(r))), ['ok']);
            assert.strictEqual(closed, 0);
        } finally {
            mcp_db.setStuckGraceMs();
        }
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

    const lite = (s) => mcp_db.callDb(sqliteConfig, 'lite', (c, done) => db_sqlite.getSQL(c, s, done));

    await ok('sqlite: VACUUM INTO is refused and creates no file', async () => {
        await assert.rejects(lite("VACUUM INTO '" + vacuumFile + "'"));
        assert.ok(!fs.existsSync(vacuumFile), 'VACUUM INTO wrote ' + vacuumFile);
    });

    await ok('sqlite: an ATTACHed database is detached before the next call', async () => {
        const o = new Database(otherFile);
        o.exec('CREATE TABLE other_secret (v TEXT)');
        o.close();
        try { await lite("ATTACH DATABASE '" + otherFile + "' AS x"); } catch (e) { /* refusing is fine too */ }
        await assert.rejects(lite('SELECT * FROM x.other_secret'), /no such table/);
    });

    for (const s of ['CREATE TEMP TABLE t (x)', 'CREATE TEMP VIEW v AS SELECT 1', 'PRAGMA journal_mode = WAL']) {
        await ok('sqlite: rejects  ' + s, async () => { await assert.rejects(lite(s)); });
    }

    await ok('sqlite: a plain SELECT still works afterwards', async () => {
        const rows = await lite('SELECT count(*) AS n FROM ' + T);
        assert.strictEqual(rows[0].n, 12);
    });

    await ok('sqlite: a connection without readonly (the web UI) is not restricted', async () => {
        const conn = db_sqlite.createConnection({ database: otherFile });
        await new Promise((res, rej) => conn.connect((e) => e ? rej(e) : res()));
        await new Promise((res, rej) => conn.query('CREATE TEMP TABLE t (x)', (e) => e ? rej(e) : res()));
        await new Promise((res, rej) => conn.query('INSERT INTO other_secret VALUES (?)', ['w'], (e) => e ? rej(e) : res()));
    });
}

// ---- mysql driver, with a stand-in for mysql2 (no server) -----------------

// A fake mysql2 connection: records every statement sent; reply(sql) decides the
// answer (undefined: success, an Error: failure, 'hang': never answers).
// Installed by swapping mysql2.createConnection while fn runs.
async function withFakeMysql(reply, fn) {
    const mysql2 = require('mysql2');
    const sent = [];
    const conn = {
        created: 0,
        destroyed: 0,
        on() {},
        connect(cb) { cb(null); },
        end(cb) { if (cb) cb(); },
        destroy() { conn.destroyed++; },
        query(sql, ...rest) {
            const cb = rest.pop();
            sent.push(sql);
            const r = reply(sql);
            if (r === 'hang') return;
            setImmediate(() => (r instanceof Error) ? cb(r) : cb(null, [{ sql }], []));
        },
    };
    const orig = mysql2.createConnection;
    mysql2.createConnection = () => { conn.created++; return conn; };
    try { return await fn(conn, sent); } finally { mysql2.createConnection = orig; }
}

let fakeIds = 0;
const fakeMysqlConfig = () => {
    const id = 'fakemysql' + (++fakeIds);
    return { id, config: { db: { [id]: { type: 'mysql', host: 'fake' } }, mcp: { timeout_ms: 500 } } };
};

// runs one statement on a fresh connection; resolves with every callback call
// made within 30ms (so a second call would show up)
async function oneCall(f, sql) {
    const conn = await mcp_db.getConnection(f.config, f.id);
    const calls = [];
    conn.view(() => {}).query(sql, function () { calls.push(Array.from(arguments)); });
    await new Promise((res) => setTimeout(res, 30));
    return calls;
}

async function mysqlDriverTests() {
    console.log('\n-- mcp_db: mysql driver (fake mysql2, no server) --');
    const SET_RO = 'SET SESSION TRANSACTION READ ONLY';
    const START  = 'START TRANSACTION READ ONLY';

    await ok('mysql driver: every call sets the session read-only, then runs in a read-only transaction', async () => {
        await withFakeMysql(() => undefined, async (conn, sent) => {
            const f = fakeMysqlConfig();
            const calls = await oneCall(f, 'SELECT 1');
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0][0], null);
            assert.deepStrictEqual(sent, ['SET SESSION max_execution_time = 500', SET_RO, START, 'SELECT 1', 'ROLLBACK']);
            // and again on reuse (the ping is a call too)
            sent.length = 0;
            await mcp_db.callDb(f.config, f.id, (c, done) => c.query('SELECT 2', done));
            assert.deepStrictEqual(sent.filter((s) => s === SET_RO).length, 2);
            sent.forEach((s, i) => { if (s === START) assert.strictEqual(sent[i - 1], SET_RO); });
        });
    });

    for (const failing of [SET_RO, START, 'SELECT 1']) {
        await ok('mysql driver: if "' + failing + '" fails, the call fails once and nothing runs after it but ROLLBACK', async () => {
            await withFakeMysql((s) => s === failing ? new Error('refused: ' + s) : undefined, async (conn, sent) => {
                const calls = await oneCall(fakeMysqlConfig(), 'SELECT 1');
                assert.strictEqual(calls.length, 1);
                assert.strictEqual(calls[0][0].message, 'refused: ' + failing);
                const rest = sent.slice(sent.indexOf(failing) + 1);
                assert.ok(rest.every((s) => s === 'ROLLBACK'), 'sent after the failure: ' + rest.join(' | '));
                if (failing !== 'SELECT 1') assert.ok(!sent.includes('SELECT 1'));
            });
        });
    }

    await ok('mysql driver: a failing timeout SET is not fatal (MariaDB)', async () => {
        await withFakeMysql((s) => /max_execution_time/.test(s) ? new Error('unknown variable') : undefined,
            async (conn, sent) => {
                const calls = await oneCall(fakeMysqlConfig(), 'SELECT 1');
                assert.strictEqual(calls.length, 1);
                assert.strictEqual(calls[0][0], null);
                assert.ok(sent.includes('SELECT 1'));
            });
    });

    await ok('watchdog: a stuck mysql statement drops the connection; the next call opens a new one', async () => {
        mcp_db.setStuckGraceMs(10);
        try {
            await withFakeMysql((s) => s === 'SELECT forever' ? 'hang' : undefined, async (conn, sent) => {
                const f = fakeMysqlConfig();
                f.config.mcp.timeout_ms = 20;
                await assert.rejects(mcp_db.callDb(f.config, f.id, (c, done) => c.query('SELECT forever', done)),
                    /did not return in time; connection dropped/);
                assert.strictEqual(conn.destroyed, 1);
                sent.length = 0;
                await mcp_db.callDb(f.config, f.id, (c, done) => c.query('SELECT 1', done));
                assert.strictEqual(conn.created, 2, 'a new connection was opened');
                assert.ok(!sent.includes('SELECT NOW()'), 'the dropped connection was not reused');
            });
        } finally {
            mcp_db.setStuckGraceMs();
        }
    });

    await ok('db_mysql: NOTNULL where-keys are quoted with escapeId', async () => {
        const db_mysql = require('../db_mysql.js');
        let seen = null;
        const fake = { query(sql, values, cb) { seen = sql; cb(null, []); } };
        await new Promise((res) => db_mysql.showValueRequest(fake, 't', { 'a@@b': 'NOTNULL', 'c`d': 'NOTNULL' },
            { order_by: 'id', direction: 'ASC', limit: 1 }, res));
        assert.ok(seen.includes('`a@@b` IS NOT NULL'), seen);
        assert.ok(seen.includes('`c``d` IS NOT NULL'), seen);
    });
}

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

        await ok('postgres: tools — describe_table labels, count_rows on a missing table is a tool error', async () => {
            const app = await startApp(Object.assign({}, config, { mcp: { token: 't', timeout_ms: 500 } }));
            const client = await connect(app.port, 't');
            try {
                const d = data(await call(client, 'describe_table', { db: 'pgtest', table: T }));
                assert.deepStrictEqual(Object.keys(d),
                    ['columns', 'indexes', 'status', 'referenced_by', 'triggers', 'foreign_keys']);
                assert.ok(d.columns.length >= 2);
                assert.deepStrictEqual(data(await call(client, 'count_rows', { db: 'pgtest', table: T })), { count: 3 });
                const bad = await call(client, 'count_rows', { db: 'pgtest', table: 'no_such_table_xyz' });
                assert.strictEqual(bad.isError, true);
                const q = await call(client, 'browse_rows', { db: 'pgtest', table: T, order_by: 'id', limit: 2 });
                assert.strictEqual(data(q).rows.length, 2);
                assert.ok(data(await call(client, 'list_tables', { db: 'pgtest' })).includes(T));
            } finally {
                await client.close();
                app.close();
            }
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

        await ok('postgres: watchdog drops a stuck connection; the next call gets a new one', async () => {
            // a negative grace makes the watchdog fire (at 100ms) before statement_timeout (500ms)
            const pid = (await sql('SELECT pg_backend_pid() AS pid'))[0].pid;
            mcp_db.setStuckGraceMs(-400);
            try {
                const t0 = Date.now();
                await assert.rejects(sql('SELECT pg_sleep(3)'), /did not return in time; connection dropped/);
                assert.ok(Date.now() - t0 < 1000, 'took ' + (Date.now() - t0) + 'ms');
            } finally {
                mcp_db.setStuckGraceMs();
            }
            const rows = await sql('SELECT pg_backend_pid() AS pid');
            assert.notStrictEqual(rows[0].pid, pid, 'still the old backend');
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

        await ok('mysql: the timeout still applies after the caller tries to switch it off', async () => {
            try { await sql('SET SESSION max_execution_time = 0'); } catch (e) { /* refusing is fine too */ }
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

        for (const id of ['constructor', '__proto__']) {
            for (const tool of ['list_tables', 'describe_table']) {
                await ok(tool + ': inherited property name "' + id + '" is "No such database"', async () => {
                    const r = await call(client, tool, { db: id, table: T });
                    assert.strictEqual(r.isError, true);
                    assert.match(r.content[0].text, /No such database/);
                });
            }
        }
    } finally {
        await client.close();
        app.close();
    }

    await ok('postgres identifiers: hostile table / column / order_by / where keys are refused before connecting', async () => {
        const cfg = Object.assign({}, sqliteConfig, { db: Object.assign({}, sqliteConfig.db, {
            pgfake: { type: 'postgres', host: 'nowhere.invalid', user: 'u', password: 'p', database: 'd' } }) });
        const pgapp = await startApp(cfg);
        const c = await connect(pgapp.port, 'secret-token');
        const text = (r) => r.content[0].text;
        const refused = async (tool, args) => {
            const r = await call(c, tool, Object.assign({ db: 'pgfake' }, args));
            assert.strictEqual(r.isError, true);
            assert.match(text(r), /Invalid identifier/, tool + ' ' + JSON.stringify(args));
        };
        const accepted = async (tool, args) => {
            const r = await call(c, tool, Object.assign({ db: 'pgfake' }, args));
            assert.strictEqual(r.isError, true);      // nowhere.invalid does not resolve
            assert.doesNotMatch(text(r), /Invalid identifier/, tool + ' ' + JSON.stringify(args));
        };
        try {
            await refused('browse_rows', { table: '(select 1) t', order_by: 'id' });
            await refused('browse_rows', { table: 'x; select 1', order_by: 'id' });
            await refused('browse_rows', { table: T, order_by: 'id desc, (select 1)' });
            await refused('browse_rows', { table: T, order_by: 'id', where: { 'a) or (1=1': 'x' } });
            await refused('describe_table', { table: "t'::regclass; --" });
            await refused('count_rows', { table: "t'::regclass; --" });
            await refused('column_values', { table: T, column: '1) from (select 1) x --' });
            await refused('column_values', { table: '(select 1) t', column: 'name' });

            await accepted('count_rows', { table: T });
            await accepted('count_rows', { table: 'public.' + T });
            await accepted('describe_table', { table: T });
            await accepted('column_values', { table: T, column: 'name' });
            await accepted('browse_rows', { table: 'public.' + T, order_by: 'id', where: { name: 'a' } });
        } finally {
            await c.close();
            pgapp.close();
        }
    });

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

// ---- main ------------------------------------------------------------------

// if a callback never comes, node exits (with 0) once nothing is left to do
let finished = false;
process.on('exit', () => {
    if (!finished) {
        console.log('\nTests did not finish: something never called back');
        process.exitCode = 1;
    }
});

(async () => {
    try {
        await connectionLayerTests();
        await mysqlDriverTests();
        await postgresTests();
        await mysqlTests();
        await endpointTests();
        await toolTests();
    } finally {
        for (const f of [tmpFile, attachFile, vacuumFile, otherFile]) { try { fs.unlinkSync(f); } catch (_) {} }
    }
    finished = true;
    console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
    process.exit(failed ? 1 : 0);
})();
