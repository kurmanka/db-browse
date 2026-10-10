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

// The values of one column with their row counts, most frequent first. `where`
// is optional (callers that omit it pass the callback in its place): a
// column -> value map that restricts the rows before they are grouped, the same
// shape showValueRequest takes. NOTNULL means "is not null".
function showColumnRequest(connection, column, table, limit, where, doneReturn) {
    if (typeof where === 'function') { doneReturn = where; where = null; }

    var conditions = [];
    var values = [];
    var num = 1;
    var whereClause = '';

    try {
        column = ident(column);
        table  = ident(table);

        for (var col in (where || {})) {
            var safeCol = ident(col);
            if (where[col] === 'NOTNULL') {
                conditions.push(safeCol + " IS NOT NULL");
            } else {
                conditions.push(safeCol + "=$" + num);
                values.push(where[col]);
                num++;
            }
        }
    } catch (e) {
        return doneReturn(e);
    }

    whereClause = conditions.length ? " where " + conditions.join(" AND ") : '';

    connection.query("select " + column + ", count(*) as count from "
                    + table + whereClause
                    + " group by " + column +
                    " order by count desc" + limitClause(limit),
                    values,
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

// The table's column names, in order, from a zero-row select's result metadata.
function getTableColumns(connection, table, doneReturn) {
    try {
        table = ident(table);
    } catch (e) {
        return doneReturn(e);
    }
    connection.query("SELECT * FROM " + table + " LIMIT 0",
                    function (err, result) {
                        doneReturn(err, (result && result.fields)
                            ? result.fields.map(function (f) { return f.name; }) : null);
                    });
}

function showValueRequest(connection, table, where, order_limit_offset, columns, doneReturn) {
    // columns is optional: callers that omit it pass the callback in its place
    if (typeof columns === 'function') { doneReturn = columns; columns = null; }

    var conditions = [];
    var values = [];
    var num = 1;
    var order_by = '';
    var limit = '';
    var select = '*';

    try {
        table = ident(table);

        if (columns && columns.length) {
            // these came from the database (issue 13's column picker), so they
            // are always quoted: `Name` must not be folded to `name`
            select = columns.map(quoteIdent).join(', ');
        }

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

    console.log( "SQL:", "select " + select + " from " + table + whereClause + order_by + limit)

    connection.query("select " + select + " from " + table + whereClause + order_by + limit, values,
                    function (err, result) {
                        doneReturn(err, result ? result.rows : null);
                    });
}

// Incoming foreign keys: the tables/columns whose rows point at this table.
// Returns [{ constraint, table, column, referenced_column }]. Composite keys
// are skipped: a single-column link cannot express them.
function getReferencing(connection, table, doneReturn) {
    try {
        table = ident(table);
    } catch (e) {
        return doneReturn(e);
    }

    connection.query(
        "SELECT c.conname AS constraint_name, " +
        "       c.conrelid::pg_catalog.regclass AS referencing_table, " +
        // attname::text, not attname: array_agg(name) comes back as the raw
        // "{a,b}" string (pg has no parser for name[]), while text[] is parsed
        "       (SELECT array_agg(a.attname::text ORDER BY k.ord) " +
        "          FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) " +
        "          JOIN pg_catalog.pg_attribute a " +
        "            ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS referencing_columns, " +
        "       (SELECT array_agg(a.attname::text ORDER BY k.ord) " +
        "          FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord) " +
        "          JOIN pg_catalog.pg_attribute a " +
        "            ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS referenced_columns " +
        "FROM pg_catalog.pg_constraint c " +
        "WHERE c.confrelid = $1::regclass AND c.contype = 'f' " +
        "ORDER BY 2, 1",
        [table],
        function (err, result) {
            if (err) { return doneReturn(err); }
            var refs = (result ? result.rows : []).filter(function (r) {
                return r.referencing_columns && r.referencing_columns.length === 1
                    && r.referenced_columns  && r.referenced_columns.length === 1;
            }).map(function (r) {
                return {
                    constraint:        r.constraint_name,
                    table:             r.referencing_table,
                    column:            r.referencing_columns[0],
                    referenced_column: r.referenced_columns[0]
                };
            });
            doneReturn(null, refs);
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

// Always-quoted identifier, for names this driver got from the database rather
// than from a URL (the column picker sends exact column names).
function quoteIdent (name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
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
exports.getTableColumns = getTableColumns;
exports.getReferencing = getReferencing;
exports.rowsCounter = rowsCounter;
exports.getSQL = getSQL;
exports.ident = ident;      // exported for tests
