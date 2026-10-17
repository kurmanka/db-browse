// Upstream OpenID Connect login: authorization-code flow with PKCE (S256).
// Pending logins (state, nonce, verifier) live in the auth store, not the
// session; the ID token is verified with jose. jose is ESM-only and loaded
// lazily, so requiring this module never loads it.
//
// Failures: validation problems reject with .status 403 and a generic
// message; an unreachable provider rejects with .status 502. The specific
// reason is logged server-side; tokens, codes and the client secret never are.

var crypto     = require('crypto');
var auth_store = require('./auth_store.js');
var allowlist  = require('./allowlist.js');

var PENDING_TTL = 600;          // seconds
var HTTP_TIMEOUT = 10000;       // ms
var DENIED = 'Access denied.';

var josePromise = null;
function loadJose() {
    if (!josePromise) {
        josePromise = import('jose').catch(function (e) { josePromise = null; throw e; });
    }
    return josePromise;
}

function fail(status, reason) {
    console.log('oidc: ' + reason);
    var e = new Error(status === 502 ? 'Identity provider unavailable.' : DENIED);
    e.status = status;
    return e;
}

// `to` when it is a local path starting with a single '/', else '/'.
function safeLocal(to) {
    if (typeof to !== 'string' || to === '' || to === '/login') { return '/'; }
    if (to[0] !== '/' || to[1] === '/' || to.indexOf('\\') >= 0) { return '/'; }
    if (/[\u0000-\u001f\u007f]/.test(to)) { return '/'; }
    return to;
}

function groupsFrom(v) {
    if (Array.isArray(v)) { return v.filter(function (g) { return typeof g === 'string'; }); }
    if (typeof v === 'string') { return [v]; }
    return [];
}

