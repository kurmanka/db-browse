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

async function main() {
    await storeSection();
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
