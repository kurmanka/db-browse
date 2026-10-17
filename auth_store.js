// SQLite persistence for OAuth/OIDC state: dynamically registered clients,
// pending logins, authorization codes and access/refresh tokens.
// Codes and tokens are stored only as the hashes the caller passes in.
// All times are epoch seconds.
const crypto   = require('crypto');
const Database = require('better-sqlite3');

function hash(s) {
    return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function randomToken() {
    return crypto.randomBytes(32).toString('base64url');
}

const nowSec = () => Math.floor(Date.now() / 1000);
const parse  = (s) => (s === null || s === undefined) ? s : JSON.parse(s);

function open(file) {
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec(
        'CREATE TABLE IF NOT EXISTS clients ('
        + 'client_id TEXT PRIMARY KEY NOT NULL, info TEXT NOT NULL);'
        + 'CREATE TABLE IF NOT EXISTS pending ('
        + 'state TEXT PRIMARY KEY NOT NULL, nonce TEXT, verifier TEXT, '
        + 'kind TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL);'
        + 'CREATE TABLE IF NOT EXISTS codes ('
        + 'code_hash TEXT PRIMARY KEY NOT NULL, client_id TEXT NOT NULL, email TEXT NOT NULL, '
        + 'groups TEXT NOT NULL, challenge TEXT, redirect_uri TEXT, resource TEXT, '
        + 'expires_at INTEGER NOT NULL);'
        + 'CREATE TABLE IF NOT EXISTS tokens ('
        + 'token_hash TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, client_id TEXT NOT NULL, '
        + 'email TEXT NOT NULL, groups TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL);'
    );

    const q = {
        addClient: db.prepare('INSERT OR REPLACE INTO clients (client_id, info) VALUES (?, ?)'),
        getClient: db.prepare('SELECT info FROM clients WHERE client_id = ?'),
        putPending: db.prepare('INSERT OR REPLACE INTO pending (state, nonce, verifier, kind, data, expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
        takePending: db.prepare('DELETE FROM pending WHERE state = ? RETURNING *'),
        putCode: db.prepare('INSERT OR REPLACE INTO codes (code_hash, client_id, email, groups, challenge, redirect_uri, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
        takeCode: db.prepare('DELETE FROM codes WHERE code_hash = ? RETURNING *'),
        putToken: db.prepare('INSERT OR REPLACE INTO tokens (token_hash, kind, client_id, email, groups, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
        getToken: db.prepare('SELECT * FROM tokens WHERE token_hash = ? AND expires_at > ?'),
        takeToken: db.prepare('DELETE FROM tokens WHERE token_hash = ? RETURNING *'),
        revoke: db.prepare('DELETE FROM tokens WHERE token_hash = ?'),
        purgePending: db.prepare('DELETE FROM pending WHERE expires_at <= ?'),
        purgeCodes: db.prepare('DELETE FROM codes WHERE expires_at <= ?'),
        purgeTokens: db.prepare('DELETE FROM tokens WHERE expires_at <= ?')
    };

    const live = (row) => (row && row.expires_at > nowSec()) ? row : undefined;

    function purgeExpired() {
        const t = nowSec();
        q.purgePending.run(t);
        q.purgeCodes.run(t);
        q.purgeTokens.run(t);
    }

    return {
        addClient(c) {
            q.addClient.run(c.client_id, JSON.stringify(c));
        },
        getClient(id) {
            const row = q.getClient.get(id);
            return row ? JSON.parse(row.info) : undefined;
        },
        putPending(p) {
            purgeExpired();
            q.putPending.run(p.state, p.nonce, p.verifier, p.kind,
                             JSON.stringify(p.data || {}), p.expires_at);
        },
        takePending(state) {
            const row = live(q.takePending.get(state));
            if (row) row.data = parse(row.data);
            return row;
        },
        putCode(c) {
            purgeExpired();
            q.putCode.run(c.code_hash, c.client_id, c.email, JSON.stringify(c.groups || []),
                          c.challenge, c.redirect_uri, c.resource, c.expires_at);
        },
        takeCode(codeHash) {
            const row = live(q.takeCode.get(codeHash));
            if (row) row.groups = parse(row.groups);
            return row;
        },
        putToken(t) {
            purgeExpired();
            q.putToken.run(t.token_hash, t.kind, t.client_id, t.email,
                           JSON.stringify(t.groups || []), t.resource, t.expires_at);
        },
        getToken(tokenHash) {
            const row = q.getToken.get(tokenHash, nowSec());
            if (row) row.groups = parse(row.groups);
            return row;
        },
        takeToken(tokenHash) {
            const row = live(q.takeToken.get(tokenHash));
            if (row) row.groups = parse(row.groups);
            return row;
        },
        revoke(tokenHash) {
            q.revoke.run(tokenHash);
        },
        purgeExpired,
        close() {
            db.close();
        }
    };
}

exports.open        = open;
exports.hash        = hash;
exports.randomToken = randomToken;
