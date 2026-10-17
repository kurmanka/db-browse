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

async function main() {
    await storeSection();
    await allowlistSection();
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
