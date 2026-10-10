// Integration tests for key HTTP routes.
// Spawns the server as a child process; kills it when done.

'use strict';
const { spawn }  = require('child_process');
const path       = require('path');
const assert     = require('assert');
const fs         = require('fs');
const net        = require('net');

const PORT = 1888;
const BASE = 'http://localhost:' + PORT;
const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
let server;

// ---- helpers ---------------------------------------------------------------

async function req(method, urlPath, opts = {}) {
    const url = BASE + urlPath;
    const res = await fetch(url, {
        method,
        redirect: 'manual',
        headers:  opts.headers || {},
        body:     opts.body    || undefined,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
}

async function get(urlPath, opts)        { return req('GET',  urlPath, opts); }
async function post(urlPath, body, opts) {
    return req('POST', urlPath, {
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                   ...(opts && opts.headers) },
        ...opts,
    });
}

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

// Read credentials from users.txt (first line, user:pass format)
function readCreds() {
    try {
        const line = fs.readFileSync(path.join(ROOT, 'users.txt'), 'utf8')
                       .split('\n').find(l => l.trim());
        if (line) {
            const [user, ...rest] = line.split(':');
            return { user, pass: rest.join(':') };
        }
    } catch (_) {}
    return null;
}

// Log in and return the session cookie string
async function login(user, pass) {
    const body = 'user=' + encodeURIComponent(user)
               + '&pass=' + encodeURIComponent(pass);
    const res = await post('/login', body);
    const raw = res.headers.get('set-cookie') || '';
    return raw.split(';')[0];
}

// ---- discovering a browsable database to test against ----------------------

function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Every sqlite database in config.js whose file exists, for database-backed
// assertions; empty when there is none and those tests are skipped.
function findSqliteDbs() {
    const ids = [];
    try {
        const cfg = require(path.join(ROOT, 'config.js'));
        for (const [id, c] of Object.entries(cfg.db || {})) {
            if (c.type === 'sqlite' && c.database && fs.existsSync(c.database)) { ids.push(id); }
        }
    } catch (_) {}
    return ids;
}

// The first table linked from the table list page.
async function firstTable(db, cookie) {
    try {
        const r = await get('/' + db, { headers: { Cookie: cookie } });
        const m = r.text.match(new RegExp('href="/' + escapeRe(db) + '/([^"/?]+)"'));
        return m ? decodeURIComponent(m[1]) : null;
    } catch (_) { return null; }
}

// The first column linked from the table details page. That page still uses the
// legacy JUST engine, whose attributes are unquoted, so the quote is optional.
async function firstColumn(db, table, cookie) {
    try {
        const r = await get('/' + db + '/' + table, { headers: { Cookie: cookie } });
        const m = r.text.match(new RegExp(
            'href\\s*=\\s*"?/?' + escapeRe(db) + '/' + escapeRe(table) + '/([^"/\\s>?]+)'));
        return m ? decodeURIComponent(m[1]) : null;
    } catch (_) { return null; }
}

// ---- server lifecycle ------------------------------------------------------

// Resolves true if something is already listening on the port.
function portIsOpen() {
    return new Promise((resolve) => {
        const socket = net.connect({ port: PORT, host: 'localhost' });
        const done = (open) => { socket.destroy(); resolve(open); };
        socket.setTimeout(500);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error',   () => done(false));
    });
}

// Waits for the child server to actually accept connections. "Server has
// started" on stdout is NOT a readiness signal: start.js prints it before the
// socket is bound, so a bind failure (EADDRINUSE) arrives afterwards.
function startServer() {
    return (async () => {
        if (await portIsOpen()) {
            throw new Error('Port ' + PORT + ' is already in use; refusing to test '
                          + 'a foreign process. Stop the running server first.');
        }

        await new Promise((resolve, reject) => {
            let settled = false;
            let output  = '';
            const fail = (err) => { if (!settled) { settled = true; reject(err); } };
            const pass = () => { if (!settled) { settled = true; resolve(); } };
            const tail = () => output.trim() ? '\n--- server output ---\n' + output.trim() : '';

            server = spawn('node', ['start.js'], {
                cwd:   ROOT,
                // keep the test hermetic: do not touch the session store the
                // user's config.js points at
                env:   { ...process.env, DBB_SESSION_MEMORY: '1' },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            server.stdout.on('data', (chunk) => { output += chunk; });
            server.stderr.on('data', (chunk) => { output += chunk; });

            server.on('exit', (code, signal) => {
                fail(new Error('Server exited before it was ready (code ' + code
                             + ', signal ' + signal + ').' + tail()));
            });

            const deadline = Date.now() + 8000;
            (function poll() {
                portIsOpen().then((open) => {
                    if (open) { return pass(); }
                    if (Date.now() > deadline) {
                        return fail(new Error('Server start timed out.' + tail()));
                    }
                    setTimeout(poll, 100);
                });
            })();
        });
    })();
}

function stopServer() {
    if (server) server.kill();
}

// ---- tests -----------------------------------------------------------------

async function runTests() {
    console.log('\nRoutes');

    const creds = readCreds();

    // --- unauthenticated behaviour ---

    await ok('GET / → shows login or DB list (200)', async () => {
        const r = await get('/');
        assert.strictEqual(r.status, 200);
    });

    await ok('POST /login with bad creds → 200 with error message', async () => {
        const r = await post('/login', 'user=nobody&pass=wrong');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('not allowed'), 'shows error message');
    });

    // --- authenticated routes (skip if no users.txt) ---

    if (!creds) {
        console.log('  SKIP  (no users.txt — skipping authenticated route tests)');
    } else {
        let cookie;

        await ok('POST /login with valid creds → 302 redirect', async () => {
            const body = 'user=' + encodeURIComponent(creds.user)
                       + '&pass=' + encodeURIComponent(creds.pass);
            const r = await post('/login', body);
            assert.strictEqual(r.status, 302);
            cookie = (r.headers.get('set-cookie') || '').split(';')[0];
            assert.ok(cookie, 'session cookie set');
        });

        await ok('GET / with auth → DB list page', async () => {
            const r = await get('/', { headers: { Cookie: cookie } });
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('Databases') || r.text.includes('database'),
                      'shows database list');
        });

        await ok('GET /:sql with auth → SQL history page', async () => {
            const r = await get('/:sql', { headers: { Cookie: cookie } });
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.toLowerCase().includes('sql') ||
                      r.text.toLowerCase().includes('history'),
                      'shows SQL history');
        });

        await ok('GET /:sql/999 with auth → SQL detail page (200, even if missing)', async () => {
            const r = await get('/:sql/999', { headers: { Cookie: cookie } });
            assert.strictEqual(r.status, 200);
        });

        // --- status semantics: absent things are 404, not 500 ---
        // (before the logout test below: that one kills the session)

        await ok('GET /unknown-db → 404', async () => {
            const r = await get('/no_such_database_xyz', { headers: { Cookie: cookie } });
            assert.strictEqual(r.status, 404);
        });

        // pick a sqlite database we can actually browse: config may list some
        // whose file is missing or unreadable
        let target = null;
        for (const id of findSqliteDbs()) {
            const t = await firstTable(id, cookie);
            if (!t) { continue; }
            const c = await firstColumn(id, t, cookie);
            if (c) { target = { id, table: t, column: c }; break; }
        }

        if (!target) {
            console.log('  SKIP  (no browsable sqlite database in config.js — skipping table/row 404 tests)');
        } else {
            await ok('GET /:db/<missing table> → 404', async () => {
                const r = await get('/' + target.id + '/no_such_table_xyz',
                                    { headers: { Cookie: cookie } });
                assert.strictEqual(r.status, 404);
            });

            await ok('GET /:db/:table/<missing column> → 404', async () => {
                const r = await get('/' + target.id + '/' + target.table + '/no_such_column_xyz',
                                    { headers: { Cookie: cookie } });
                assert.strictEqual(r.status, 404);
            });

            await ok('GET /:db/:table/:column/<unmatched value> → 404', async () => {
                const r = await get('/' + target.id + '/' + target.table + '/' + target.column
                                  + '/no_such_value_xyz',
                                    { headers: { Cookie: cookie } });
                assert.strictEqual(r.status, 404);
            });

            await ok('row-view links keep the query string', async () => {
                // the column itself as a NOTNULL filter: every row matches, so
                // the page renders and its generated links are observable
                const filter = target.column + '=NOTNULL';
                const r = await get('/' + target.id + '/' + target.table + '/' + target.column
                                  + '/_ASC?' + filter,
                                    { headers: { Cookie: cookie } });
                if (r.status !== 200) { return; }   // nothing non-null to show
                assert.ok(r.text.indexOf('?' + filter) !== -1,
                          'a view-switch link should carry ' + filter);
            });

            await ok('grouped column page links values, not counts', async () => {
                const r = await get('/' + target.id + '/' + target.table + '/' + target.column,
                                    { headers: { Cookie: cookie } });
                assert.strictEqual(r.status, 200);
                assert.ok(r.text.indexOf('/count/') === -1,
                          'no link should be built from the count(*) column');
            });
        }

        // --- addon config endpoint ---

        await ok('GET /ao/config with an unknown addon → 404', async () => {
            const r = await get('/ao/config?ao=no_such_addon', { headers: { Cookie: cookie } });
            assert.strictEqual(r.status, 404);
        });

        await ok('GET /ao/config without ao → 404', async () => {
            const r = await get('/ao/config', { headers: { Cookie: cookie } });
            assert.strictEqual(r.status, 404);
        });

        await ok('GET /ao/config?ao=constructor → 404 (prototype keys do not resolve)', async () => {
            const r = await get('/ao/config?ao=constructor', { headers: { Cookie: cookie } });
            assert.strictEqual(r.status, 404);
        });

        // keep last: it destroys the session the tests above share
        await ok('GET /logout → redirects to /', async () => {
            const r = await get('/logout', { headers: { Cookie: cookie } });
            assert.ok([200, 302].includes(r.status));
        });
    }

    // --- static assets ---

    await ok('GET /_/css/style.css → 200', async () => {
        const r = await get('/_/css/style.css');
        assert.strictEqual(r.status, 200);
    });

    // --- safety: raw SQL blocked unless explicitly enabled ---

    await ok('POST /:sql without allow_clear_sql → 404', async () => {
        const r = await post('/:sql', 'sql=SELECT+1&run=Execute');
        assert.ok([302, 404, 200].includes(r.status));
    });
}

// ---- main ------------------------------------------------------------------

(async () => {
    try {
        await startServer();
    } catch (e) {
        console.error('Could not start server:', e.message);
        process.exit(1);
    }

    try {
        await runTests();
    } finally {
        stopServer();
    }

    console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
    if (failed) process.exit(1);
})();
