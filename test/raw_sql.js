// The raw SQL box (allow_clear_sql) against a spawned start.js: what one
// statement changes in its database session must not reach later requests, and
// SQLite statements that open or write another file are refused.
// Runs on a temp config, a temp SQLite file and in-memory sessions: the real
// config.js, users.txt and usersRequests.sqlite are never touched.

'use strict';
const assert   = require('assert');
const fs       = require('fs');
const net      = require('net');
const os       = require('os');
const path     = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

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

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, 'localhost', () => {
            const port = probe.address().port;
            probe.close(() => resolve(port));
        });
    });
}

// Resolves once the server says it listens; rejects if it exits first.
function spawnApp(dir, configFile, port) {
    const child = spawn(process.execPath, ['start.js'], {
        cwd: path.join(__dirname, '..'),
        env: Object.assign({}, process.env, {
            DBB_CONFIG: configFile, DBB_PORT: String(port), DBB_SESSION_MEMORY: '1',
            SQLITE_PATH: path.join(dir, 'usersRequests.sqlite')
        }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('start timed out: ' + out)), 10000);
        const onData = (c) => {
            out += c;
            if (/Server has started/.test(out)) { clearTimeout(timer); resolve(); }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', (code) => { clearTimeout(timer); reject(new Error('server exited (' + code + '): ' + out)); });
    });
    return { child, ready };
}

async function run() {
    console.log('\nraw SQL');

    const dir    = fs.mkdtempSync(path.join(os.tmpdir(), 'db-browse-rawsql-'));
    const dbFile = path.join(dir, 'app.sqlite');
    const seed = new Database(dbFile);
    seed.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('a')");
    seed.close();
    fs.writeFileSync(path.join(dir, 'users.txt'), 'tester:testpass\n');
    const configFile = path.join(dir, 'config.js');
    fs.writeFileSync(configFile, 'module.exports = ' + JSON.stringify({
        listen: { host: 'localhost', port: 0 },
        db: { app: { type: 'sqlite', database: dbFile } },
        allow_clear_sql: true,
        session_config: { resave: false, saveUninitialized: false, secret: 'test' },
        authenticate_userfile: path.join(dir, 'users.txt')
    }, null, 2) + ';\n');

    const port = await freePort();
    const base = 'http://localhost:' + port;
    const app  = spawnApp(dir, configFile, port);

    try {
        await app.ready;

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
        app.child.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
    if (failed) { process.exit(1); }
}

run();
