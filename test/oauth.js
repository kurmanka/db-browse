// Tests for OAuth/OIDC support. Sections are appended by later tasks;
// main() runs them in order and exits non-zero on any failure.

'use strict';
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
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

const now = () => Math.floor(Date.now() / 1000);

// ---- store -----------------------------------------------------------------

async function storeSection() {
    console.log('store');
    const auth_store = require('../auth_store.js');
    const file = path.join(os.tmpdir(), 'db-browse-oauth-test-' + Date.now() + '.sqlite');
    const store = auth_store.open(file);

    const code = (h, exp) => ({
        code_hash: h, client_id: 'c1', email: 'a@example.com', groups: ['g1', 'g2'],
        challenge: 'chal', redirect_uri: 'http://localhost/cb', resource: 'http://localhost/mcp',
        expires_at: exp
    });
    const tok = (h, kind, exp) => ({
        token_hash: h, kind, client_id: 'c1', email: 'a@example.com', groups: ['g1'], expires_at: exp
    });

    await ok('hash and randomToken', () => {
        assert.strictEqual(auth_store.hash('abc'),
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        const t = auth_store.randomToken();
        assert.ok(/^[A-Za-z0-9_-]{43}$/.test(t), t);
        assert.notStrictEqual(t, auth_store.randomToken());
    });

    await ok('addClient / getClient', () => {
        store.addClient({ client_id: 'c1', redirect_uris: ['http://localhost/cb'] });
        assert.deepStrictEqual(store.getClient('c1'),
            { client_id: 'c1', redirect_uris: ['http://localhost/cb'] });
        assert.strictEqual(store.getClient('nope'), undefined);
    });

    await ok('takeCode is single use', () => {
        store.putCode(code('h1', now() + 60));
        const row = store.takeCode('h1');
        assert.strictEqual(row.email, 'a@example.com');
        assert.deepStrictEqual(row.groups, ['g1', 'g2']);
        assert.strictEqual(row.challenge, 'chal');
        assert.strictEqual(store.takeCode('h1'), undefined);
    });

    await ok('expired code is not returned', () => {
        store.putCode(code('h2', now() - 1));
        assert.strictEqual(store.takeCode('h2'), undefined);
    });

    await ok('takePending is single use and honours expiry', () => {
        store.putPending({ state: 's1', nonce: 'n', verifier: 'v', kind: 'mcp',
                           data: { x: 1 }, expires_at: now() + 60 });
        const row = store.takePending('s1');
        assert.strictEqual(row.nonce, 'n');
        assert.strictEqual(row.verifier, 'v');
        assert.strictEqual(row.kind, 'mcp');
        assert.deepStrictEqual(row.data, { x: 1 });
        assert.strictEqual(store.takePending('s1'), undefined);
        store.putPending({ state: 's2', nonce: 'n', verifier: 'v', kind: 'web',
                           data: {}, expires_at: now() - 1 });
        assert.strictEqual(store.takePending('s2'), undefined);
    });

    await ok('getToken / takeToken / revoke', () => {
        store.putToken(tok('t1', 'access', now() + 60));
        const row = store.getToken('t1');
        assert.strictEqual(row.kind, 'access');
        assert.deepStrictEqual(row.groups, ['g1']);
        assert.ok(store.getToken('t1'), 'getToken does not consume');
        store.putToken(tok('t2', 'refresh', now() + 60));
        assert.strictEqual(store.takeToken('t2').kind, 'refresh');
        assert.strictEqual(store.takeToken('t2'), undefined);
        store.revoke('t1');
        assert.strictEqual(store.getToken('t1'), undefined);
        store.putToken(tok('t3', 'access', now() - 1));
        assert.strictEqual(store.getToken('t3'), undefined);
        store.putToken(tok('t4', 'refresh', now() - 1));
        assert.strictEqual(store.takeToken('t4'), undefined);
    });

    await ok('purgeExpired removes only expired rows', () => {
        store.putToken(tok('p_old', 'access', now() - 10));
        store.putToken(tok('p_new', 'access', now() + 100));
        store.putCode(code('pc_old', now() - 10));
        store.putCode(code('pc_new', now() + 100));
        store.purgeExpired();
        const raw = new Database(file, { readonly: true });
        const n = (t, col, v) => raw.prepare('SELECT count(*) AS n FROM ' + t + ' WHERE ' + col + '=?').get(v).n;
        assert.strictEqual(n('tokens', 'token_hash', 'p_old'), 0);
        assert.strictEqual(n('tokens', 'token_hash', 'p_new'), 1);
        assert.strictEqual(n('codes', 'code_hash', 'pc_old'), 0);
        assert.strictEqual(n('codes', 'code_hash', 'pc_new'), 1);
        raw.close();
    });

    await ok('secrets are stored hashed', () => {
        const rawTok = auth_store.randomToken();
        const rawCode = auth_store.randomToken();
        store.putToken(tok(auth_store.hash(rawTok), 'access', now() + 60));
        store.putCode(code(auth_store.hash(rawCode), now() + 60));
        assert.ok(store.getToken(auth_store.hash(rawTok)));
        const raw = new Database(file, { readonly: true });
        for (const t of ['tokens', 'codes']) {
            for (const row of raw.prepare('SELECT * FROM ' + t).all()) {
                for (const v of Object.values(row)) {
                    assert.ok(typeof v !== 'string' || (!v.includes(rawTok) && !v.includes(rawCode)),
                              'raw secret found in ' + t);
                }
            }
        }
        raw.close();
    });

    store.close();
    for (const f of [file, file + '-wal', file + '-shm']) {
        try { fs.unlinkSync(f); } catch (e) { /* absent */ }
    }

    await ok('the store file (and -wal/-shm) is private: mode 0600 under umask 022', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-browse-store-mode-'));
        const f = path.join(dir, 'auth.sqlite');
        const old = process.umask(0o022);
        let s2;
        try {
            s2 = auth_store.open(f);
            s2.putToken(tok('m1', 'access', now() + 60));
            const files = [f, f + '-wal', f + '-shm'].filter(x => fs.existsSync(x));
            assert.ok(files.length >= 2, files.join(','));
            for (const x of files) {
                const mode = fs.statSync(x).mode & 0o777;
                assert.strictEqual(mode & 0o077, 0, path.basename(x) + ' mode ' + mode.toString(8));
            }
        } finally {
            process.umask(old);
            if (s2) { s2.close(); }
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
}

// ---- allowlist -------------------------------------------------------------

async function allowlistSection() {
    console.log('allowlist');
    const allowlist = require('../allowlist.js');
    const check = (config, claims) => new Promise((resolve, reject) => {
        allowlist.isAllowed(config, claims, (err, v) => err ? reject(err) : resolve(v));
    });
    const file = path.join(os.tmpdir(), 'db-browse-allow-test-' + Date.now() + '.txt');
    const oidc = o => ({ oidc: o });
    const ufConfig = flag => ({ authenticate_userfile: file, oidc: { allow_global_userfile: flag } });

    await ok('allow_emails matches case-insensitively', async () => {
        const c = oidc({ allow_emails: ['Ann@Example.com'] });
        assert.strictEqual(await check(c, { email: 'ann@example.COM' }), true);
        assert.strictEqual(await check(c, { email: 'bob@example.com' }), false);
    });

    await ok('email_verified false is refused, absent is accepted', async () => {
        const c = oidc({ allow_emails: ['ann@example.com'] });
        assert.strictEqual(await check(c, { email: 'ann@example.com', email_verified: false }), false);
        assert.strictEqual(await check(c, { email: 'ann@example.com', email_verified: true }), true);
        assert.strictEqual(await check(c, { email: 'ann@example.com' }), true);
    });

    await ok('email_verified "false" (a string) is refused too', async () => {
        const c = oidc({ allow_emails: ['ann@example.com'] });
        assert.strictEqual(await check(c, { email: 'ann@example.com', email_verified: 'false' }), false);
    });

    await ok('missing email is refused without throwing', async () => {
        const c = oidc({ allow_emails: ['ann@example.com'], allow_groups: ['g'] });
        assert.strictEqual(await check(c, {}), false);
        assert.strictEqual(await check(c, { groups: ['g'] }), false);
        assert.strictEqual(await check(c, undefined), false);
    });

    await ok('allow_groups with array, string, missing', async () => {
        const c = oidc({ allow_groups: ['staff'] });
        assert.strictEqual(await check(c, { email: 'x@example.com', groups: ['a', 'staff'] }), true);
        assert.strictEqual(await check(c, { email: 'x@example.com', groups: 'staff' }), true);
        assert.strictEqual(await check(c, { email: 'x@example.com' }), false);
        assert.strictEqual(await check(c, { email: 'x@example.com', groups: ['other'] }), false);
    });

    await ok('userfile names match only with allow_global_userfile', async () => {
        fs.writeFileSync(file, 'ann@example.com:pw\nivan:pw\n');
        assert.strictEqual(await check(ufConfig(true), { email: 'Ann@example.com' }), true);
        assert.strictEqual(await check(ufConfig(false), { email: 'ann@example.com' }), false);
        assert.strictEqual(await check(ufConfig(true), { email: 'bob@example.com' }), false);
    });

    await ok('password with a colon still matches by name', async () => {
        fs.writeFileSync(file, 'ann@example.com:p:w\n');
        assert.strictEqual(await check(ufConfig(true), { email: 'ann@example.com' }), true);
    });

    await ok('userfile line without an email never matches', async () => {
        fs.writeFileSync(file, 'ivan:pw\n');
        assert.strictEqual(await check(ufConfig(true), { email: 'ivan@example.com' }), false);
    });

    await ok('email without a usable @ is never admitted', async () => {
        fs.writeFileSync(file, 'ivan:pw\n');
        const c = { authenticate_userfile: file, oidc: { allow_global_userfile: true, allow_emails: ['ivan'] } };
        assert.strictEqual(await check(c, { email: 'ivan', email_verified: true }), false);
        assert.strictEqual(await check(c, { email: 'ivan@', email_verified: true }), false);
        assert.strictEqual(await check(c, { email: '@ivan', email_verified: true }), false);
    });

    await ok('missing userfile is an empty list', async () => {
        const c = { authenticate_userfile: file + '.nope', oidc: { allow_global_userfile: true } };
        assert.strictEqual(await check(c, { email: 'ann@example.com' }), false);
    });

    await ok('userfile is re-read on every call', async () => {
        fs.writeFileSync(file, 'ann@example.com:pw\n');
        assert.strictEqual(await check(ufConfig(true), { email: 'ann@example.com' }), true);
        fs.writeFileSync(file, 'bob@example.com:pw\n');
        assert.strictEqual(await check(ufConfig(true), { email: 'ann@example.com' }), false);
    });

    await ok('nothing configured refuses everyone', async () => {
        assert.strictEqual(await check({}, { email: 'ann@example.com' }), false);
        assert.strictEqual(await check(oidc({}), { email: 'ann@example.com' }), false);
    });

    await ok('problems()', () => {
        assert.ok(allowlist.problems(oidc({})).length >= 1, 'empty allowlist');
        assert.ok(allowlist.problems(oidc({ allow_emails: [] , allow_groups: [] })).length >= 1);
        assert.deepStrictEqual(allowlist.problems(oidc({ allow_emails: ['a@example.com'] })), []);
        assert.deepStrictEqual(allowlist.problems(oidc({ allow_groups: ['g'] })), []);
        assert.deepStrictEqual(allowlist.problems(
            { authenticate_userfile: '/x', oidc: { allow_global_userfile: true } }), []);
        const w = allowlist.problems({ authenticate: () => {}, oidc: { allow_global_userfile: true } });
        assert.ok(w.length >= 1, 'custom authenticate warning');
        assert.deepStrictEqual(allowlist.problems({}), [], 'OIDC off');
    });

    try { fs.unlinkSync(file); } catch (e) { /* absent */ }
}

// ---- web login -------------------------------------------------------------

function listen(app) {
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function closeServer(server) {
    return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
    });
}

// Starts an in-process app with sessions, oidc.mountWeb and GET /whoami.
// `make` gets the app's base URL and returns the config.oidc to use.
async function webApp(store, make, opts) {
    opts = opts || {};
    const express = require('express');
    const session = require('express-session');
    const oidcMod = require('../oidc.js');
    const app = express();
    const server = await listen(app);
    const base = 'http://127.0.0.1:' + server.address().port;
    const config = { oidc: make(base) };
    const oidc = oidcMod.create(config, store);
    if (!opts.noSession) {
        app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    }
    oidc.mountWeb(app, opts.hooks || { mcp: (pending, claims, res) => res.end('mcp') });
    app.get('/whoami', (req, res) => res.json({
        auth: (req.session && req.session.authentication) || false,
        user: (req.session && req.session.user) || null,
        groups: (req.session && req.session.groups) || null
    }));
    return { base, server, oidc, close: () => closeServer(server) };
}

// fetch with a cookie jar and no automatic redirects.
function browser() {
    const jar = new Map();
    return async function get(url) {
        const cookie = Array.from(jar, ([k, v]) => k + '=' + v).join('; ');
        const res = await fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
        for (const c of res.headers.getSetCookie()) {
            const kv = c.split(';')[0];
            const i = kv.indexOf('=');
            jar.set(kv.slice(0, i), kv.slice(i + 1));
        }
        res.text_ = await res.text();
        return res;
    };
}

async function webLoginSection() {
    console.log('web login');
    const auth_store = require('../auth_store.js');
    const mock_oidc  = require('./helpers/mock_oidc.js');
    const file = path.join(os.tmpdir(), 'db-browse-oidc-test-' + Date.now() + '.sqlite');
    const store = auth_store.open(file);
    const idp = await mock_oidc.start();
    const web = await webApp(store, base => Object.assign(idp.config(), {
        redirect_uri: base + '/oidc/callback',
        allow_emails: ['ann@example.com'],
        allow_groups: ['staff']
    }));

    // Everything the code under test logs, to check no secret leaks.
    const logged = [];
    const origLog = console.log;
    console.log = function () {
        logged.push(Array.from(arguments).join(' '));
        origLog.apply(console, arguments);
    };

    // Runs /login → IdP /authorize → /oidc/callback with a fresh browser.
    async function login(to) {
        const get = browser();
        const start = await get(web.base + '/login' + (to === undefined ? '' : '?to=' + encodeURIComponent(to)));
        assert.strictEqual(start.status, 302, 'login status ' + start.status + ' ' + start.text_);
        const authUrl = new URL(start.headers.get('location'));
        const authz = await get(authUrl.href);
        assert.strictEqual(authz.status, 302, 'authorize status ' + authz.status + ' ' + authz.text_);
        const callbackUrl = authz.headers.get('location');
        const res = await get(callbackUrl);
        const who = JSON.parse((await get(web.base + '/whoami')).text_);
        return { get, authUrl, callbackUrl, res, who };
    }

    function refused(r) {
        assert.strictEqual(r.res.status, 403, 'status ' + r.res.status + ' ' + r.res.text_);
        assert.ok(/^text\/plain/.test(r.res.headers.get('content-type')), r.res.headers.get('content-type'));
        assert.ok(!/nonce|audience|signature|expired|email|state|allow/i.test(r.res.text_),
                  'body names the failed check: ' + r.res.text_);
        assert.strictEqual(r.who.auth, false);
        assert.strictEqual(r.who.user, null);
    }

    await ok('safeLocal', () => {
        const { safeLocal } = require('../oidc.js');
        assert.strictEqual(safeLocal('/ds/table?x=1'), '/ds/table?x=1');
        for (const bad of ['//evil.example', '/\\evil.example', 'http://evil.example', 'javascript:alert(1)',
                           'evil', '', undefined, null, ['/a'], '/login', '/a\nb', '/a\tb']) {
            assert.strictEqual(safeLocal(bad), '/', JSON.stringify(bad));
        }
    });

    await ok('create returns null without config.oidc', () => {
        assert.strictEqual(require('../oidc.js').create({}, store), null);
    });

    await ok('web login: full flow sets the session user', async () => {
        const r = await login();
        const p = r.authUrl.searchParams;
        assert.strictEqual(r.authUrl.origin + r.authUrl.pathname, idp.issuer + '/authorize');
        assert.strictEqual(p.get('code_challenge_method'), 'S256');
        assert.ok(/^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge')), 'code_challenge');
        assert.ok(p.get('state') && p.get('state').length >= 32, 'state');
        assert.ok(p.get('nonce') && p.get('nonce').length >= 32, 'nonce');
        assert.notStrictEqual(p.get('state'), p.get('nonce'));
        assert.strictEqual(p.get('response_type'), 'code');
        assert.strictEqual(p.get('client_id'), idp.config().client_id);
        assert.strictEqual(p.get('redirect_uri'), web.base + '/oidc/callback');
        assert.deepStrictEqual(p.get('scope').split(' ').sort(), ['email', 'openid', 'profile']);
        assert.strictEqual(r.res.status, 302, r.res.text_);
        assert.strictEqual(r.res.headers.get('location'), '/');
        assert.deepStrictEqual(r.who, { auth: true, user: 'ann@example.com', groups: [] });
    });

    await ok('denied by allowlist → 403', async () => {
        idp.next({ email: 'bob@example.com' });
        refused(await login());
    });

    await ok('unverified email → 403', async () => {
        idp.next({ email_verified: false });
        refused(await login());
    });

    await ok('no email claim → 403', async () => {
        idp.next({ email: null, groups: ['staff'] });
        refused(await login());
    });

    await ok('forged signature → 403', async () => {
        idp.next({ badSignature: true });
        refused(await login());
    });

    await ok('wrong audience → 403', async () => {
        idp.next({ aud: 'someone-else' });
        refused(await login());
    });

    await ok('expired ID token → 403', async () => {
        idp.next({ expired: true });
        refused(await login());
    });

    await ok('bad nonce → 403', async () => {
        idp.next({ nonce: 'not-the-nonce' });
        refused(await login());
    });

    await ok('state replay → 403', async () => {
        const r = await login();
        assert.strictEqual(r.res.status, 302);
        const get = browser();
        const again = await get(r.callbackUrl);
        assert.strictEqual(again.status, 403, again.text_);
        assert.ok(/^text\/plain/.test(again.headers.get('content-type')));
        assert.strictEqual(JSON.parse((await get(web.base + '/whoami')).text_).auth, false);
    });

    await ok('unknown state → 403', async () => {
        const get = browser();
        const res = await get(web.base + '/oidc/callback?code=abc&state=nope');
        assert.strictEqual(res.status, 403, res.text_);
        const res2 = await get(web.base + '/oidc/callback');
        assert.strictEqual(res2.status, 403, res2.text_);
    });

    await ok('provider error parameter → 403', async () => {
        const get = browser();
        const start = await get(web.base + '/oidc/login');
        const state = new URL(start.headers.get('location')).searchParams.get('state');
        const res = await get(web.base + '/oidc/callback?error=access_denied&state=' + state);
        assert.strictEqual(res.status, 403, res.text_);
    });

    await ok('to=//evil.example → redirect to /', async () => {
        const r = await login('//evil.example');
        assert.strictEqual(r.res.status, 302);
        assert.strictEqual(r.res.headers.get('location'), '/');
    });

    await ok('to=/ds/table → redirect to /ds/table', async () => {
        const r = await login('/ds/table');
        assert.strictEqual(r.res.status, 302);
        assert.strictEqual(r.res.headers.get('location'), '/ds/table');
        assert.strictEqual(r.who.user, 'ann@example.com');
    });

    await ok('group-only user admitted', async () => {
        idp.next({ email: 'gina@example.com', groups: ['staff', 'other'] });
        const r = await login();
        assert.strictEqual(r.res.status, 302, r.res.text_);
        assert.deepStrictEqual(r.who, { auth: true, user: 'gina@example.com', groups: ['staff', 'other'] });
    });

    await ok('groups claim as a string becomes an array', async () => {
        idp.next({ email: 'gina@example.com', groups: 'staff' });
        const r = await login();
        assert.deepStrictEqual(r.who.groups, ['staff']);
    });

    await ok('provider down → 502', async () => {
        const dead = await listen(require('express')());
        const deadUrl = 'http://127.0.0.1:' + dead.address().port;
        await closeServer(dead);
        const down = await webApp(store, base => ({
            issuer: deadUrl, client_id: 'x', client_secret: 'y',
            redirect_uri: base + '/oidc/callback', allow_emails: ['ann@example.com']
        }));
        try {
            const res = await browser()(down.base + '/login');
            assert.strictEqual(res.status, 502, res.text_);
            assert.ok(/^text\/plain/.test(res.headers.get('content-type')));
        } finally {
            await down.close();
        }
    });

    // Starts /login in `get` and approves at the IdP; returns the callback URL
    // without visiting it.
    async function approved(get) {
        const start = await get(web.base + '/login');
        assert.strictEqual(start.status, 302, start.text_);
        const authz = await get(start.headers.get('location'));
        assert.strictEqual(authz.status, 302, authz.text_);
        return authz.headers.get('location');
    }

    await ok('login CSRF: callback from a browser that never began the login → 403', async () => {
        const attacker = browser();
        const cb = await approved(attacker);
        const victim = browser();
        const res = await victim(cb);
        assert.strictEqual(res.status, 403, res.text_);
        assert.ok(/^text\/plain/.test(res.headers.get('content-type')));
        assert.strictEqual(JSON.parse((await victim(web.base + '/whoami')).text_).user, null);
    });

    await ok('login CSRF: normal flow still works after the binding', async () => {
        const r = await login('/x');
        assert.strictEqual(r.res.status, 302, r.res.text_);
        assert.strictEqual(r.res.headers.get('location'), '/x');
        assert.strictEqual(r.who.user, 'ann@example.com');
    });

    await ok('login CSRF: stale oidc_state does not accept a newer state → 403', async () => {
        const victim = browser();
        const begun = await victim(web.base + '/login');      // victim never completes
        assert.strictEqual(begun.status, 302);
        const cb = await approved(browser());                   // attacker's newer state
        const res = await victim(cb);
        assert.strictEqual(res.status, 403, res.text_);
        assert.strictEqual(JSON.parse((await victim(web.base + '/whoami')).text_).user, null);
    });

    const unhandled = [];
    const onUnhandled = e => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    process.on('uncaughtException', onUnhandled);

    await ok('hooks.mcp that throws → 500 text/plain, server keeps serving', async () => {
        const boom = await webApp(store, base => Object.assign(idp.config(), {
            redirect_uri: base + '/oidc/callback', allow_emails: ['ann@example.com']
        }), { hooks: { mcp: () => { throw new Error('hook failed'); } } });
        try {
            const get = browser();
            const authUrl = await boom.oidc.begin('mcp', { client: 'c1' });
            const authz = await get(authUrl);
            const res = await get(authz.headers.get('location'));
            assert.strictEqual(res.status, 500, res.text_);
            assert.ok(/^text\/plain/.test(res.headers.get('content-type')));
            assert.ok(!/hook failed/.test(res.text_), 'error detail leaked');
            const next = await get(boom.base + '/whoami');
            assert.strictEqual(next.status, 200);
        } finally {
            await boom.close();
        }
    });

    await ok('mountWeb without a session middleware → clean error, no crash', async () => {
        const bare = await webApp(store, base => Object.assign(idp.config(), {
            redirect_uri: base + '/oidc/callback', allow_emails: ['ann@example.com']
        }), { noSession: true });
        try {
            const get = browser();
            const res = await get(bare.base + '/login');
            assert.strictEqual(res.status, 500, res.text_);
            assert.ok(/^text\/plain/.test(res.headers.get('content-type')));
            // A valid web state delivered to it anyway is refused, not a crash.
            const authUrl = await bare.oidc.begin('web', { to: '/' });
            const authz = await get(authUrl);
            const cb = await get(authz.headers.get('location'));
            assert.strictEqual(cb.status, 403, cb.text_);
            assert.strictEqual((await get(bare.base + '/whoami')).status, 200);
        } finally {
            await bare.close();
        }
    });

    await ok('no unhandled rejections or uncaught exceptions', async () => {
        await new Promise(r => setTimeout(r, 50));
        assert.deepStrictEqual(unhandled.map(e => String(e && e.message)), []);
    });
    process.removeListener('unhandledRejection', onUnhandled);
    process.removeListener('uncaughtException', onUnhandled);

    await ok('logs contain no secrets or tokens', () => {
        const secret = idp.config().client_secret;
        for (const line of logged) {
            assert.ok(!line.includes(secret), 'client_secret logged: ' + line);
            assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(line), 'JWT logged: ' + line);
            for (const c of idp.codes()) {
                assert.ok(!line.includes(c), 'code logged: ' + line);
            }
        }
        assert.ok(idp.codes().length > 0);
    });

    console.log = origLog;
    await web.close();
    await idp.close();
    store.close();
    for (const f of [file, file + '-wal', file + '-shm']) {
        try { fs.unlinkSync(f); } catch (e) { /* absent */ }
    }
}

// ---- oauth provider --------------------------------------------------------

async function providerSection() {
    console.log('oauth provider');
    const crypto     = require('crypto');
    const express    = require('express');
    const session    = require('express-session');
    const auth_store = require('../auth_store.js');
    const mock_oidc  = require('./helpers/mock_oidc.js');
    const oidcMod    = require('../oidc.js');
    const providerMod = require('../oauth_provider.js');
    const { mcpAuthRouter } = require('@modelcontextprotocol/sdk/server/auth/router.js');

    const file = path.join(os.tmpdir(), 'db-browse-provider-test-' + Date.now() + '.sqlite');
    const store = auth_store.open(file);
    const idp = await mock_oidc.start();
    const app = express();
    const server = await listen(app);
    const base = 'http://127.0.0.1:' + server.address().port;
    const config = {
        oidc: Object.assign(idp.config(), {
            redirect_uri: base + '/oidc/callback',
            allow_emails: ['ann@example.com']
        }),
        mcp: { oauth: { public_url: base + '/' } }
    };
    const oidc = oidcMod.create(config, store);
    const provider = providerMod.create(config, store, oidc);
    const noLimit = { rateLimit: false };
    app.use(mcpAuthRouter({
        provider,
        issuerUrl: new URL(base),
        resourceServerUrl: new URL(base + '/mcp'),
        authorizationOptions: noLimit, tokenOptions: noLimit,
        clientRegistrationOptions: noLimit, revocationOptions: noLimit
    }));
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    oidc.mountWeb(app, { mcp: provider.complete });

    const logged = [];
    const origLog = console.log;
    console.log = function () {
        logged.push(Array.from(arguments).join(' '));
        origLog.apply(console, arguments);
    };
    const secrets = [];     // every code and token seen, for the log check

    const s256 = v => crypto.createHash('sha256').update(v).digest('base64url');
    const RESOURCE = base + '/mcp';
    const CB = 'http://127.0.0.1:8765/cb';

    async function register(redirect_uris) {
        const res = await fetch(base + '/register', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ redirect_uris, token_endpoint_auth_method: 'none', client_name: 'test' })
        });
        return { status: res.status, body: await res.json() };
    }
    async function client(uris) {
        const r = await register(uris || [CB]);
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        return r.body;
    }
    function authorizeUrl(c, o) {
        o = o || {};
        const u = new URL(base + '/authorize');
        u.searchParams.set('response_type', 'code');
        u.searchParams.set('client_id', o.client_id || c.client_id);
        u.searchParams.set('redirect_uri', o.redirect_uri || c.redirect_uris[0]);
        u.searchParams.set('code_challenge', s256(o.verifier));
        u.searchParams.set('code_challenge_method', 'S256');
        if (o.state) { u.searchParams.set('state', o.state); }
        if (o.resource !== null) { u.searchParams.set('resource', o.resource || RESOURCE); }
        return u.href;
    }
    // /authorize → IdP → /oidc/callback; returns the callback response.
    async function authorize(c, o) {
        const get = browser();
        const a = await get(authorizeUrl(c, o));
        assert.strictEqual(a.status, 302, 'authorize ' + a.status + ' ' + a.text_);
        assert.ok(a.headers.get('location').startsWith(idp.issuer + '/authorize'), a.headers.get('location'));
        const z = await get(a.headers.get('location'));
        assert.strictEqual(z.status, 302, 'idp ' + z.status);
        return get(z.headers.get('location'));
    }
    // A fresh code for client c; returns {code, verifier, location}.
    async function code(c, state, resource) {
        const verifier = auth_store.randomToken() + 'x';
        const res = await authorize(c, { verifier, state, resource });
        assert.strictEqual(res.status, 302, 'callback ' + res.status + ' ' + res.text_);
        const loc = new URL(res.headers.get('location'));
        const value = loc.searchParams.get('code');
        assert.ok(value, 'no code in ' + loc.href);
        secrets.push(value);
        return { code: value, verifier, location: loc };
    }
    async function token(body) {
        const res = await fetch(base + '/token', {
            method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(body)
        });
        const json = await res.json();
        for (const k of ['access_token', 'refresh_token']) { if (json[k]) { secrets.push(json[k]); } }
        return { status: res.status, body: json };
    }
    function exchange(c, got, verifier) {
        return token({ grant_type: 'authorization_code', client_id: c.client_id, code: got.code,
                       code_verifier: verifier || got.verifier, redirect_uri: c.redirect_uris[0],
                       resource: RESOURCE });
    }
    function refresh(c, rt) {
        return token({ grant_type: 'refresh_token', client_id: c.client_id, refresh_token: rt });
    }
    async function tokensFor(c) {
        const t = await exchange(c, await code(c));
        assert.strictEqual(t.status, 200, JSON.stringify(t.body));
        return t.body;
    }
    async function revoke(c, tok) {
        const res = await fetch(base + '/revoke', {
            method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: c.client_id, token: tok })
        });
        return res.status;
    }
    const verifies = async t => {
        try { await provider.verifyAccessToken(t); return true; } catch (e) { return false; }
    };

    await ok('register → authorize → mock IdP → callback → code → token works', async () => {
        const c = await client();
        assert.ok(c.client_id, 'client_id generated');
        const got = await code(c, 'client-state-1');
        assert.strictEqual(got.location.origin + got.location.pathname, CB);
        assert.strictEqual(got.location.searchParams.get('state'), 'client-state-1');
        const t = await exchange(c, got);
        assert.strictEqual(t.status, 200, JSON.stringify(t.body));
        assert.strictEqual(t.body.token_type.toLowerCase(), 'bearer');
        assert.strictEqual(t.body.expires_in, 3600);
        assert.ok(/^[A-Za-z0-9_-]{43}$/.test(t.body.access_token));
        assert.ok(/^[A-Za-z0-9_-]{43}$/.test(t.body.refresh_token));
        const info = await provider.verifyAccessToken(t.body.access_token);
        assert.strictEqual(info.token, t.body.access_token);
        assert.strictEqual(info.clientId, c.client_id);
        assert.deepStrictEqual(info.scopes, []);
        assert.ok(Math.abs(info.expiresAt - (now() + 3600)) <= 2, 'expiresAt ' + info.expiresAt);
        assert.strictEqual(info.resource.href, RESOURCE);
        assert.deepStrictEqual(info.extra, { email: 'ann@example.com' });
    });

    await ok('no state given → none in the redirect', async () => {
        const got = await code(await client());
        assert.strictEqual(got.location.searchParams.has('state'), false);
    });

    await ok('PKCE mismatch is rejected (and burns the code)', async () => {
        const c = await client();
        const got = await code(c);
        const bad = await exchange(c, got, auth_store.randomToken() + 'y');
        assert.strictEqual(bad.status, 400);
        assert.strictEqual(bad.body.error, 'invalid_grant');
        assert.strictEqual((await exchange(c, got)).status, 400, 'code survived a PKCE failure');
    });

    await ok('reused code is rejected', async () => {
        const c = await client();
        const got = await code(c);
        assert.strictEqual((await exchange(c, got)).status, 200);
        const again = await exchange(c, got);
        assert.strictEqual(again.status, 400);
        assert.strictEqual(again.body.error, 'invalid_grant');
    });

    await ok('code with a different redirect_uri or resource is rejected', async () => {
        const c = await client([CB, 'https://app.example/cb']);
        let got = await code(c);
        let t = await token({ grant_type: 'authorization_code', client_id: c.client_id, code: got.code,
                              code_verifier: got.verifier, redirect_uri: 'https://app.example/cb' });
        assert.strictEqual(t.status, 400, JSON.stringify(t.body));
        got = await code(c);
        t = await token({ grant_type: 'authorization_code', client_id: c.client_id, code: got.code,
                          code_verifier: got.verifier, resource: 'https://other.example/mcp' });
        assert.strictEqual(t.status, 400, JSON.stringify(t.body));
    });

    await ok('no resource at /authorize → the grant is for <public_url>/mcp', async () => {
        const c = await client();
        const got = await code(c, undefined, null);
        const t = await token({ grant_type: 'authorization_code', client_id: c.client_id, code: got.code,
                                code_verifier: got.verifier, redirect_uri: c.redirect_uris[0] });
        assert.strictEqual(t.status, 200, JSON.stringify(t.body));
        assert.strictEqual((await provider.verifyAccessToken(t.body.access_token)).resource.href, RESOURCE);
        const r = await refresh(c, t.body.refresh_token);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual((await provider.verifyAccessToken(r.body.access_token)).resource.href, RESOURCE);
    });

    await ok('foreign resource at /authorize → invalid_target to the client, no login, no code', async () => {
        const c = await client();
        for (const resource of ['https://other.example/mcp', base + '/other', base + '/', base + '/mcp/x']) {
            const res = await browser()(authorizeUrl(c, { verifier: 'v'.repeat(43), state: 's1', resource }));
            assert.strictEqual(res.status, 302, resource + ' ' + res.status + ' ' + res.text_);
            const loc = new URL(res.headers.get('location'));
            assert.strictEqual(loc.origin + loc.pathname, CB, resource + ' → ' + loc.href);
            assert.strictEqual(loc.searchParams.get('error'), 'invalid_target', loc.href);
            assert.strictEqual(loc.searchParams.has('code'), false);
            assert.strictEqual(loc.searchParams.get('state'), 's1');
        }
    });

    await ok('a provider without public_url refuses every /authorize resource', async () => {
        const p2 = providerMod.create({ oidc: config.oidc, mcp: { oauth: {} } }, store, oidc);
        const c = store.getClient((await client()).client_id);
        for (const resource of [undefined, new URL(RESOURCE)]) {
            let redirected = false;
            await assert.rejects(p2.authorize(c, { redirectUri: CB, codeChallenge: 'x'.repeat(43), resource },
                                              { redirect: () => { redirected = true; } }),
                                 e => e.errorCode === 'invalid_target');
            assert.strictEqual(redirected, false);
        }
    });

    await ok('unknown client_id on /authorize → error, no redirect', async () => {
        const res = await browser()(authorizeUrl({ client_id: 'nope', redirect_uris: [CB] },
                                                 { verifier: 'v'.repeat(43) }));
        assert.strictEqual(res.status, 400, res.text_);
        assert.strictEqual(res.headers.get('location'), null);
    });

    await ok('unregistered redirect_uri → error, no redirect', async () => {
        const c = await client();
        const res = await browser()(authorizeUrl(c, { verifier: 'v'.repeat(43),
                                                      redirect_uri: 'https://evil.example/cb' }));
        assert.strictEqual(res.status, 400, res.text_);
        assert.strictEqual(res.headers.get('location'), null);
    });

    await ok('registration with http://evil.example redirect is rejected', async () => {
        for (const uris of [['http://evil.example/cb'], [CB, 'http://evil.example/cb'],
                            ['http://localhost.evil.example/cb'], ['ftp://x.example/cb'], ['ftp://localhost/cb'],
                            ['https://app.example/cb#frag'], []]) {
            const r = await register(uris);
            assert.strictEqual(r.status, 400, JSON.stringify(uris) + ' ' + JSON.stringify(r.body));
            assert.ok(/^invalid_(redirect_uri|client_metadata)$/.test(r.body.error), r.body.error);
        }
    });

    await ok('http://127.0.0.1:8765/cb is accepted (and localhost, https)', async () => {
        for (const u of [CB, 'http://localhost/cb', 'http://localhost:3000', 'https://app.example/cb']) {
            const r = await register([u]);
            assert.strictEqual(r.status, 201, u + ' ' + JSON.stringify(r.body));
            assert.deepStrictEqual(store.getClient(r.body.client_id).redirect_uris, [u]);
        }
    });

    await ok('refresh rotates; the old refresh token fails', async () => {
        const c = await client();
        const t1 = await tokensFor(c);
        const r = await refresh(c, t1.refresh_token);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.notStrictEqual(r.body.refresh_token, t1.refresh_token);
        assert.notStrictEqual(r.body.access_token, t1.access_token);
        const info = await provider.verifyAccessToken(r.body.access_token);
        assert.strictEqual(info.clientId, c.client_id);
        assert.strictEqual(info.resource.href, RESOURCE);
        const old = await refresh(c, t1.refresh_token);
        assert.strictEqual(old.status, 400);
        assert.strictEqual(old.body.error, 'invalid_grant');
        assert.strictEqual((await refresh(c, r.body.refresh_token)).status, 200);
    });

    await ok('a refresh token is not an access token and vice versa', async () => {
        const c = await client();
        const t = await tokensFor(c);
        assert.strictEqual(await verifies(t.refresh_token), false);
        assert.strictEqual((await refresh(c, t.access_token)).status, 400);
        assert.strictEqual(await verifies(t.access_token), true);
    });

    await ok('refresh refused after the user leaves the allowlist', async () => {
        const c = await client();
        const t = await tokensFor(c);
        const saved = config.oidc.allow_emails;
        config.oidc.allow_emails = ['someone-else@example.com'];
        try {
            const r = await refresh(c, t.refresh_token);
            assert.strictEqual(r.status, 400, JSON.stringify(r.body));
            assert.strictEqual(r.body.error, 'invalid_grant');
        } finally {
            config.oidc.allow_emails = saved;
        }
    });

    await ok('revoked access token fails verifyAccessToken', async () => {
        const c = await client();
        const t = await tokensFor(c);
        assert.strictEqual(await verifies(t.access_token), true);
        assert.strictEqual(await revoke(c, t.access_token), 200);
        assert.strictEqual(await verifies(t.access_token), false);
        assert.strictEqual(await revoke(c, t.refresh_token), 200);
        assert.strictEqual((await refresh(c, t.refresh_token)).status, 400);
        assert.strictEqual(await revoke(c, 'not-a-token'), 200);
    });

    await ok('expired access token fails', async () => {
        const c = await client();
        const t = await tokensFor(c);
        const raw = new Database(file);
        raw.prepare('UPDATE tokens SET expires_at = ? WHERE token_hash = ?')
           .run(now() - 1, auth_store.hash(t.access_token));
        raw.close();
        assert.strictEqual(await verifies(t.access_token), false);
        assert.strictEqual(await verifies('garbage'), false);
    });

    await ok('expired code is rejected', async () => {
        const c = await client();
        const got = await code(c);
        const raw = new Database(file);
        raw.prepare('UPDATE codes SET expires_at = ? WHERE code_hash = ?').run(now() - 1, auth_store.hash(got.code));
        raw.close();
        assert.strictEqual((await exchange(c, got)).status, 400);
    });

    await ok('config TTLs are honoured; codes live 60 s', async () => {
        const cfg = { oidc: config.oidc, mcp: { oauth: { access_ttl: 120, refresh_ttl: 240 } } };
        const p2 = providerMod.create(cfg, store, oidc);
        const c = await client();
        const got = await code(c);
        const raw = new Database(file, { readonly: true });
        const row = raw.prepare('SELECT expires_at FROM codes WHERE code_hash = ?').get(auth_store.hash(got.code));
        assert.ok(row.expires_at - now() <= 60 && row.expires_at - now() >= 58, 'code ttl ' + (row.expires_at - now()));
        const clientInfo = store.getClient(c.client_id);
        const t = await p2.exchangeAuthorizationCode(clientInfo, got.code, got.verifier, CB);
        secrets.push(t.access_token, t.refresh_token);
        assert.strictEqual(t.expires_in, 120);
        const ttl = h => raw.prepare('SELECT expires_at FROM tokens WHERE token_hash = ?').get(auth_store.hash(h)).expires_at - now();
        assert.ok(Math.abs(ttl(t.access_token) - 120) <= 2);
        assert.ok(Math.abs(ttl(t.refresh_token) - 240) <= 2);
        raw.close();
    });

    await ok('a token issued to client A cannot be used, revoked or refreshed by client B', async () => {
        const a = await client();
        const b = await client();
        const got = await code(a);
        const stolen = await exchange(b, got);
        assert.strictEqual(stolen.status, 400, 'B exchanged A\'s code');
        const t = await tokensFor(a);
        const r = await refresh(b, t.refresh_token);
        assert.strictEqual(r.status, 400);
        assert.strictEqual(r.body.error, 'invalid_grant');
        await revoke(b, t.access_token);
        await revoke(b, t.refresh_token);
        assert.strictEqual(await verifies(t.access_token), true, 'B revoked A\'s access token');
        assert.strictEqual((await refresh(a, t.refresh_token)).status, 200, 'B killed A\'s refresh token');
    });

    await ok('disallowed user never gets a code (403 at callback)', async () => {
        const c = await client();
        idp.next({ email: 'bob@example.com' });
        const res = await authorize(c, { verifier: auth_store.randomToken(), state: 's' });
        assert.strictEqual(res.status, 403, res.text_);
        assert.strictEqual(res.headers.get('location'), null);
        const raw = new Database(file, { readonly: true });
        assert.strictEqual(raw.prepare("SELECT count(*) AS n FROM codes WHERE email = 'bob@example.com'").get().n, 0);
        raw.close();
    });

    await ok('codes and tokens are never stored raw or logged', () => {
        assert.ok(secrets.length > 10);
        const raw = new Database(file, { readonly: true });
        const values = [];
        for (const t of ['codes', 'tokens']) {
            for (const row of raw.prepare('SELECT * FROM ' + t).all()) { values.push(...Object.values(row)); }
        }
        raw.close();
        for (const s of secrets) {
            assert.ok(!values.includes(s), 'raw secret stored');
            for (const line of logged) { assert.ok(!line.includes(s), 'secret logged: ' + line); }
        }
    });

    console.log = origLog;
    await closeServer(server);
    await idp.close();
    store.close();
    for (const f of [file, file + '-wal', file + '-shm']) {
        try { fs.unlinkSync(f); } catch (e) { /* absent */ }
    }
}

