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
