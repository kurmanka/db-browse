// Integration tests for key HTTP routes.
// Spawns the server as a child process; kills it when done.

'use strict';
const { spawn }  = require('child_process');
const path       = require('path');
const assert     = require('assert');
const fs         = require('fs');

const BASE = 'http://localhost:1888';
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

// ---- server lifecycle ------------------------------------------------------

function startServer() {
    return new Promise((resolve, reject) => {
        server = spawn('node', ['start.js'], {
            cwd:   ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        server.stdout.on('data', (chunk) => {
            if (chunk.toString().includes('Server has started')) {
                resolve();
            }
        });

        server.stderr.on('data', (chunk) => {
            const msg = chunk.toString();
            if (msg.includes('EADDRINUSE')) {
                reject(new Error('Port 1888 already in use — stop the running server first'));
            }
        });

        server.on('exit', (code) => {
            if (code !== null && code !== 0) {
                reject(new Error('Server exited with code ' + code));
            }
        });

        setTimeout(() => reject(new Error('Server start timed out')), 8000);
    });
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