// ---- /mcp with OAuth -------------------------------------------------------

async function mcpSection() {
    console.log('mcp');
    const crypto     = require('crypto');
    const express    = require('express');
    const session    = require('express-session');
    const auth_store = require('../auth_store.js');
    const mock_oidc  = require('./helpers/mock_oidc.js');
    const oidcMod    = require('../oidc.js');
    const providerMod = require('../oauth_provider.js');
    const mcp        = require('../mcp.js');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

    const stamp = Date.now();
    const file  = path.join(os.tmpdir(), 'db-browse-mcp-oauth-test-' + stamp + '.sqlite');
    const dbFile = path.join(os.tmpdir(), 'db-browse-mcp-oauth-fixture-' + stamp + '.sqlite');
    const fixture = new Database(dbFile);
    fixture.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
    fixture.close();

    const store = auth_store.open(file);
    const idp = await mock_oidc.start();
    const app = express();
    const server = await listen(app);
    const base = 'http://127.0.0.1:' + server.address().port;
    const STATIC = 'static-test-token-' + crypto.randomBytes(8).toString('hex');
    const config = {
        db: { lite: { type: 'sqlite', database: dbFile, comment: 'fixture' } },
        oidc: Object.assign(idp.config(), {
            redirect_uri: base + '/oidc/callback',
            allow_emails: ['ann@example.com']
        }),
        mcp: { token: STATIC, oauth: { public_url: base } }
    };
    const oidc = oidcMod.create(config, store);
    const provider = providerMod.create(config, store, oidc);
    const mounted = mcp.mount(app, config, provider);
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    oidc.mountWeb(app, { mcp: provider.complete });

    const logged = [];
    const origLog = console.log;
    console.log = function () {
        logged.push(require('util').format.apply(null, arguments));
        origLog.apply(console, arguments);
    };
    const secrets = [];

    const RESOURCE = base + '/mcp';
    const PRM_URL  = base + '/.well-known/oauth-protected-resource/mcp';
    const CB = 'http://127.0.0.1:8765/cb';
    const s256 = v => crypto.createHash('sha256').update(v).digest('base64url');

    // register → /authorize (resource as given; null omits it) → IdP →
    // callback → /token. Returns {client, tokens}.
    async function oauthTokens(resource) {
        const reg = await fetch(base + '/register', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ redirect_uris: [CB], token_endpoint_auth_method: 'none', client_name: 't' })
        });
        assert.strictEqual(reg.status, 201);
        const c = await reg.json();
        const verifier = auth_store.randomToken() + 'z';
        const u = new URL(base + '/authorize');
        u.searchParams.set('response_type', 'code');
        u.searchParams.set('client_id', c.client_id);
        u.searchParams.set('redirect_uri', CB);
        u.searchParams.set('code_challenge', s256(verifier));
        u.searchParams.set('code_challenge_method', 'S256');
        if (resource !== null) { u.searchParams.set('resource', resource || RESOURCE); }
        const get = browser();
        const a = await get(u.href);
        assert.strictEqual(a.status, 302, 'authorize ' + a.status + ' ' + a.text_);
        const z = await get(a.headers.get('location'));
        const cb = await get(z.headers.get('location'));
        assert.strictEqual(cb.status, 302, 'callback ' + cb.status + ' ' + cb.text_);
        const code = new URL(cb.headers.get('location')).searchParams.get('code');
        assert.ok(code, 'no code');
        secrets.push(code);
        const t = await fetch(base + '/token', {
            method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'authorization_code', client_id: c.client_id, code,
                                        code_verifier: verifier, redirect_uri: CB })
        });
        const body = await t.json();
        assert.strictEqual(t.status, 200, JSON.stringify(body));
        secrets.push(body.access_token, body.refresh_token);
        return { client: c, tokens: body };
    }
    async function rawPost(headers) {
        return fetch(base + '/mcp', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json',
                                     Accept: 'application/json, text/event-stream' }, headers),
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        });
    }
    async function sdkClient(token) {
        const client = new Client({ name: 'test', version: '0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(RESOURCE),
            { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
        return client;
    }
    function assert401(r) {
        assert.strictEqual(r.status, 401);
        const h = r.headers.get('www-authenticate') || '';
        assert.ok(/^Bearer /.test(h), h);
        assert.ok(h.includes('resource_metadata="' + PRM_URL + '"'), h);
    }

    await ok('mount() with a provider reports it mounted', () => assert.strictEqual(mounted, true));

    await ok('OAuth token can call tools/list through the SDK client', async () => {
        const { tokens } = await oauthTokens();
        const client = await sdkClient(tokens.access_token);
        try {
            const names = (await client.listTools()).tools.map(t => t.name);
            assert.ok(names.includes('list_tables'), names.join(','));
            const r = await client.callTool({ name: 'list_tables', arguments: { db: 'lite' } });
            assert.ok(JSON.parse(r.content[0].text).includes('items'), r.content[0].text);
        } finally {
            await client.close();
        }
    });

    await ok('a tool call logs the user\'s email, never the token', () => {
        const line = logged.find(l => /^mcp list_tables /.test(l));
        assert.ok(line, 'no tool log line');
        assert.ok(line.includes('ann@example.com'), line);
    });

    await ok('client omitting resource gets a token that works on /mcp', async () => {
        const { tokens } = await oauthTokens(null);
        const client = await sdkClient(tokens.access_token);
        try {
            assert.ok((await client.listTools()).tools.length > 0);
        } finally {
            await client.close();
        }
    });

    await ok('static token still works', async () => {
        const client = await sdkClient(STATIC);
        try {
            const r = await client.callTool({ name: 'list_databases', arguments: {} });
            assert.strictEqual(JSON.parse(r.content[0].text)[0].id, 'lite');
        } finally {
            await client.close();
        }
        const line = logged.filter(l => /^mcp list_databases /.test(l)).pop();
        assert.ok(line && !line.includes('@'), 'static-token call logged a user: ' + line);
    });

    await ok('no token → 401 with resource_metadata', async () => {
        assert401(await rawPost({}));
        const m = await fetch(PRM_URL);
        assert.strictEqual(m.status, 200);
        assert.ok(/json/.test(m.headers.get('content-type')), m.headers.get('content-type'));
        const meta = await m.json();
        assert.deepStrictEqual(meta.authorization_servers, [new URL(base).href]);
        assert.strictEqual(meta.resource, RESOURCE);
    });

    await ok('wrong or malformed token → 401 with resource_metadata', async () => {
        assert401(await rawPost({ Authorization: 'Bearer nope' }));
        assert401(await rawPost({ Authorization: 'Basic ' + Buffer.from('a:b').toString('base64') }));
        assert401(await rawPost({ Authorization: 'Bearer ' }));
    });

    await ok('GET /mcp with an OAuth token → 405 (stateless, as with the static token)', async () => {
        const { tokens } = await oauthTokens();
        const r = await fetch(base + '/mcp', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
        assert.strictEqual(r.status, 405);
        assert401(await fetch(base + '/mcp'));
    });

    await ok('revoked token → 401', async () => {
        const { client, tokens } = await oauthTokens();
        assert.notStrictEqual((await rawPost({ Authorization: 'Bearer ' + tokens.access_token })).status, 401);
        const rv = await fetch(base + '/revoke', {
            method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: client.client_id, token: tokens.access_token })
        });
        assert.strictEqual(rv.status, 200);
        assert401(await rawPost({ Authorization: 'Bearer ' + tokens.access_token }));
    });

    await ok('a refresh token is refused on /mcp', async () => {
        const { tokens } = await oauthTokens();
        assert401(await rawPost({ Authorization: 'Bearer ' + tokens.refresh_token }));
    });

    await ok('expired token → 401', async () => {
        const { tokens } = await oauthTokens();
        const raw = new Database(file);
        raw.prepare('UPDATE tokens SET expires_at = ? WHERE token_hash = ?')
           .run(now() - 1, auth_store.hash(tokens.access_token));
        raw.close();
        assert401(await rawPost({ Authorization: 'Bearer ' + tokens.access_token }));
    });

    await ok('protected-resource and authorization-server metadata are served', async () => {
        const prm = await (await fetch(PRM_URL)).json();
        assert.strictEqual(prm.resource, RESOURCE);
        const r = await fetch(base + '/.well-known/oauth-authorization-server');
        assert.strictEqual(r.status, 200);
        const as = await r.json();
        assert.strictEqual(as.issuer, new URL(base).href);
        assert.strictEqual(as.authorization_endpoint, base + '/authorize');
        assert.strictEqual(as.token_endpoint, base + '/token');
        assert.strictEqual(as.registration_endpoint, base + '/register');
        assert.strictEqual(as.revocation_endpoint, base + '/revoke');
        assert.deepStrictEqual(as.code_challenge_methods_supported, ['S256']);
    });

    await ok('token issued for another resource is refused', async () => {
        const t = auth_store.randomToken();
        secrets.push(t);
        const row = { token_hash: auth_store.hash(t), kind: 'access', client_id: 'c-other',
                      email: 'ann@example.com', groups: [], expires_at: now() + 600 };
        store.putToken(Object.assign({ resource: 'https://other.example/mcp' }, row));
        assert401(await rawPost({ Authorization: 'Bearer ' + t }));
        const t2 = auth_store.randomToken();
        secrets.push(t2);
        store.putToken(Object.assign({}, row, { token_hash: auth_store.hash(t2), resource: null }));
        assert401(await rawPost({ Authorization: 'Bearer ' + t2 }));
    });

    await ok('mcp.mount returns false with neither token nor provider', async () => {
        const bare = express();
        assert.strictEqual(mcp.mount(bare, { db: {} }), false);
        assert.strictEqual(mcp.mount(bare, { db: {}, mcp: { oauth: { public_url: base } } }), false);
        const s = await listen(bare);
        try {
            const r = await fetch('http://127.0.0.1:' + s.address().port + '/mcp', { method: 'POST' });
            assert.strictEqual(r.status, 404);
        } finally {
            await closeServer(s);
        }
    });

    await ok('provider without token: OAuth works, any static-looking token is refused', async () => {
        const app2 = express();
        const s = await listen(app2);
        const base2 = 'http://127.0.0.1:' + s.address().port;
        const cfg2 = { db: config.db, oidc: config.oidc, mcp: { oauth: { public_url: base2 } } };
        try {
            assert.strictEqual(mcp.mount(app2, cfg2, providerMod.create(cfg2, store, oidc)), true);
            const r = await fetch(base2 + '/mcp', {
                method: 'POST', headers: { Authorization: 'Bearer ' + STATIC, 'Content-Type': 'application/json' },
                body: '{}' });
            assert.strictEqual(r.status, 401);
            assert.ok((r.headers.get('www-authenticate') || '').includes(
                'resource_metadata="' + base2 + '/.well-known/oauth-protected-resource/mcp"'));
        } finally {
            await closeServer(s);
        }
    });

    await ok('a provider without mcp.oauth.public_url is a mount error', () => {
        assert.throws(() => mcp.mount(express(), { db: {}, mcp: { token: 't' } }, provider), /public_url/);
    });

    await ok('tokens are never logged', () => {
        assert.ok(secrets.length > 5);
        for (const s of secrets.concat([STATIC])) {
            for (const line of logged) { assert.ok(!line.includes(s), 'secret logged: ' + line); }
        }
    });

    console.log = origLog;
    await closeServer(server);
    await idp.close();
    store.close();
    for (const f of [file, file + '-wal', file + '-shm', dbFile]) {
        try { fs.unlinkSync(f); } catch (e) { /* absent */ }
    }
}

// ---- app wiring (spawned start.js) -----------------------------------------
//
// Runs the real start.js with DBB_CONFIG pointing at a temporary config, on a
// free port, with in-memory sessions. Everything it writes goes to a temp dir:
// the real config.js, users.txt and usersRequests.sqlite are never touched.

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = require('net').createServer();
        probe.on('error', reject);
        probe.listen(0, 'localhost', () => {
            const p = probe.address().port;
            probe.close(() => resolve(p));
        });
    });
}

