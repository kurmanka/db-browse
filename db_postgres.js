var async = require('async');

function showAllTable(connection, doneReturn) {
    async.waterfall([
        function (done){
            connection.query("SELECT table_name FROM information_schema.tables " +
                            "WHERE table_schema = 'public'",
                            function(err, result) {
                                if (err) {
                                    doneReturn(err);
                                } else {
                                    done(null, result.rows);
                                }
                            }
            );
        },

        function (arr, done){
            var resultArr = [];

            for (var key in arr[0]) {
                for (var i = 0; i < arr.length; i++) {
                    if(key != 'parse' && key != '_typeCast') {
                        resultArr[i] = arr[i][key];
                    }
                }
            }
            doneReturn(null, resultArr);
        }
    ]);
}

function rowsCounter(connection, table, done) {
    try {
        table = ident(table);
    } catch (e) {
        return done(e);
    }
    connection.query('select count(*) as count FROM ' + table,
                    function(err, result) {
                        done(err, result.rows[0].count);
                    });
}


exports.getTableDetails = 
function getTableDetails(connection, table, doneReturn) {
    try {
        table = ident(table);
    } catch (e) {
        return doneReturn(e);
    }

    async.series([
        function(done){
            connection.query("SELECT column_name as Column, data_type as Type, " +
                            "character_maximum_length as mLength, " +
                            "column_default, is_nullable " +
                            "FROM information_schema.columns WHERE table_name=$1" + 
                            " ORDER BY ordinal_position"
                            , [table],
                            function(err, result) {
                                resultReturn(err, result, done, doneReturn);
                            });
        },

        function(done){ //show indexes
            connection.query("SELECT indexname, tablespace, indexdef FROM pg_indexes " +
                            "WHERE tablename = $1", [table],
                            function(err, result) {
                                resultReturn(err, result, done, doneReturn);
                            });
        },

        function(done){ //show Status
            connection.query("SELECT * FROM information_schema.tables " +
                            "WHERE table_name = $1", [table],
                            function(err, result) {
                                resultReturn(err, result, done, doneReturn);
                            });
        },

        function(done){ //show Referenced
                    connection.query("SELECT conname, conrelid::pg_catalog.regclass, " +
                                    "pg_catalog.pg_get_constraintdef(c.oid, true) as condef " +
                                    "FROM pg_catalog.pg_constraint c WHERE c.confrelid = $1::regclass " +
                                    "AND c.contype = 'f'",
                                    [table],
                                    function(err, result) {
                                        resultReturn(err, result, done, doneReturn);
                                    });
        },

        function(done){ //show Triggers
            connection.query("SELECT pg_catalog.pg_get_triggerdef(t.oid) as creating " +
                            "FROM pg_catalog.pg_trigger t WHERE t.tgrelid = $1::regclass " +
                            "AND t.tgconstraint = 0",
                            [table],
                            function(err, result) {
                                resultReturn(err, result, done, doneReturn);
                            });
        },

        function(done){ //show Foreign-key
            connection.query("SELECT conname, " +
                            "pg_catalog.pg_get_constraintdef(r.oid, true) as condef " +
                            "FROM pg_catalog.pg_constraint r WHERE r.conrelid = $1::regclass " +
                            "AND r.contype = 'f'",
                            [table],
                            function(err, result) {
                                resultReturn(err, result, done, doneReturn);
                            });
        }
    ], doneReturn);
}

function showColumnRequest(connection, column, table, limit, doneReturn) {
    try {
        column = ident(column);
        table  = ident(table);
    } catch (e) {
        return doneReturn(e);
    }
    connection.query("select " + column + ", count(*) as count from "
                    + table + " group by " + column +
                    " order by count desc" + limitClause(limit),
                    function(err, result) {
                        resultReturn(err, result, doneReturn);
                    });
}

function resultReturn(err, result, done, doneReturn) {
    if (doneReturn && err) {
        return doneReturn(err);
    }

    if (result) {
        done(err, result.rows);
    } else {
        done(err, null);
    }
}

function showValueRequest(connection, table, where, order_limit_offset, doneReturn) {
    var conditions = [];
    var values = [];
    var num = 1;
    var order_by = '';
    var limit = '';

    try {
        table = ident(table);

        for( var col in where ) {
            var safeCol = ident(col);
            var val = where[col];
            if (val === 'NOTNULL') {
                conditions.push(safeCol + " IS NOT NULL");
            } else {
                conditions.push(safeCol + "=$" + num);
                values.push(val);
                num++;
            }
        }

        if (order_limit_offset) {
            order_by = " order by " + ident(order_limit_offset.order_by) + " "
                     + directionWord(order_limit_offset.direction);
            limit = limitClause(order_limit_offset.limit);
        }
    } catch (e) {
        return doneReturn(e);
    }

    const condition = conditions.join(" AND ");
    if (condition) console.log( "BUILD CONDITION:", condition );

    var whereClause = condition ? " where " + condition : '';

    console.log( "SQL:", "select * from " + table + whereClause + order_by + limit)

    connection.query("select * from " + table + whereClause + order_by + limit, values,
                    function (err, result) {
                        doneReturn(err, result ? result.rows : null);
                    });
}

function getSQL (connection, sql, doneReturn){
    connection.query(sql, function(err, result) {
        if (err) {
            err = err + " in request '" + sql + "'";
        }

        if (result) {
            doneReturn(err, result.rows);
        } else {
            doneReturn(err);
        }
    });
}

// Identifiers cannot be bound as query parameters, and this driver builds SQL by
// concatenating them, so they are validated instead of escaped. Two shapes are
// accepted, which together cover everything the app supports:
//
//   - a plain, optionally schema-qualified name. It is left unquoted, so
//     Postgres keeps folding it to lower case, exactly as before.
//   - an explicitly double-quoted, optionally qualified name. It is passed
//     through, so mixed-case and otherwise unusual names keep working.
//
// Anything else is refused, so a URL segment can never contribute SQL.
var PLAIN_IDENT  = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/;
var QUOTED_IDENT = /^"[^"]+"(\."[^"]+")?$/;

function ident (name) {
    var text = String(name);
    if (PLAIN_IDENT.test(text) || QUOTED_IDENT.test(text)) {
        return text;
    }
    throw new Error("Invalid identifier: " + name);
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

exports.showAllTable = showAllTable;
exports.showColumnRequest = showColumnRequest;
exports.showValueRequest = showValueRequest;
exports.rowsCounter = rowsCounter;
exports.getSQL = getSQL;
exports.ident = ident;      // exported for tests
