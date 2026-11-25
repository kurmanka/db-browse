// Browser-facing protections, against a spawned start.js with password login,
// an addon and the raw SQL box on: escaping, cross-site POSTs, the session
// cookie, login redirects, session ids and rate limit, addon static files,
// response headers and error pages.

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
    console.log('\nweb security');

    let app;
    try {
        app = await spawnApp('db-browse-websec-', (dir) => {
            const dbFile = path.join(dir, 'app.sqlite');
            const seed = new Database(dbFile);
            seed.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('a')");
            seed.close();
            fs.writeFileSync(path.join(dir, 'users.txt'), 'tester:testpass\nvictim:victimpass\n');
            return {
                listen: { host: 'localhost', port: 0 },
                db: { app: { type: 'sqlite', database: dbFile } },
                allow_clear_sql: true,
                // saveUninitialized: a session (and cookie) exists before login
                session_config: { resave: false, saveUninitialized: true, secret: 'test' },
                authenticate_userfile: path.join(dir, 'users.txt'),
                addons: { fun: {} }
            };
        });
        const base = app.base;
        const dbFile = path.join(app.dir, 'app.sqlite');

        const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
        const login = (user, pass, to, cookie) => fetch(base + '/login', {
            method: 'POST', redirect: 'manual',
            headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' },
                                   cookie ? { Cookie: cookie } : {}),
            body: new URLSearchParams(Object.assign({ user, pass }, to === undefined ? {} : { to })).toString()
        });
        const cookie = cookieOf(await login('tester', 'testpass'));
        assert.ok(cookie, 'logged in');
        const get = (p, headers) => fetch(base + p, {
            redirect: 'manual', headers: Object.assign({ Cookie: cookie }, headers),
            signal: AbortSignal.timeout(5000)
        });

        await ok('a table name from the URL is escaped on the not-found page', async () => {
            const r = await get('/app/' + encodeURIComponent('<script>alert(1)</script>'));
            const text = await r.text();
            assert.strictEqual(r.status, 404);
            assert.ok(!text.includes('<script>alert(1)'), 'raw script tag in the page');
            assert.ok(text.includes('&lt;script&gt;'), 'escaped name shown');
        });

        await ok('/app/constructor is not taken for an addon feature (no hang)', async () => {
            const r = await get('/app/constructor');
            assert.strictEqual(r.status, 404);
        });

        await ok('/_exit and /_reset are gone; the server keeps running', async () => {
            for (const p of ['/_exit', '/_reset']) {
                const r = await get(p);
                assert.notStrictEqual(r.status, 200, p);
            }
            assert.strictEqual((await get('/')).status, 200);
        });

        const sqlPost = (site) => fetch(base + '/app:sql', {
            method: 'POST', redirect: 'manual',
            headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
                                   site ? { 'Sec-Fetch-Site': site } : {}),
            body: new URLSearchParams({ sql: "UPDATE items SET name = 'pwned'", run: 'Execute' }).toString()
        });
        const itemName = () => {
            const db = new Database(dbFile, { readonly: true });
            const n = db.prepare('SELECT name FROM items').get().name;
            db.close();
            return n;
        };

        await ok('a cross-site POST is refused and changes nothing', async () => {
            for (const site of ['cross-site', 'same-site']) {
                const r = await sqlPost(site);
                assert.strictEqual(r.status, 403, site);
            }
            assert.strictEqual(itemName(), 'a');
        });

        await ok('a same-origin POST still works', async () => {
            const r = await sqlPost('same-origin');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(itemName(), 'pwned');
        });

        await ok('the session cookie is SameSite=Lax and HttpOnly', async () => {
            const raw = (await fetch(base + '/')).headers.get('set-cookie') || '';
            assert.match(raw, /SameSite=Lax/i);
            assert.match(raw, /HttpOnly/i);
        });

        await ok('login redirects only to a local path', async () => {
            for (const [to, want] of [['https://evil.example/x', '/'], ['//evil.example/x', '/'],
                                      ['/\\evil.example', '/'], ['/app', '/app']]) {
                const r = await login('tester', 'testpass', to);
                assert.strictEqual(r.status, 302, to);
                assert.strictEqual(r.headers.get('location'), want, to);
            }
        });

        await ok('login gives a new session id', async () => {
            const before = cookieOf(await fetch(base + '/'));
            assert.ok(before, 'a session before login');
            const after = cookieOf(await login('tester', 'testpass', '/', before));
            assert.ok(after, 'a cookie after login');
            assert.notStrictEqual(after, before);
        });

        await ok('addon static files need a login, whatever the case of the path', async () => {
            for (const p of ['/ao/fun/do.html', '/AO/FUN/do.html']) {
                const anon = await fetch(base + p, { redirect: 'manual' });
                assert.match(await anon.text(), /loginform/, p + ' served without login');
            }
            assert.strictEqual((await get('/ao/fun/do.html')).status, 200);
        });

        await ok('pages are not frameable and load no third-party script', async () => {
            const r = await get('/');
            assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
            assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
            assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
            assert.ok(!/googleapis|jquery/i.test(await r.text()), 'third-party script');
        });

        await ok('an error answers with the status text, not a stack trace', async () => {
            const r = await fetch(base + '/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{'
            });
            const text = await r.text();
            assert.strictEqual(r.status, 400);
            assert.ok(!/\bat \S+ \(/.test(text), 'stack trace: ' + text.slice(0, 200));
        });

        // last: it locks 'victim' out from this address
        await ok('failed logins are limited per user name and address', async () => {
            for (let i = 0; i < 10; i++) {
                assert.strictEqual((await login('victim', 'wrong')).status, 200);
            }
            const r = await login('victim', 'victimpass');
            assert.strictEqual(r.status, 429, 'the right password after 10 failures');
            assert.strictEqual((await login('tester', 'testpass')).status, 302, 'another user');
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
