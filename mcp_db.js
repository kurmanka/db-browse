// Dedicated read-only database connections for the MCP interface.
//
// These are kept apart from the web UI's connection cache in start.js: the web
// UI can run arbitrary SQL on its connections (/:db:sql), so sharing a session
// would let a read-only transaction interleave with a web query.
//
// Read-only is enforced by the database, never by looking at the SQL text:
//   sqlite   - the file is opened read-only, a statement runs only if SQLite
//              says it is read-only, and ATTACHed files are detached after
//              every call (see db_sqlite.js)
//   postgres - every call runs inside BEGIN READ ONLY ... ROLLBACK
//   mysql    - every call runs inside START TRANSACTION READ ONLY ... ROLLBACK,
//              after SET SESSION TRANSACTION READ ONLY (for DDL; unverified)
// (session-wide settings alone would not do: the caller's own SQL can switch
// them off)

'use strict';
var pg        = require('pg');
var mysql     = require('mysql2');
var db_sqlite = require('./db_sqlite.js');

var DEFAULT_TIMEOUT_MS = 30000;

// how long past its timeout a statement may go unanswered before the watchdog
// in wrap() drops the connection (the database's own timeout should come first)
var STUCK_GRACE_MS = 5000;
var stuckGraceMs = STUCK_GRACE_MS;

var connections = Object.create(null);   // dbId -> Promise of a connected connection


// Credentials for the MCP connection. If readonly_user is set, use it: a DB
// role with only SELECT grants backs up the transaction-level protection.
function connectionConfig(c) {
    var cc = {
        host    : c.host,
        user    : c.user,
        password: c.password,
        database: c.database,
        port    : c.port
    };
    if (c.readonly_user) {
        cc.user     = c.readonly_user;
        cc.password = c.readonly_password;
    }
    return cc;
}


// Runs one job at a time. A job is function(release) and must call release()
// exactly once when it is finished.
function makeQueue() {
    var pending = [];
    var busy = false;

    function next() {
        if (busy || !pending.length) { return; }
        busy = true;
        pending.shift()(function () {
            busy = false;
            next();
        });
    }

    return function enqueue(job) {
        pending.push(job);
        next();
    };
}


// runner(sql, params, cb) executes ONE statement read-only and calls cb with
// the driver's native arguments, which the db_*.js modules expect:
//   sqlite (err, rows) / postgres (err, result) / mysql (err, rows, fields)
//
// Calls are serialized: the multi-step BEGIN..ROLLBACK sequences must not
// interleave, and e.g. getTableDetails() fires several queries at once.
//
// view(onError) gives one tool call its own handle on the connection. If a
// db_*.js callback throws (rowsCounter() does on a missing table), onError gets
// the exception, instead of it escaping into the driver and killing the process.
//
// Watchdog: with timeoutMs, a statement that has not answered within timeoutMs
// plus a grace period (the database's own timeout should have fired by then)
// fails with an error, close() is called (once per connection), and the queue
// moves on; if the runner answers later after all, that answer is ignored.
// close() must drop the connection hard and forget it, so the next
// getConnection() opens a new one (open() passes such a close).
// Without the watchdog one stuck statement would stall every later call.
function wrap(runner, close, timeoutMs) {
    var enqueue = makeQueue();
    var closed = false;
    var limit = Number(timeoutMs);
    var watch = isFinite(limit) && limit > 0;

    return {
        view: function (onError) {
            return {
                query: function (sql, params, cb) {
                    if (typeof params === 'function') {
                        cb = params;
                        params = undefined;
                    }
                    enqueue(function (release) {
                        var settled = false;
                        var timer = null;

                        function deliver(args) {
                            try {
                                cb.apply(null, args);
                            } catch (e) {
                                onError(e);
                            } finally {
                                release();
                            }
                        }

                        if (watch) {
                            // setTimeout treats more than 2^31-1 ms as 1 ms
                            timer = setTimeout(function () {
                                settled = true;
                                if (!closed) {
                                    closed = true;
                                    try { close(); } catch (e) {}
                                }
                                deliver([new Error('Statement did not return in time; connection dropped')]);
                            }, Math.min(limit + stuckGraceMs, 2147483647));
                        }

                        runner(sql, params, function () {
                            if (settled) { return; }   // too late: the job has failed already
                            settled = true;
                            clearTimeout(timer);
                            deliver(arguments);
                        });
                    });
                }
            };
        },
        close: close
    };
}


function sqliteDriver(cc) {
    var conn = db_sqlite.createConnection(Object.assign({}, cc, { readonly: true }));
    return {
        open  : conn.connect,
        runner: function (sql, params, cb) { conn.query(sql, params || [], cb); }
    };
}


// Postgres: BEGIN READ ONLY / SET LOCAL statement_timeout / <statement> / ROLLBACK.
// The caller's statement is sent with queryMode 'extended', which makes pg use
// the extended protocol even when there are no parameters; that protocol refuses
// several commands in one string, so nobody can smuggle in "COMMIT; ...".
// (Not the `rows` option: with it pg sends no Sync after an error, and the
// connection hangs.)
function pgDriver(cc, timeoutMs, onLost) {
    var client = new pg.Client(cc);
    client.on('error', onLost);

    function run(sql, params, cb) {
        client.query('BEGIN READ ONLY', function (err) {
            if (err) { return cb(err); }
            client.query('SET LOCAL statement_timeout = ' + Number(timeoutMs), function (err) {
                if (err) { return finish(err); }
                client.query({ text: sql, values: params || [], queryMode: 'extended' }, finish);
            });
        });

        function finish(err, result) {
            client.query('ROLLBACK', function () { cb(err, result); });
        }
    }

    return {
        open  : function (done) { client.connect(done); },
        runner: run,
        // a hard close: on a dead socket end() alone may never finish
        close : function () {
            client.end(function () {});
            if (client.connection && client.connection.stream) { client.connection.stream.destroy(); }
        }
    };
}

