// The raw SQL box (allow_clear_sql) against a spawned start.js: what one
// statement changes in its database session must not reach later requests, and
// SQLite statements that open or write another file are refused.
// Runs on a temp config, a temp SQLite file and in-memory sessions: the real
// config.js, users.txt and usersRequests.sqlite are never touched.

'use strict';
const assert   = require('assert');
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const { spawnApp } = require('./helpers/spawn_app.js');

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

async function run() {
    console.log('\nraw SQL');

    let app;
    try {
        app = await spawnApp('db-browse-rawsql-', (dir) => {
            const dbFile = path.join(dir, 'app.sqlite');
            const seed = new Database(dbFile);
            seed.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('a')");
            seed.close();
            fs.writeFileSync(path.join(dir, 'users.txt'), 'tester:testpass\n');
            return {
                listen: { host: 'localhost', port: 0 },
                db: { app: { type: 'sqlite', database: dbFile } },
                allow_clear_sql: true,
                session_config: { resave: false, saveUninitialized: false, secret: 'test' },
                authenticate_userfile: path.join(dir, 'users.txt')
            };
        });
        const base = app.base, dir = app.dir;

        const login = await fetch(base + '/login', {
            method: 'POST', redirect: 'manual',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'user=tester&pass=testpass'
        });
        const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
        assert.ok(cookie, 'logged in');

        const sql = async (text) => {
            const r = await fetch(base + '/app:sql', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
                body: new URLSearchParams({ sql: text, run: 'Execute' }).toString()
            });
            return { status: r.status, text: await r.text() };
        };

        await ok('a session setting made by one statement is gone for the next', async () => {
            const cell = /<td class="data">([01])<\/td>/;
            const before = cell.exec((await sql('PRAGMA foreign_keys')).text);
            assert.ok(before, 'read the default');
            const flipped = before[1] === '1' ? '0' : '1';
            assert.strictEqual((await sql('PRAGMA foreign_keys = ' + flipped)).status, 200);
            const after = cell.exec((await sql('PRAGMA foreign_keys')).text);
            assert.strictEqual(after && after[1], before[1], 'foreign_keys is back to its default');
        });

        const other = path.join(dir, 'other.sqlite');
        await ok('ATTACH is refused and creates no file', async () => {
            const r = await sql("ATTACH DATABASE '" + other + "' AS o");
            assert.notStrictEqual(r.status, 200);
            assert.match(r.text, /another database file/);
            assert.strictEqual(fs.existsSync(other), false);
        });

        await ok('VACUUM INTO is refused and creates no file', async () => {
            const r = await sql("/* copy */ VACUUM INTO '" + other + "'");
            assert.notStrictEqual(r.status, 200);
            assert.match(r.text, /another database file/);
            assert.strictEqual(fs.existsSync(other), false);
        });

        await ok('a plain query still works, and browsing after it', async () => {
            const r = await sql('SELECT name FROM items');
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /<td class="data">a<\/td>/);
            const list = await fetch(base + '/app', { headers: { Cookie: cookie } });
            assert.strictEqual(list.status, 200);
        });
    } catch (e) {
        console.log('  FAIL  setup: ' + e.message);
        failed++;
    } finally {
        if (app) { app.stop(); }
    }

    console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
    if (failed) { process.exit(1); }
}

run();
