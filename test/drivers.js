// Unit tests for the db_*.js driver modules.
// Runs standalone: a temp SQLite file, no server, no external database.

'use strict';
const assert   = require('assert');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const Database = require('better-sqlite3');

const db_sqlite = require('../db_sqlite.js');

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

    try { fs.unlinkSync(tmpDb); } catch (_) {}

    console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
    if (failed) { process.exit(1); }
}

run().catch((e) => {
    console.error(e);
    try { fs.unlinkSync(tmpDb); } catch (_) {}
    process.exit(1);
});
