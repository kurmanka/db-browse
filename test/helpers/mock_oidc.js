// A minimal OpenID Connect provider for tests: discovery, JWKS (RS256), an
// auto-approving /authorize and a /token endpoint that checks PKCE (S256) and
// returns an ID token. next(overrides) shapes the next ID token issued:
//   email (null omits it), email_verified, groups, sub, aud, nonce,
//   expired (exp in the past), badSignature (signed with another key).

'use strict';
const crypto  = require('crypto');
const express = require('express');

const CLIENT_ID     = 'dbb-test-client';
const CLIENT_SECRET = 'dbb-test-secret-' + crypto.randomBytes(8).toString('hex');
const KID           = 'test-key';

const s256 = v => crypto.createHash('sha256').update(v).digest('base64url');

async function start() {
    const jose = await import('jose');
    const good = await jose.generateKeyPair('RS256');
    const evil = await jose.generateKeyPair('RS256');
    const jwk  = Object.assign(await jose.exportJWK(good.publicKey), { kid: KID, alg: 'RS256', use: 'sig' });

    const codes  = new Map();   // code -> {nonce, challenge, redirect_uri}
    const issued = [];          // every code handed out, for log checks
    let overrides = {};

    const app = express();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const issuer = 'http://127.0.0.1:' + server.address().port;

    app.get('/.well-known/openid-configuration', (req, res) => res.json({
        issuer,
        authorization_endpoint: issuer + '/authorize',
        token_endpoint: issuer + '/token',
        jwks_uri: issuer + '/jwks',
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256']
    }));

    app.get('/jwks', (req, res) => res.json({ keys: [jwk] }));

    app.get('/authorize', (req, res) => {
        const q = req.query;
        if (q.response_type !== 'code' || q.client_id !== CLIENT_ID || typeof q.redirect_uri !== 'string' ||
            q.code_challenge_method !== 'S256' || typeof q.code_challenge !== 'string' ||
            typeof q.state !== 'string' || typeof q.nonce !== 'string') {
            return res.status(400).send('bad authorization request');
        }
        const code = crypto.randomBytes(16).toString('hex');
        codes.set(code, { nonce: q.nonce, challenge: q.code_challenge, redirect_uri: q.redirect_uri });
        issued.push(code);
        const to = new URL(q.redirect_uri);
        to.searchParams.set('code', code);
        to.searchParams.set('state', q.state);
        res.redirect(302, to.href);
    });

    app.post('/token', express.urlencoded({ extended: false }), async (req, res) => {
        const b = req.body;
        let id = b.client_id, secret = b.client_secret;
        const basic = /^Basic (.+)$/.exec(req.get('authorization') || '');
        if (basic) {
            const pair = Buffer.from(basic[1], 'base64').toString();
            const i = pair.indexOf(':');
            id = decodeURIComponent(pair.slice(0, i));
            secret = decodeURIComponent(pair.slice(i + 1));
        }
        if (id !== CLIENT_ID || secret !== CLIENT_SECRET) {
            return res.status(401).json({ error: 'invalid_client' });
        }
        const c = codes.get(b.code);
        codes.delete(b.code);
        if (b.grant_type !== 'authorization_code' || !c || b.redirect_uri !== c.redirect_uri ||
            typeof b.code_verifier !== 'string' || s256(b.code_verifier) !== c.challenge) {
            return res.status(400).json({ error: 'invalid_grant' });
        }

        const o = overrides;
        overrides = {};
        const now = Math.floor(Date.now() / 1000);
        const claims = {
            sub: o.sub || 'user-1',
            nonce: 'nonce' in o ? o.nonce : c.nonce,
            email: 'email' in o ? o.email : 'ann@example.com',
            email_verified: 'email_verified' in o ? o.email_verified : true
        };
        if (claims.email === null) { delete claims.email; }
        if ('groups' in o) { claims.groups = o.groups; }
        const id_token = await new jose.SignJWT(claims)
            .setProtectedHeader({ alg: 'RS256', kid: KID })
            .setIssuer(issuer)
            .setAudience(o.aud || CLIENT_ID)
            .setIssuedAt(o.expired ? now - 7200 : now)
            .setExpirationTime(o.expired ? now - 3600 : now + 300)
            .sign(o.badSignature ? evil.privateKey : good.privateKey);
        res.json({ access_token: 'at-' + crypto.randomBytes(8).toString('hex'),
                   token_type: 'Bearer', expires_in: 300, id_token });
    });

    return {
        issuer,
        config: () => ({ issuer, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
        next: (o) => { overrides = Object.assign({}, o); },
        codes: () => issued.slice(),
        close: () => new Promise(resolve => {
            server.close(() => resolve());
            server.closeAllConnections();
        })
    };
}

exports.start = start;
