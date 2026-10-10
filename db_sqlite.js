var async    = require('async');
var Database = require('better-sqlite3');

// wraps a better-sqlite3 Database (sync API) behind the same
// connect(done) / query(sql, [params], done) shape mysql2 and pg use,
// so the rest of the app doesn't need to know sqlite is different.
function createConnection(cc) {
    var db = null;

    return {
        connect: function (done) {
            try {
                db = new Database(cc.database, { readonly: !!cc.readonly });
                done(null);
            } catch (err) {
                done(err);
            }
        },

        query: function (sql, params, callback) {
            if (typeof params === 'function') {
                callback = params;
                params = [];
            }

            if (cc.readonly) {
                var out = readOnlyQuery(db, sql, params);
                return callback(out.err, out.rows);
            }

            try {
                var stmt = db.prepare(sql);
                var rows;
                if (stmt.reader) {
                    rows = stmt.all(params);
                } else {
                    stmt.run(params);
                    rows = [];
                }
                callback(null, rows);
            } catch (err) {
                callback(err);
            }
        }
    };
}

// A connection opened with cc.readonly (the MCP interface; the web UI never sets
// it). Opening the file read-only is not enough on its own: SQLite still lets
// such a handle write VACUUM INTO files and temp tables, and ATTACH any file.
//  - a statement runs only if SQLite itself says it is read-only
//    (sqlite3_stmt_readonly, via stmt.readonly): VACUUM INTO, CREATE TEMP ...,
//    PRAGMA journal_mode=... are refused
//  - after every statement, even a failed one, every schema other than main and
//    temp is detached, so an ATTACH is never there for a later call. (Each call
//    is one statement: prepare() refuses a string with several.) If that fails,
//    the handle is closed, and later calls fail until it is reopened.
// Returns { err, rows }; the caller calls back once, outside any try.
function readOnlyQuery(db, sql, params) {
    var err = null, rows;
    try {
        var stmt = db.prepare(sql);
        if (!stmt.readonly) {
            throw new Error('Not a read-only statement; this connection is read-only');
        }
        if (stmt.reader) {
            rows = stmt.all(params);
        } else {
            stmt.run(params);
            rows = [];
        }
    } catch (e) {
        err = e;
    }

    try {
        db.prepare('PRAGMA database_list').all().forEach(function (d) {
            if (d.name !== 'main' && d.name !== 'temp') {
                db.prepare('DETACH DATABASE ' + escapeId(d.name)).run();
            }
        });
    } catch (e) {
        try { db.close(); } catch (e2) {}
        if (!err) { err = e; rows = undefined; }
    }
    return { err: err, rows: rows };
}

function escapeId(id) {
    return '"' + String(id).replace(/"/g, '""') + '"';
}

// a row limit, safe to concatenate: LIMIT takes a constant, not a placeholder
function limitClause (limit) {
    // Number(), not parseInt(): '1; DROP TABLE t' must not become 1
    var n = Number(limit);
    return (Number.isInteger(n) && n > 0) ? " LIMIT " + n : " LIMIT 100 ";
}

// a sort direction, safe to concatenate: only these two words are emitted
function directionWord (direction) {
    return (direction === 'DESC') ? 'DESC' : 'ASC';
}

function showAllTable(connection, doneReturn) {
    connection.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        function (err, rows) {
            if (err) {
                return doneReturn(err);
            }
            doneReturn(null, rows.map(function (r) { return r.name; }));
        }
    );
}

function rowsCounter(connection, table, done) {
    connection.query('select count(*) as count FROM ' + escapeId(table),
                    function (err, rows) {
                        done(err, rows ? rows[0].count : null);
                    });
}

// mirrors db_postgres.js / db_mysql.js: doneReturn(null, [columns, status])
exports.getTableDetails =
function getTableDetails(connection, table, doneReturn) {
    async.parallel([
        function (done) { // columns
            connection.query('PRAGMA table_info(' + escapeId(table) + ')',
                            function (err, rows) {
                                if (err) return done(err);
                                done(null, rows.map(function (r) {
                                    return {
                                        column_name:    r.name,
                                        data_type:      r.type,
                                        column_default: r.dflt_value,
                                        is_nullable:    r.notnull ? 'NO' : 'YES'
                                    };
                                }));
                            });
        },

        function (done) { // status / create statement
            connection.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
                            [table],
                            function (err, rows) {
                                if (err) { return done(err); }
                                // A table that does not exist gives an empty
                                // result set, not an error (and PRAGMA table_info
                                // above behaves the same way). Say so, or the
                                // caller happily renders an empty table page.
                                if (!rows.length) {
                                    return done(new Error("Table '" + table + "' not found"));
                                }
                                done(null, rows);
                            });
        }
    ], doneReturn);
}

function showColumnRequest(connection, column, table, limit, doneReturn) {
    connection.query("select " + escapeId(column) + ", count(*) as count from "
                    + escapeId(table) + " group by " + escapeId(column) +
                    " order by count desc limit " + limit,
                    function (err, rows) {
                        doneReturn(err, rows);
                    });
}

function showValueRequest(connection, table, where, order_limit_offset, doneReturn) {
    var conditions = [];
    var values = [];
    for (var col in where) {
        var val = where[col];
        if (val === 'NOTNULL')
            conditions.push(escapeId(col) + " IS NOT NULL");
        else {
            conditions.push(escapeId(col) + "=?");
            values.push(val);
        }
    }

    const condition = conditions.join(" AND ");
    if (condition) console.log( "BUILD CONDITION:", condition );

    var where = '', order_by = '', limit = '';
    if( condition ) {
        where = " where " + condition;
    }

    if (order_limit_offset) {
        order_by = " order by " + escapeId(order_limit_offset.order_by) + " "
                 + directionWord(order_limit_offset.direction);
        limit = limitClause(order_limit_offset.limit);
    }

    console.log( "SQL:", "select * from " + escapeId(table) + where + order_by + limit)

    connection.query("select * from " + escapeId(table) + where + order_by + limit, values,
                    function (err, rows) {
                        doneReturn(err, rows);
                    });
}

function getSQL (connection, sql, doneReturn){
    connection.query(sql, function(err, rows) {
        if (err) {
            err = err + " in request '" + sql + "'";
        }
        doneReturn(err, rows);
    });
}

exports.createConnection   = createConnection;
exports.showAllTable       = showAllTable;
exports.showColumnRequest  = showColumnRequest;
exports.showValueRequest   = showValueRequest;
exports.rowsCounter        = rowsCounter;
exports.getSQL             = getSQL;
