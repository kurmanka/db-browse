// Per-database access: which signed-in users may use which config.db entries.
// A database without an `allow` key is open to every signed-in user;
// `allow: []` is for superusers only. Malformed lists fail closed.

var has = Object.prototype.hasOwnProperty;

// Matches every database: the static MCP token.
exports.ALL = Object.freeze({});

function isStringArray(v) {
    return Array.isArray(v) && v.every(function (s) { return typeof s === 'string'; });
}

function lower(s) {
    return String(s).trim().toLowerCase();
}

// who matches an entry: an email/username (case-insensitive) or `group:<name>` (exact).
function matches(list, who) {
    var name   = typeof who.name === 'string' ? lower(who.name) : '';
    var groups = Array.isArray(who.groups) ? who.groups
        : (typeof who.groups === 'string' ? [who.groups] : []);
    for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (e.indexOf('group:') === 0) {
            if (groups.indexOf(e.slice(6)) >= 0) { return true; }
        } else if (name !== '' && lower(e) === name) {
            return true;
        }
    }
    return false;
}

exports.fromSession = function (session) {
    return { name: session && session.user, groups: session && session.groups };
};

exports.canUse = function (config, who, dbId) {
    if (!config || !config.db || !has.call(config.db, dbId)) { return false; }
    if (who === exports.ALL) { return true; }
    who = who || {};
    var su = isStringArray(config.superusers) ? config.superusers : [];
    if (matches(su, who)) { return true; }
    var entry = config.db[dbId];
    if (!entry || !has.call(entry, 'allow')) { return true; }
    if (!isStringArray(entry.allow)) { return false; }
    return matches(entry.allow, who);
};

exports.visible = function (config, who) {
    var out = {};
    Object.keys((config && config.db) || {}).forEach(function (id) {
        if (exports.canUse(config, who, id)) { out[id] = config.db[id]; }
    });
    return out;
};

exports.problems = function (config) {
    var out = [];
    if (!config) { return out; }
    if (config.superusers !== undefined && !isStringArray(config.superusers)) {
        out.push('superusers must be an array of strings: ignored, so nobody is a superuser');
    }
    Object.keys(config.db || {}).forEach(function (id) {
        var entry = config.db[id];
        if (entry && has.call(entry, 'allow') && !isStringArray(entry.allow)) {
            out.push('db.' + id + '.allow must be an array of strings: only superusers can use this database');
        }
    });
    return out;
};
