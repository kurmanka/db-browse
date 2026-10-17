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
async function webApp(store, make) {
    const express = require('express');
    const session = require('express-session');
    const oidcMod = require('../oidc.js');
    const app = express();
    const server = await listen(app);
    const base = 'http://127.0.0.1:' + server.address().port;
    const config = { oidc: make(base) };
    const oidc = oidcMod.create(config, store);
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    oidc.mountWeb(app, { mcp: (pending, claims, res) => res.end('mcp') });
    app.get('/whoami', (req, res) => res.json({
        auth: req.session.authentication || false,
        user: req.session.user || null,
        groups: req.session.groups || null
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

async function main() {
    await storeSection();
    await allowlistSection();
    await webLoginSection();
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
