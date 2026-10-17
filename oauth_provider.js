// OAuth 2.1 authorization server for MCP clients: the provider behind the MCP
// SDK's mcpAuthRouter. A client's /authorize is brokered to the upstream OIDC
// login (oidc.js, pending kind 'mcp'); after the allowlist passes, complete()
// issues our own single-use code bound to the client, its redirect URI, PKCE
// challenge and resource. Codes and tokens are opaque random values; only
// their SHA-256 hashes are stored. Nothing here logs a code, token or secret.
//
// The SDK's error classes decide the HTTP status (an OAuthError is a 400),
// so they are required lazily: requiring this module never loads the SDK.

var crypto     = require('crypto');
var auth_store = require('./auth_store.js');
var allowlist  = require('./allowlist.js');

var CODE_TTL = 60;      // seconds

// `name` is an SDK error class, or else an RFC error code.
function oauthError(name, message) {
    var E = require('@modelcontextprotocol/sdk/server/auth/errors.js');
    return E[name] ? new E[name](message) : new E.CustomOAuthError(name, message);
}

function nowSec() {
    return Math.floor(Date.now() / 1000);
}

// https: anywhere, or http: on localhost / 127.0.0.1 (native clients). No fragment.
function redirectUriOk(u) {
    var url;
    try { url = new URL(u); } catch (e) { return false; }
    if (url.hash || u.indexOf('#') >= 0) { return false; }
    if (url.protocol === 'https:') { return true; }
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

// RFC 7636 4.1 verifier, checked against an S256 challenge in constant time.
function pkceOk(verifier, challenge) {
    if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) { return false; }
    if (typeof challenge !== 'string') { return false; }
    var a = Buffer.from(crypto.createHash('sha256').update(verifier).digest('base64url'));
    var b = Buffer.from(challenge);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The one resource tokens are issued for: <config.mcp.oauth.public_url>/mcp,
// as a URL href; null without a public_url.
function mcpResourceUrl(config) {
    var pub = config && config.mcp && config.mcp.oauth && config.mcp.oauth.public_url;
    return pub ? new URL(String(pub).replace(/\/+$/, '') + '/mcp').href : null;
}

function create(config, store, oidc) {
    var oc = (config && config.mcp && config.mcp.oauth) || {};
    var accessTtl  = oc.access_ttl  || 3600;
    var refreshTtl = oc.refresh_ttl || 2592000;
    var mcpResource = mcpResourceUrl(config);

    function allowed(email, groups) {
        return new Promise(function (resolve) {
            allowlist.isAllowed(config, { email: email, groups: groups }, function (err, ok) {
                if (err) { console.log('oauth: allowlist error: ' + err.message); }
                resolve(!err && ok === true);
            });
        });
    }

    function issue(clientId, email, groups, resource) {
        var access  = auth_store.randomToken();
        var refresh = auth_store.randomToken();
        var t = nowSec();
        var common = { client_id: clientId, email: email, groups: groups, resource: resource || null };
        store.putToken(Object.assign({ token_hash: auth_store.hash(access), kind: 'access',
                                       expires_at: t + accessTtl }, common));
        store.putToken(Object.assign({ token_hash: auth_store.hash(refresh), kind: 'refresh',
                                       expires_at: t + refreshTtl }, common));
        return { access_token: access, token_type: 'Bearer', expires_in: accessTtl, refresh_token: refresh };
    }

    // A resource named in a token request must be the one the grant was for.
    function sameResource(requested, granted) {
        return requested === undefined || requested.href === granted;
    }

    var clientsStore = {
        getClient: function (clientId) {
            return store.getClient(clientId);
        },
        // The SDK has already generated client_id (and a secret for
        // confidential clients); it is never taken from the request.
        registerClient: function (client) {
            var uris = client.redirect_uris;
            if (!Array.isArray(uris) || uris.length === 0 || !uris.every(redirectUriOk)) {
                throw oauthError('invalid_redirect_uri',
                    'redirect_uris must be https, or http on localhost or 127.0.0.1, without a fragment');
            }
            if (typeof client.client_id !== 'string' || !client.client_id ||
                store.getClient(client.client_id)) {
                throw new Error('registerClient: missing or duplicate client_id');
            }
            store.addClient(client);
            return client;
        }
    };

    // Every grant is for the MCP endpoint: a request without `resource` gets
    // it, one naming anything else is refused (without public_url, all are).
    async function authorize(client, params, res) {
        var resource = params.resource ? params.resource.href : mcpResource;
        if (!mcpResource || resource !== mcpResource) {
            throw oauthError('InvalidTargetError', 'resource must be ' + (mcpResource || 'configured'));
        }
        var url = await oidc.begin('mcp', {
            client_id: client.client_id,
            redirect_uri: params.redirectUri,
            state: params.state,
            challenge: params.codeChallenge,
            resource: resource
        });
        res.redirect(302, url);
    }

    // hooks.mcp for oidc.mountWeb: runs only after the allowlist passed.
    // Anything thrown here becomes a 500 in oidc.js's callback.
    async function complete(pending, claims, res) {
        var d = (pending && pending.data) || {};
        if (typeof d.client_id !== 'string' || typeof d.redirect_uri !== 'string' ||
            typeof d.challenge !== 'string' || typeof claims.email !== 'string') {
            throw new Error('incomplete mcp authorization request');
        }
        var code = auth_store.randomToken();
        store.putCode({
            code_hash: auth_store.hash(code), client_id: d.client_id,
            email: claims.email, groups: claims.groups || [],
            challenge: d.challenge, redirect_uri: d.redirect_uri, resource: d.resource || null,
            expires_at: nowSec() + CODE_TTL
        });
        var to = new URL(d.redirect_uri);
        to.searchParams.set('code', code);
        if (typeof d.state === 'string') { to.searchParams.set('state', d.state); }
        res.redirect(302, to.href);
    }

    // PKCE is checked in exchangeAuthorizationCode (skipLocalPkceValidation),
    // after the code is taken: a failed attempt burns the code, and the code
    // is looked up only once, atomically. The SDK therefore never calls this.
    async function challengeForAuthorizationCode() {
        throw new Error('challengeForAuthorizationCode is not used: PKCE is checked at exchange');
    }

    async function exchangeAuthorizationCode(client, code, codeVerifier, redirectUri, resource) {
        var row = typeof code === 'string' ? store.takeCode(auth_store.hash(code)) : undefined;
        if (!row || row.client_id !== client.client_id) {
            throw oauthError('InvalidGrantError', 'Invalid or expired authorization code');
        }
        if (!pkceOk(codeVerifier, row.challenge)) {
            throw oauthError('InvalidGrantError', 'code_verifier does not match the challenge');
        }
        if (redirectUri !== undefined && redirectUri !== row.redirect_uri) {
            throw oauthError('InvalidGrantError', 'redirect_uri does not match the authorization request');
        }
        if (!sameResource(resource, row.resource)) {
            throw oauthError('InvalidTargetError', 'resource does not match the authorization request');
        }
        return issue(row.client_id, row.email, row.groups, row.resource);
    }

    async function exchangeRefreshToken(client, refreshToken, scopes, resource) {
        var h = auth_store.hash(refreshToken);
        // Checked before taking, so another client cannot destroy the token.
        var row = store.getToken(h);
        if (!row || row.kind !== 'refresh' || row.client_id !== client.client_id) {
            throw oauthError('InvalidGrantError', 'Invalid or expired refresh token');
        }
        if (!sameResource(resource, row.resource)) {
            throw oauthError('InvalidTargetError', 'resource does not match the grant');
        }
        row = store.takeToken(h);
        if (!row) { throw oauthError('InvalidGrantError', 'Invalid or expired refresh token'); }
        if (!(await allowed(row.email, row.groups))) {
            throw oauthError('InvalidGrantError', 'Access denied');
        }
        return issue(row.client_id, row.email, row.groups, row.resource);
    }

    async function verifyAccessToken(token) {
        var row = typeof token === 'string' ? store.getToken(auth_store.hash(token)) : undefined;
        if (!row || row.kind !== 'access') {
            throw oauthError('InvalidTokenError', 'Invalid or expired access token');
        }
        return {
            token: token,
            clientId: row.client_id,
            scopes: [],
            expiresAt: row.expires_at,
            resource: row.resource ? new URL(row.resource) : undefined,
            extra: { email: row.email }
        };
    }

    // RFC 7009: an unknown token, or one issued to another client, is a no-op.
    async function revokeToken(client, request) {
        var h = auth_store.hash(request.token);
        var row = store.getToken(h);
        if (row && row.client_id === client.client_id) { store.revoke(h); }
    }

    return {
        clientsStore: clientsStore,
        skipLocalPkceValidation: true,
        authorize: authorize,
        challengeForAuthorizationCode: challengeForAuthorizationCode,
        exchangeAuthorizationCode: exchangeAuthorizationCode,
        exchangeRefreshToken: exchangeRefreshToken,
        verifyAccessToken: verifyAccessToken,
        revokeToken: revokeToken,
        complete: complete
    };
}

exports.create = create;
exports.mcpResourceUrl = mcpResourceUrl;
