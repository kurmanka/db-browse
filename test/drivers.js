// Unit tests for the db_*.js driver modules.
// Runs standalone: a temp SQLite file, no server, no external database.

'use strict';
const assert   = require('assert');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const Database = require('better-sqlite3');

const db_sqlite   = require('../db_sqlite.js');
const db_postgres = require('../db_postgres.js');

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

// promisified driver calls
const p = {
    connect: (cc) => new Promise((resolve, reject) => {
        const c = db_sqlite.createConnection(cc);
        c.connect((err) => err ? reject(err) : resolve(c));
    }),
    showAllTable: (c) => new Promise((resolve, reject) =>
        db_sqlite.showAllTable(c, (err, r) => err ? reject(err) : resolve(r))),
    getTableDetails: (c, t) => new Promise((resolve, reject) =>
        db_sqlite.getTableDetails(c, t, (err, r) => err ? reject(err) : resolve(r))),
    rowsCounter: (c, t) => new Promise((resolve, reject) =>
        db_sqlite.rowsCounter(c, t, (err, r) => err ? reject(err) : resolve(r))),
    showValueRequest: (c, t, where, olo) => new Promise((resolve, reject) =>
        db_sqlite.showValueRequest(c, t, where, olo, (err, r) => err ? reject(err) : resolve(r))),
    showColumnRequest: (c, col, t, limit) => new Promise((resolve, reject) =>
        db_sqlite.showColumnRequest(c, col, t, limit, (err, r) => err ? reject(err) : resolve(r))),
};

const tmpDb = path.join(os.tmpdir(), 'db-browse-drivers-' + Date.now() + '.sqlite');