function portIsOpen(port) {
    return new Promise((resolve) => {
        const socket = require('net').connect({ port, host: 'localhost' });
        const done = (open) => { socket.destroy(); resolve(open); };
        socket.setTimeout(500);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error',   () => done(false));
    });
}

// Spawns start.js with `configFile`. Resolves {child, output()} once the port
// accepts connections; rejects if the child exits first.
// With opts.fileSessions the config's own session store is kept (it must
// point into a temp dir), so sessions survive a restart.
function spawnApp(dir, configFile, port, opts) {
    const { spawn } = require('child_process');
    const env = Object.assign({}, process.env, {
        DBB_CONFIG: configFile, DBB_PORT: String(port), DBB_SESSION_MEMORY: '1',
        SQLITE_PATH: path.join(dir, 'usersRequests.sqlite')
    });
    if (opts && opts.fileSessions) { delete env.DBB_SESSION_MEMORY; }
    const child = spawn(process.execPath, ['start.js'], {
        cwd: path.join(__dirname, '..'),
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { out += c; });
    const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
    const ready = new Promise((resolve, reject) => {
        let settled = false;
        exited.then(code => {
            if (!settled) { settled = true; reject(new Error('server exited (' + code + '): ' + out.trim())); }
        });
        const deadline = Date.now() + 10000;
        (function poll() {
            if (settled) { return; }
            portIsOpen(port).then(open => {
                if (settled) { return; }
                if (open) { settled = true; return resolve(); }
                if (Date.now() > deadline) { settled = true; return reject(new Error('start timed out: ' + out)); }
                setTimeout(poll, 100);
            });
        })();
    });
    return { child, exited, ready, output: () => out };
}

function writeConfig(file, cfg) {
    fs.writeFileSync(file, 'module.exports = ' + JSON.stringify(cfg, null, 2) + ';\n');
}

// Like writeConfig, with session-file-store sessions in storeDir.
function writeFileSessionConfig(file, cfg, storeDir) {
    fs.writeFileSync(file,
        'const session = require(' + JSON.stringify(require.resolve('express-session')) + ');\n' +
        'const FileStore = require(' + JSON.stringify(require.resolve('session-file-store')) + ')(session);\n' +
        'module.exports = ' + JSON.stringify(cfg, null, 2) + ';\n' +
        'module.exports.session_config.store = new FileStore({ path: ' + JSON.stringify(storeDir) +
        ', logFn: function () {} });\n');
}

async function wiringSection() {
    console.log('app wiring');
    const crypto    = require('crypto');
    const mock_oidc = require('./helpers/mock_oidc.js');
    const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'db-browse-wiring-'));
    const dbFile = path.join(dir, 'fixture.sqlite');
    const fixture = new Database(dbFile);
    fixture.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
    fixture.close();

    const idp  = await mock_oidc.start();
    const port = await freePort();
    const base = 'http://localhost:' + port;
    const STATIC = 'static-test-token-' + crypto.randomBytes(8).toString('hex');
    const config = {
        listen: { host: 'localhost', port },
        db: { lite: { type: 'sqlite', database: dbFile } },
        session_config: { secret: 'wiring-test', resave: false, saveUninitialized: false },
        oidc: Object.assign(idp.config(), {
            redirect_uri: base + '/oidc/callback',
            allow_emails: ['ann@example.com']
        }),
        mcp: { token: STATIC, oauth: { public_url: base } },
        auth_db: path.join(dir, 'auth.sqlite'),
        addons: {}      // listDatabase.pug needs app.addons, set only with config.addons
    };
    const configFile = path.join(dir, 'config.js');
    writeConfig(configFile, config);

    // A config the app must refuse to start with; resolves {code, output}.
    async function refusedStart(name, cfg) {
        const f = path.join(dir, name + '.js');
        writeConfig(f, cfg);
        const app = spawnApp(dir, f, await freePort());
        app.ready.catch(() => {});
        const timer = setTimeout(() => app.child.kill(), 10000);
        const code = await app.exited;
        clearTimeout(timer);
        return { code, output: app.output() };
    }

    const app = spawnApp(dir, configFile, port);
    const secrets = [STATIC, idp.config().client_secret];
    try {
        await app.ready;

        // /login → IdP → /oidc/callback in one browser; returns the callback response.
        async function browserLogin(get, to) {
            const start = await get(base + '/login?to=' + encodeURIComponent(to));
            assert.strictEqual(start.status, 302, 'login ' + start.status + ' ' + start.text_);
            const z = await get(start.headers.get('location'));
            assert.strictEqual(z.status, 302, 'authorize ' + z.status);
            return get(z.headers.get('location'));
        }

        await ok('GET / redirects to /login?to=%2F', async () => {
            const r = await fetch(base + '/', { redirect: 'manual' });
            assert.strictEqual(r.status, 302);
            assert.strictEqual(r.headers.get('location'), '/login?to=%2F');
        });

        await ok('a deep link redirects to /login with the path in to=', async () => {
            const r = await fetch(base + '/lite/items?x=1', { redirect: 'manual' });
            assert.strictEqual(r.status, 302);
            assert.strictEqual(r.headers.get('location'), '/login?to=' + encodeURIComponent('/lite/items?x=1'));
        });

        await ok('GET /login redirects to the issuer with S256 challenge', async () => {
            const r = await fetch(base + '/login?to=%2F', { redirect: 'manual' });
            assert.strictEqual(r.status, 302);
            const u = new URL(r.headers.get('location'));
            assert.strictEqual(u.origin + u.pathname, idp.issuer + '/authorize');
            assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
            assert.ok(/^[A-Za-z0-9_-]{43}$/.test(u.searchParams.get('code_challenge')));
            assert.strictEqual(u.searchParams.get('redirect_uri'), base + '/oidc/callback');
        });

        await ok('POST /login returns 404 (no password bypass)', async () => {
            const r = await fetch(base + '/login', {
                method: 'POST', redirect: 'manual',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: 'user=ann%40example.com&pass=x&to=%2F'
            });
            assert.strictEqual(r.status, 404);
            assert.ok(!r.headers.get('set-cookie'), 'set a cookie');
        });

        await ok('full browser flow as ann@example.com ends on / with 200', async () => {
            const get = browser();
            const cb = await browserLogin(get, '/lite');
            assert.strictEqual(cb.status, 302, cb.text_);
            assert.strictEqual(cb.headers.get('location'), '/lite');
            const home = await get(base + '/');
            assert.strictEqual(home.status, 200, home.text_.slice(0, 200));
            assert.ok(home.text_.includes('lite'), 'database list');
            assert.ok(home.text_.includes('/logout'), 'logout link');
            const tables = await get(base + '/lite');
            assert.strictEqual(tables.status, 200);
            assert.ok(tables.text_.includes('items'), 'table list');
        });

        await ok('other@example.com gets 403 at the callback', async () => {
            idp.next({ email: 'other@example.com' });
            const get = browser();
            const cb = await browserLogin(get, '/');
            assert.strictEqual(cb.status, 403);
            const home = await get(base + '/');
            assert.strictEqual(home.status, 302);
        });

        await ok('POST /mcp without a token → 401 with resource_metadata', async () => {
            const r = await fetch(base + '/mcp', {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
            assert.strictEqual(r.status, 401);
            const h = r.headers.get('www-authenticate') || '';
            assert.ok(h.includes('resource_metadata="' + base + '/.well-known/oauth-protected-resource/mcp"'), h);
            assert.ok(!r.headers.get('set-cookie'), '/mcp created a session');
        });

        await ok('POST /mcp with the static token is not 401', async () => {
            const r = await fetch(base + '/mcp', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + STATIC, 'Content-Type': 'application/json',
                           Accept: 'application/json, text/event-stream' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
            });
            assert.notStrictEqual(r.status, 401);
            assert.strictEqual(r.status, 200);
        });

        await ok('both /.well-known metadata documents return 200', async () => {
            const prm = await fetch(base + '/.well-known/oauth-protected-resource/mcp');
            assert.strictEqual(prm.status, 200);
            assert.strictEqual((await prm.json()).resource, base + '/mcp');
            const as = await fetch(base + '/.well-known/oauth-authorization-server');
            assert.strictEqual(as.status, 200);
            assert.strictEqual((await as.json()).token_endpoint, base + '/token');
        });

        await ok('MCP OAuth: register, authorize, token and a tools/list call', async () => {
            const CB = 'http://127.0.0.1:8765/cb';
            const reg = await fetch(base + '/register', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ redirect_uris: [CB], token_endpoint_auth_method: 'none' })
            });
            assert.strictEqual(reg.status, 201);
            const c = await reg.json();
            const verifier = crypto.randomBytes(32).toString('base64url');
            const u = new URL(base + '/authorize');
            u.search = new URLSearchParams({
                response_type: 'code', client_id: c.client_id, redirect_uri: CB,
                code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
                code_challenge_method: 'S256', state: 'st'
            }).toString();
            const get = browser();
            const a = await get(u.href);
            assert.strictEqual(a.status, 302, 'authorize ' + a.status + ' ' + a.text_);
            const z = await get(a.headers.get('location'));
            const cb = await get(z.headers.get('location'));
            assert.strictEqual(cb.status, 302, 'callback ' + cb.status + ' ' + cb.text_);
            const back = new URL(cb.headers.get('location'));
            assert.strictEqual(back.origin + back.pathname, CB);
            assert.strictEqual(back.searchParams.get('state'), 'st');
            const code = back.searchParams.get('code');
            secrets.push(code);
            const t = await fetch(base + '/token', {
                method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ grant_type: 'authorization_code', client_id: c.client_id,
                                            code, code_verifier: verifier, redirect_uri: CB })
            });
            const tok = await t.json();
            assert.strictEqual(t.status, 200, JSON.stringify(tok.error || ''));
            secrets.push(tok.access_token, tok.refresh_token);
            const r = await fetch(base + '/mcp', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json',
                           Accept: 'application/json, text/event-stream' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
            });
            assert.strictEqual(r.status, 200);
        });

        await ok('the server never logs codes, tokens or the client secret', () => {
            const out = app.output();
            for (const s of secrets.concat(idp.codes())) {
                assert.ok(s && !out.includes(s), 'secret in server output: ' +
                          out.split('\n').filter(l => l.includes(s)).map(l => l.split(s).join('<SECRET>')).join(' | '));
            }
        });
    } finally {
        app.child.kill();
        await app.exited;
    }

    // A session made by the users.txt login, persisted in the session store,
    // must not count as signed in once OIDC is switched on.
    await ok('a password-era session is sent to /login once OIDC is on', async () => {
        const storeDir = path.join(dir, 'sessions');
        const usersFile = path.join(dir, 'users.txt');
        fs.writeFileSync(usersFile, 'ann@example.com:pw\n');
        const common = {
            db: config.db, addons: {}, auth_db: config.auth_db, authenticate_userfile: usersFile,
            session_config: { secret: 'wiring-test', resave: false, saveUninitialized: false }
        };
        const pA = await freePort();
        const fA = path.join(dir, 'password.js');
        writeFileSessionConfig(fA, Object.assign({ listen: { host: 'localhost', port: pA } }, common), storeDir);
        const a = spawnApp(dir, fA, pA, { fileSessions: true });
        let cookie;
        try {
            await a.ready;
            const r = await fetch('http://localhost:' + pA + '/login', {
                method: 'POST', redirect: 'manual',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: 'user=ann%40example.com&pass=pw&to=%2F'
            });
            assert.strictEqual(r.status, 302, 'password login ' + r.status);
            cookie = (r.headers.get('set-cookie') || '').split(';')[0];
            assert.ok(cookie, 'no session cookie');
            const home = await fetch('http://localhost:' + pA + '/', { headers: { cookie } });
            assert.strictEqual(home.status, 200, 'password session works without OIDC');
        } finally {
            a.child.kill();
            await a.exited;
        }

        const pB = await freePort();
        const bBase = 'http://localhost:' + pB;
        const fB = path.join(dir, 'oidc-filesessions.js');
        writeFileSessionConfig(fB, Object.assign({ listen: { host: 'localhost', port: pB } }, common, {
            oidc: Object.assign(idp.config(), {
                redirect_uri: bBase + '/oidc/callback', allow_emails: ['ann@example.com'] })
        }), storeDir);
        const b = spawnApp(dir, fB, pB, { fileSessions: true });
        try {
            await b.ready;
            for (const u of ['/', '/lite', '/ao/config?ao=x', '/_reset']) {
                const r = await fetch(bBase + u, { redirect: 'manual', headers: { cookie } });
                assert.strictEqual(r.status, 302, u + ' ' + r.status);
                assert.strictEqual(r.headers.get('location'), '/login?to=' + encodeURIComponent(u), u);
            }
            // and a real OIDC login on the same instance still works
            const get = browser();
            const start = await get(bBase + '/login');
            const z = await get(start.headers.get('location'));
            const cb = await get(z.headers.get('location'));
            assert.strictEqual(cb.status, 302, 'callback ' + cb.status);
            assert.strictEqual((await get(bBase + '/')).status, 200);
        } finally {
            b.child.kill();
            await b.exited;
        }
    });

    await ok('config with mcp.oauth but no oidc exits non-zero with a message', async () => {
        const cfg = Object.assign({}, config);
        delete cfg.oidc;
        const r = await refusedStart('no-oidc', cfg);
        assert.notStrictEqual(r.code, 0);
        assert.ok(/mcp\.oauth/.test(r.output) && /oidc/.test(r.output), r.output);
        assert.ok(!/Server has started/.test(r.output), r.output);
    });

    await ok('mcp.oauth.public_url with a path, query or hash, or missing, exits non-zero', async () => {
        for (const pub of [base + '/dbb', base + '/?x=1', base + '/#f', 'not a url', undefined]) {
            const cfg = Object.assign({}, config, { mcp: { oauth: pub === undefined ? {} : { public_url: pub } } });
            const r = await refusedStart('bad-public-url', cfg);
            assert.notStrictEqual(r.code, 0, String(pub));
            assert.ok(/public_url/.test(r.output), r.output);
        }
    });

    await ok('oidc with no usable allowlist starts with a warning and refuses everyone', async () => {
        const f = path.join(dir, 'no-allowlist.js');
        const p = await freePort();
        const b = 'http://localhost:' + p;
        writeConfig(f, Object.assign({}, config, {
            listen: { host: 'localhost', port: p },
            oidc: Object.assign(idp.config(), { redirect_uri: b + '/oidc/callback' }),
            mcp: undefined
        }));
        const app2 = spawnApp(dir, f, p);
        try {
            await app2.ready;
            assert.ok(/Warning: oidc is enabled but no allowlist source is usable/.test(app2.output()),
                      app2.output());
            const get = browser();
            const start = await get(b + '/login');
            const z = await get(start.headers.get('location'));
            const cb = await get(z.headers.get('location'));
            assert.strictEqual(cb.status, 403);
        } finally {
            app2.child.kill();
            await app2.exited;
        }
    });

    await idp.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
    await storeSection();
    await allowlistSection();
    await webLoginSection();
    await providerSection();
    await mcpSection();
    await wiringSection();
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