// MySQL: SET SESSION max_execution_time / SET SESSION TRANSACTION READ ONLY /
// START TRANSACTION READ ONLY / <statement> / ROLLBACK. mysql2 runs one
// statement per call (multipleStatements is off). Session variables are not
// undone by ROLLBACK and the caller's own SQL can change them, so they are set
// again on every call.
// The session-level READ ONLY is there for DDL (DROP, TRUNCATE, CREATE, ALTER,
// RENAME, GRANT...): MySQL commits the open transaction before such a statement,
// so the READ ONLY transaction no longer covers it; the session default should.
// NOT YET VERIFIED against a real MySQL server.
function mysqlDriver(cc, timeoutMs, onLost) {
    var conn = mysql.createConnection(cc);
    var warned = false;
    conn.on('error', onLost);

    function run(sql, params, cb) {
        // MariaDB calls this max_statement_time: there the SET fails, the
        // statement runs without a timeout, and we say so once
        conn.query('SET SESSION max_execution_time = ' + Number(timeoutMs), function (err) {
            if (err && !warned) {
                warned = true;
                console.log('MCP: could not apply the statement timeout on a mysql connection: ' + err.message);
            }
            // unlike the timeout, this one must work
            conn.query('SET SESSION TRANSACTION READ ONLY', function (err) {
                if (err) { return cb(err); }
                conn.query('START TRANSACTION READ ONLY', function (err) {
                    if (err) { return cb(err); }
                    var args = params ? [sql, params] : [sql];
                    conn.query.apply(conn, args.concat(finish));
                });
            });
        });

        function finish(err, rows, fields) {
            conn.query('ROLLBACK', function () { cb(err, rows, fields); });
        }
    }

    return {
        open  : function (done) { conn.connect(function (err) { done(err); }); },
        runner: run,
        // a hard close: end() would queue a QUIT behind a stuck statement, and
        // mysql2's destroy() only half-closes the socket
        close : function () {
            conn.destroy();
            if (conn.stream) { conn.stream.destroy(); }
        }
    };
}


function pingSql(type) {
    return (type == 'sqlite') ? 'SELECT 1' : 'SELECT NOW()';
}

function ping(conn, type) {
    return new Promise(function (resolve, reject) {
        conn.view(reject).query(pingSql(type), function (err) {
            if (err) { reject(err); } else { resolve(); }
        });
    });
}


// onLost() is called if the connection dies on its own, so it gets dropped from the cache
function open(config, dbId, onLost) {
    var c = config.db[dbId];
    var cc = connectionConfig(c);
    var timeoutMs = (config.mcp && config.mcp.timeout_ms) || DEFAULT_TIMEOUT_MS;
    var driver;

    if (c.type == 'postgres') {
        driver = pgDriver(cc, timeoutMs, onLost);
    } else if (c.type == 'mysql') {
        driver = mysqlDriver(cc, timeoutMs, onLost);
    } else if (c.type == 'sqlite') {
        driver = sqliteDriver(cc);
    } else {
        return Promise.reject(new Error("Unsupported database type '" + c.type + "'"));
    }

    // close() forgets the connection as well, for the watchdog in wrap();
    // sqlite has no close (and, being synchronous, cannot get stuck)
    var conn = wrap(driver.runner, function () {
        onLost();
        if (driver.close) { driver.close(); }
    }, timeoutMs);
    return new Promise(function (resolve, reject) {
        driver.open(function (err) {
            if (err) { reject(err); } else { resolve(conn); }
        });
    });
}


function forget(dbId, promise) {
    if (connections[dbId] === promise) { delete connections[dbId]; }
}

// A connected, read-only connection for config.db[dbId]; opened lazily, pinged
// on reuse, reopened if the ping fails.
function getConnection(config, dbId) {
    // dbId may be client input: only own keys count ('constructor' etc. do not)
    var c = Object.prototype.hasOwnProperty.call(config.db, dbId) && config.db[dbId];
    if (!c) {
        return Promise.reject(new Error('No such database: ' + dbId));
    }

    var cached = connections[dbId];
    if (cached) {
        var reopen = function () {
            forget(dbId, cached);
            return getConnection(config, dbId);
        };
        return cached.then(function (conn) {
            return ping(conn, c.type).then(function () { return conn; }, function () {
                try { if (conn.close) { conn.close(); } } catch (e) {}
                return reopen();
            });
        }, reopen);
    }

    var p;
    p = open(config, dbId, function () { forget(dbId, p); });
    connections[dbId] = p;
    p.catch(function () { forget(dbId, p); });
    return p;
}


// fn(connection, done) calls a db_*.js function with a read-only connection.
// Resolves with what that function hands to done; rejects on an error, and also
// if one of its callbacks throws.
function callDb(config, dbId, fn) {
    return getConnection(config, dbId).then(function (conn) {
        return new Promise(function (resolve, reject) {
            fn(conn.view(reject), function (err, result) {
                if (err) { reject(err); } else { resolve(result); }
            });
        });
    });
}


// tests only: a shorter grace; no argument restores the default
function setStuckGraceMs(ms) {
    stuckGraceMs = (ms === undefined) ? STUCK_GRACE_MS : ms;
}

exports.connectionConfig = connectionConfig;
exports.wrap             = wrap;       // exported for tests
exports.setStuckGraceMs  = setStuckGraceMs;
exports.getConnection    = getConnection;
exports.callDb           = callDb;