async function run() {
    console.log('\ndrivers (sqlite)');

    const seed = new Database(tmpDb);
    seed.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, payload TEXT)');
    seed.prepare('INSERT INTO items (name, payload) VALUES (?, ?)').run('a', '{"k":1}');
    seed.prepare('INSERT INTO items (name, payload) VALUES (?, ?)').run('b', null);
    seed.close();

    const conn = await p.connect({ database: tmpDb });

    await ok('showAllTable lists the table', async () => {
        const tables = await p.showAllTable(conn);
        assert.deepStrictEqual(tables, ['items']);
    });

    await ok('getTableDetails returns columns and the create statement', async () => {
        const data = await p.getTableDetails(conn, 'items');
        const [columns, status] = data;
        assert.deepStrictEqual(columns.map(c => c.column_name), ['id', 'name', 'payload']);
        assert.ok(/CREATE TABLE items/.test(status[0].sql), 'create statement present');
    });

    // issue 03: a missing table is an empty result set for SQLite, not an error
    await ok('getTableDetails reports a missing table as an error', async () => {
        await assert.rejects(() => p.getTableDetails(conn, 'no_such_table'),
                             /not found/);
    });

    await ok('rowsCounter counts rows', async () => {
        assert.strictEqual(Number(await p.rowsCounter(conn, 'items')), 2);
    });

    await ok('showValueRequest filters and orders', async () => {
        const rows = await p.showValueRequest(conn, 'items', { name: 'a' },
                                              { order_by: 'id', direction: 'ASC', limit: 10 });
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].name, 'a');
    });

    await ok('showColumnRequest groups values', async () => {
        const rows = await p.showColumnRequest(conn, 'name', 'items', 10);
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(Number(rows[0].count), 1);
    });

    // ---- postgres identifier validation (no server needed) ----

    console.log('\n  postgres identifiers');

    const goodIdents = ['items', 'public.items', 'orders_2024', 'a$b',
                        'schema_1.table_2', '"MyTable"', '"My Schema"."My Table"', '"a\'b"'];
    await ok('ident accepts plain, qualified and quoted names', async () => {
        for (const n of goodIdents) {
            assert.strictEqual(db_postgres.ident(n), n, JSON.stringify(n));
        }
    });

    const badIdents = ['a; DROP TABLE x', 'items)', '(select 1) t', 'x; select 1',
                       'a"b', "'quoted'", '', 'a b', '1abc', 'a.b.c',
                       "t'::regclass; --", 'a) or (1=1', 'id desc, (select 1)'];
    await ok('ident refuses anything else', async () => {
        for (const n of badIdents) {
            assert.throws(() => db_postgres.ident(n), /Invalid identifier/, JSON.stringify(n));
        }
    });

    // a connection that must never be reached: validation happens first
    const noDb = { query: () => { throw new Error('the database must not be reached'); } };
    const pCall = (fn, ...args) => new Promise((resolve, reject) =>
        fn(noDb, ...args, (err, r) => err ? reject(err) : resolve(r)));

    await ok('postgres rowsCounter refuses a hostile table before querying', async () => {
        await assert.rejects(() => pCall(db_postgres.rowsCounter, 'x; DROP TABLE t'),
                             /Invalid identifier/);
    });

    await ok('postgres showColumnRequest refuses a hostile column', async () => {
        await assert.rejects(() => pCall(db_postgres.showColumnRequest, 'a) or (1=1', 'items', 10),
                             /Invalid identifier/);
    });

    await ok('postgres showValueRequest refuses a hostile where key', async () => {
        await assert.rejects(
            () => pCall(db_postgres.showValueRequest, 'items', { 'a) or (1=1': 'x' }, null),
            /Invalid identifier/);
    });

    await ok('postgres showValueRequest parameterizes values and validates order_by', async () => {
        let sql, params;
        const conn = { query: (s, prm, cb) => { sql = s; params = prm; cb(null, { rows: [] }); } };
        await new Promise((resolve, reject) => db_postgres.showValueRequest(
            conn, 'public.items', { name: 'a', note: 'NOTNULL' },
            { order_by: 'id', direction: 'DESC', limit: 5 },
            (e, r) => e ? reject(e) : resolve(r)));

        assert.ok(/from public\.items where name=\$1 AND note IS NOT NULL/.test(sql), sql);
        assert.ok(/order by id DESC LIMIT 5/.test(sql), sql);
        assert.deepStrictEqual(params, ['a']);
    });

    await ok('postgres showValueRequest clamps a non-numeric limit', async () => {
        let sql;
        const conn = { query: (s, prm, cb) => { sql = s; cb(null, { rows: [] }); } };
        await new Promise((resolve, reject) => db_postgres.showValueRequest(
            conn, 'items', {}, { order_by: 'id', direction: 'ASC', limit: '1; DROP TABLE t' },
            (e, r) => e ? reject(e) : resolve(r)));
        assert.ok(/LIMIT 100\s*$/.test(sql), sql);
    });

    // ---- HTTP status classification ----

    console.log('\n  error status classification');

    await ok('errorStatus: not-found → 404, bad input → 400, else 500', async () => {
        const rh = require('../requestHandlers.js');
        assert.strictEqual(rh.errorStatus('column "x" does not exist'), 404);
        assert.strictEqual(rh.errorStatus('no such column: x'), 404);
        assert.strictEqual(rh.errorStatus("Unknown column 'x' in 'field list'"), 404);
        assert.strictEqual(rh.errorStatus('relation "t" does not exist'), 404);
        assert.strictEqual(rh.errorStatus('Invalid identifier: a) or (1=1'), 400);
        assert.strictEqual(rh.errorStatus('socket hang up'), 500);
        assert.strictEqual(rh.errorStatus(new Error('boom')), 500);

        const notFound = new Error('No records found to match your filters.');
        notFound.status = 404;
        assert.strictEqual(rh.errorStatus(notFound), 404);
    });

    try { fs.unlinkSync(tmpDb); } catch (_) {}

    console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
    if (failed) { process.exit(1); }
}

run().catch((e) => {
    console.error(e);
    try { fs.unlinkSync(tmpDb); } catch (_) {}
    process.exit(1);
});
