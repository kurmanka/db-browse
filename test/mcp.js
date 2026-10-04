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

// ---- main ------------------------------------------------------------------

(async () => {
    try {
        await connectionLayerTests();
        await postgresTests();
        await mysqlTests();
    } finally {
        for (const f of [tmpFile, attachFile]) { try { fs.unlinkSync(f); } catch (_) {} }
    }
    console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
    process.exit(failed ? 1 : 0);
})();
