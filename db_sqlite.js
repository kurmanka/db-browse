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
                db = new Database(cc.database);
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

function escapeId(id) {
    return '"' + String(id).replace(/"/g, '""') + '"';
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
                                done(err, rows);
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
        order_by = " order by " + escapeId(order_limit_offset.order_by) + " " + order_limit_offset.direction
        if (order_limit_offset.limit > 0) { limit = " LIMIT " + order_limit_offset.limit; }
        else { limit = " LIMIT 100 " }
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
