// OIDC allowlist: decides whether a verified identity may sign in.
// Fails closed: with no source configured, everyone is refused.

var fs   = require('fs');
var util = require('./util.js');

function lower(s) {
    return String(s).trim().toLowerCase();
}

function asArray(v) {
    if (v === undefined || v === null) { return []; }
    return Array.isArray(v) ? v : [v];
}

// Names (text before the first colon) from config.authenticate_userfile.
// Read on every call. Passwords are never looked at. Errors give [].
function userfileNames(config, done) {
    fs.readFile(config.authenticate_userfile, 'utf8', function (err, text) {
        if (err) {
            console.log('allowlist: cannot read userfile: ' + err.message);
            return done([]);
        }
        util.getArrayOfStrings(text, function (err2, lines) {
            if (err2 || !lines) {
                console.log('allowlist: cannot parse userfile');
                return done([]);
            }
            done(lines.map(function (line) {
                var i = line.indexOf(':');
                return lower(i < 0 ? line : line.slice(0, i));
            }));
        });
    });
}

exports.isAllowed = function (config, claims, done) {
    var oidc   = (config && config.oidc) || {};
    var email  = claims && typeof claims.email === 'string' ? lower(claims.email) : '';

    var at = email.indexOf('@');
    if (at < 1 || at === email.length - 1 || claims.email_verified === false) {
        return done(null, false);
    }

    var emails = asArray(oidc.allow_emails).map(lower);
    if (emails.indexOf(email) >= 0) { return done(null, true); }

    var groups = asArray(oidc.allow_groups);
    var mine   = asArray(claims.groups);
    for (var i = 0; i < mine.length; i++) {
        if (groups.indexOf(mine[i]) >= 0) { return done(null, true); }
    }

    if (oidc.allow_global_userfile && config.authenticate_userfile) {
        return userfileNames(config, function (names) {
            done(null, names.indexOf(email) >= 0);
        });
    }
    done(null, false);
};

exports.problems = function (config) {
    var out  = [];
    var oidc = config && config.oidc;
    if (!oidc) { return out; }

    var usable = asArray(oidc.allow_emails).length > 0 ||
                 asArray(oidc.allow_groups).length > 0 ||
                 (oidc.allow_global_userfile && config.authenticate_userfile);
    if (!usable) {
        out.push('oidc is enabled but no allowlist source is usable ' +
                 '(set oidc.allow_emails, oidc.allow_groups, or ' +
                 'oidc.allow_global_userfile with authenticate_userfile): everyone will be refused');
    }
    if (oidc.allow_global_userfile && !config.authenticate_userfile && config.authenticate) {
        out.push('oidc.allow_global_userfile has no effect: only a custom authenticate ' +
                 'function is configured, not authenticate_userfile');
    }
    return out;
};