function create(config, store) {
    var oc = config && config.oidc;
    if (!oc) { return null; }

    var groupsClaim = oc.groups_claim || 'groups';
    var discovered = null;      // promise of {meta, jwks}; kept only on success

    async function httpFetch(url, opts, what) {
        try {
            return await fetch(url, Object.assign({ signal: AbortSignal.timeout(HTTP_TIMEOUT) }, opts));
        } catch (e) {
            throw fail(502, what + ' unreachable: ' + (e.cause && e.cause.code || e.name));
        }
    }

    async function fetchDiscovery() {
        var url = String(oc.issuer).replace(/\/+$/, '') + '/.well-known/openid-configuration';
        var res = await httpFetch(url, {}, 'discovery');
        if (!res.ok) { throw fail(502, 'discovery returned HTTP ' + res.status); }
        var meta;
        try { meta = await res.json(); } catch (e) { throw fail(502, 'discovery is not JSON'); }
        if (!meta || meta.issuer !== oc.issuer) {
            throw fail(502, 'discovery issuer does not match config.oidc.issuer');
        }
        var need = ['authorization_endpoint', 'token_endpoint', 'jwks_uri'];
        for (var i = 0; i < need.length; i++) {
            if (typeof meta[need[i]] !== 'string') { throw fail(502, 'discovery lacks ' + need[i]); }
        }
        var jose = await loadJose();
        return { meta: meta, jwks: jose.createRemoteJWKSet(new URL(meta.jwks_uri)) };
    }

    function discovery() {
        if (!discovered) {
            discovered = fetchDiscovery();
            discovered.catch(function () { discovered = null; });
        }
        return discovered;
    }

    async function begin(kind, data) {
        var d = await discovery();
        var state    = auth_store.randomToken();
        var nonce    = auth_store.randomToken();
        var verifier = auth_store.randomToken();
        store.putPending({
            state: state, nonce: nonce, verifier: verifier, kind: kind, data: data || {},
            expires_at: Math.floor(Date.now() / 1000) + PENDING_TTL
        });
        var u = new URL(d.meta.authorization_endpoint);
        u.searchParams.set('response_type', 'code');
        u.searchParams.set('client_id', oc.client_id);
        u.searchParams.set('redirect_uri', oc.redirect_uri);
        u.searchParams.set('scope', 'openid email profile');
        u.searchParams.set('state', state);
        u.searchParams.set('nonce', nonce);
        u.searchParams.set('code_challenge',
                           crypto.createHash('sha256').update(verifier).digest('base64url'));
        u.searchParams.set('code_challenge_method', 'S256');
        return u.href;
    }

    async function exchange(d, code, verifier) {
        var body = new URLSearchParams({
            grant_type: 'authorization_code', code: code,
            redirect_uri: oc.redirect_uri, code_verifier: verifier, client_id: oc.client_id
        });
        var headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
        if (oc.client_secret) {     // client_secret_basic (RFC 6749 2.3.1)
            headers.authorization = 'Basic ' + Buffer.from(
                encodeURIComponent(oc.client_id) + ':' + encodeURIComponent(oc.client_secret)
            ).toString('base64');
        }
        var res = await httpFetch(d.meta.token_endpoint, { method: 'POST', headers: headers, body: body },
                                  'token endpoint');
        if (res.status >= 500) { throw fail(502, 'token endpoint returned HTTP ' + res.status); }
        if (!res.ok) { throw fail(403, 'token endpoint refused the code: HTTP ' + res.status); }
        var tok;
        try { tok = await res.json(); } catch (e) { throw fail(403, 'token response is not JSON'); }
        if (!tok || typeof tok.id_token !== 'string') { throw fail(403, 'token response has no id_token'); }
        return tok.id_token;
    }

    async function finish(query) {
        query = query || {};
        var state = typeof query.state === 'string' ? query.state : '';
        var pending = state ? store.takePending(state) : undefined;
        if (!pending) { throw fail(403, 'unknown, used or expired state'); }
        if (query.error) { throw fail(403, 'provider returned an error response'); }
        if (typeof query.code !== 'string' || !query.code) { throw fail(403, 'callback has no code'); }

        var d = await discovery();
        var idToken = await exchange(d, query.code, pending.verifier);

        var jose = await loadJose();
        var payload;
        try {
            payload = (await jose.jwtVerify(idToken, d.jwks, {
                issuer: oc.issuer,
                audience: oc.client_id,
                requiredClaims: ['exp', 'sub'],
                clockTolerance: 30
            })).payload;
        } catch (e) {
            if (e && e.code === 'ERR_JWKS_TIMEOUT') { throw fail(502, 'JWKS unreachable'); }
            throw fail(403, 'ID token rejected: ' + (e && e.code || 'error'));
        }
        if (typeof payload.nonce !== 'string' || payload.nonce !== pending.nonce) {
            throw fail(403, 'ID token nonce mismatch');
        }
        return {
            pending: pending,
            claims: {
                sub: payload.sub,
                email: typeof payload.email === 'string' ? payload.email : undefined,
                email_verified: payload.email_verified,
                groups: groupsFrom(payload[groupsClaim])
            }
        };
    }

    function sendError(res, e) {
        var status = e && (e.status === 403 || e.status === 502) ? e.status : 500;
        if (status === 500) { console.log('oidc: unexpected error: ' + (e && e.message)); }
        res.status(status).type('text/plain').send(status === 403 ? DENIED : status === 502
            ? 'Identity provider unavailable.' : 'Login failed.');
    }

    function mountWeb(app, hooks) {
        function start(req, res) {
            begin('web', { to: safeLocal(req.query.to) }).then(function (url) {
                res.redirect(302, url);
            }, function (e) { sendError(res, e); });
        }
        app.get('/login', start);
        app.get('/oidc/login', start);

        app.get('/oidc/callback', function (req, res) {
            finish(req.query).then(function (r) {
                allowlist.isAllowed(config, r.claims, function (err, allowed) {
                    if (err || !allowed) {
                        console.log('oidc: identity not on the allowlist' + (err ? ' (error)' : ''));
                        return sendError(res, { status: 403 });
                    }
                    if (r.pending.kind === 'mcp') {
                        return hooks.mcp(r.pending, r.claims, res);
                    }
                    if (r.pending.kind !== 'web') { return sendError(res, { status: 403 }); }
                    // A fresh session id on login (no session fixation).
                    req.session.regenerate(function (err2) {
                        if (err2) { return sendError(res, err2); }
                        req.session.authentication = true;
                        req.session.user   = r.claims.email || r.claims.sub;
                        req.session.groups = r.claims.groups;
                        req.session.save(function (err3) {
                            if (err3) { return sendError(res, err3); }
                            res.redirect(302, safeLocal(r.pending.data && r.pending.data.to));
                        });
                    });
                });
            }, function (e) { sendError(res, e); });
        });
    }

    return { begin: begin, finish: finish, mountWeb: mountWeb };
}

exports.create    = create;
exports.safeLocal = safeLocal;
