// Unit tests for sqliteDB.js — runs standalone, no server needed.
// Uses a temp DB so it never touches usersRequests.sqlite.

'use strict';
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const tmpDb = path.join(os.tmpdir(), 'db-browse-test-' + Date.now() + '.sqlite');
process.env.SQLITE_PATH = tmpDb;

const sqlite = require('../sqliteDB.js');

let passed = 0;
let failed = 0;

function ok(label, fn) {
    try {
        fn();
        console.log('  PASS  ' + label);
        passed++;
    } catch (e) {
        console.log('  FAIL  ' + label);
        console.log('        ' + e.message);
        failed++;
    }
}

function run() {
    console.log('\nsqliteDB');

    // saveRequest — new entry
    ok('saveRequest creates a new record', (done) => {
        sqlite.saveRequest('SELECT 1', 'testdb', 'my query', 'alice', 'a comment', (err) => {
            assert.strictEqual(err, null);
        });
    });

    // saveRequest — duplicate SQL increments used_times
    ok('saveRequest deduplicates and increments used_times', () => {
        sqlite.saveRequest('SELECT 1', 'testdb', 'my query', 'alice', '', (err) => {
            assert.strictEqual(err, null);
        });
        sqlite.history((err, rows) => {
            assert.strictEqual(err, null);
            const row = rows.find(r => r.sql.startsWith('SELECT 1'));
            assert.ok(row, 'row exists');
            assert.strictEqual(Number(row.used_times || 2), 2); // bumped
        });
    });

    // history — returns rows sorted by used_times desc
    ok('history returns rows', () => {
        sqlite.saveRequest('SELECT 2', 'testdb', 'second', 'bob', '', (err) => {
            assert.strictEqual(err, null);
        });
        sqlite.history((err, rows) => {
            assert.strictEqual(err, null);
            assert.ok(rows.length >= 2);
        });
    });

    // details — fetch single row by id
    ok('details returns a single row', () => {
        sqlite.history((err, rows) => {
            assert.strictEqual(err, null);
            const id = rows[0].id;
            sqlite.details((err, row) => {
                assert.strictEqual(err, null);
                assert.ok(row, 'row returned');
                assert.strictEqual(row.id, id);
            }, id);
        });
    });

    // changeRequest type='save' — updates sql text, preserves used_times
    ok('changeRequest save updates sql without bumping used_times', () => {
        sqlite.history((err, rows) => {
            assert.strictEqual(err, null);
            const row = rows[0];
            const origTimes = Number(row.used_times);
            assert.ok(!isNaN(origTimes), 'used_times must be a number');
            sqlite.changeRequest(
                'SELECT 999', 'testdb', row.name, 'alice', 'edited',
                (err) => { assert.strictEqual(err, null); },
                row.id, 'save'
            );
            sqlite.details((err, updated) => {
                assert.strictEqual(err, null);
                assert.strictEqual(updated.sql, 'SELECT 999');
                assert.strictEqual(Number(updated.used_times), origTimes);
            }, row.id);
        });
    });

    // changeRequest type='execute' — bumps used_times
    ok('changeRequest execute bumps used_times', () => {
        sqlite.history((err, rows) => {
            assert.strictEqual(err, null);
            const row = rows[0];
            const origTimes = Number(row.used_times);
            assert.ok(!isNaN(origTimes), 'used_times must be a number');
            sqlite.changeRequest(
                row.sql, 'testdb', row.name, 'alice', '',
                (err) => { assert.strictEqual(err, null); },
                row.id, 'execute'
            );
            sqlite.details((err, updated) => {
                assert.strictEqual(err, null);
                assert.strictEqual(Number(updated.used_times), origTimes + 1);
            }, row.id);
        });
    });

    // remove — deletes by id
    ok('remove deletes a record', () => {
        sqlite.history((err, rows) => {
            assert.strictEqual(err, null);
            const id = rows[rows.length - 1].id;
            const countBefore = rows.length;
            sqlite.remove(id, (err) => { assert.strictEqual(err, null); });
            sqlite.history((err, after) => {
                assert.strictEqual(err, null);
                assert.strictEqual(after.length, countBefore - 1);
                assert.ok(!after.find(r => r.id === id));
            });
        });
    });

    // cleanup
    try { fs.unlinkSync(tmpDb); } catch (_) {}

    console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
    if (failed) process.exit(1);
}

run();
