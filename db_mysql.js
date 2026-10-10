var async = require('async');
var mysql = require('mysql2');

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
    async.waterfall([
        function (done){
            connection.query('SHOW TABLES;', function(err, rows, fields) {
                if (err) {
                    doneReturn(err);
                } else {
                    done(null, rows);
                }
            });
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
    connection.query('select count(*) as count FROM ' +
                    mysql.escapeId(table),
                    function(err, rows, fields) {
                        done(err, rows[0].count);
                    });
}

// get table details

// this should result in a doneReturn function call, called as:
// doneReturn( null, [show_columns_rows, create_table_rows, select_technical_details_rows] );
// or 
// doneReturn( err, something );
exports.getTableDetails = 
function getTableDetails(connection, table, doneReturn) {

    async.parallel([
        function(done){
            connection.query('SHOW COLUMNS FROM ' + mysql.escapeId(table),
                            function(err, rows, fields) {
                                done(err, rows);
                            });
        },

        function(done){
            connection.query('show create table ' + mysql.escapeId(table),
                            function(err, rows, fields) {
                                done(err, rows);
                            });
        },

        function(done){
            connection.query('SELECT TABLE_NAME, Engine, Version, Row_format, TABLE_ROWS, ' +
                            'Avg_row_length, Data_length, Max_data_length, Index_length,' +
                            'Data_free, Auto_increment, Create_time, Update_time, Check_time, ' +
                            'TABLE_COLLATION, Checksum, Create_options, TABLE_COMMENT ' +
                            'FROM information_schema.tables ' +
                            'WHERE table_schema = DATABASE() and table_name = ?', [table],
                            function(err, rows, fields) {
                                done(err, rows);
                            });
        }
    ],doneReturn);
}

// The values of one column with their row counts, most frequent first. `where`
// is optional (callers that omit it pass the callback in its place): a
// column -> value map that restricts the rows before they are grouped, the same
// shape showValueRequest takes. NOTNULL means "is not null".
function showColumnRequest(connection, column, table, limit, where, doneReturn) {
    if (typeof where === 'function') { doneReturn = where; where = null; }

    var conditions = [];
    var values = [];

    for (var col in (where || {})) {
        if (where[col] === 'NOTNULL') {
            conditions.push(mysql.escapeId(col) + " IS NOT NULL");
        } else {
            conditions.push(mysql.escapeId(col) + "=?");
            values.push(where[col]);
        }
    }

    var whereClause = conditions.length ? " where " + conditions.join(" AND ") : '';

    connection.query("select " + mysql.escapeId(column) + ", count(*) as count from " +
                    mysql.escapeId(table) + whereClause +
                    " group by " + mysql.escapeId(column) +
                    " order by count desc" + limitClause(limit),
                    values,
                    function(err, rows, fields) {
                        doneReturn(err, rows);
                    });
}

// The table's column names, in order, from a zero-row select's result metadata.
function getTableColumns(connection, table, doneReturn) {
    connection.query('SELECT * FROM ' + mysql.escapeId(table) + ' LIMIT 0',
                    function(err, rows, fields) {
                        doneReturn(err, fields ? fields.map(function (f) { return f.name; }) : null);
                    });
}

// Incoming foreign keys: not implemented yet. information_schema
// .KEY_COLUMN_USAGE would answer it, but there is no MySQL server here to
// verify against, so the row view shows no links rather than guessing.
function getReferencing(connection, table, doneReturn) {
    doneReturn(null, []);
}

function showValueRequest(connection, table, where, order_limit_offset, columns, doneReturn) {
    // columns is optional: callers that omit it pass the callback in its place
    if (typeof columns === 'function') { doneReturn = columns; columns = null; }

    // this is copy-paste-adapted from db_postgres.js
    var conditions = [];
    var values = [];
    var num = 1;
    var order_by = '', limit = '';
    var select = (columns && columns.length)
               ? columns.map(function (c) { return mysql.escapeId(c); }).join(', ')
               : '*';

    for( var col in where ) {
        var val = where[col];
        if (val === 'NOTNULL')
            conditions.push(mysql.escapeId(col) + " IS NOT NULL");
        else {
        // mysql-specific escape and the placeholder
            conditions.push(mysql.escapeId(col) + "=?");
            values.push(val);
            num++;
        }
    }

    const condition = conditions.join(" AND ");
    if (condition) console.log( "BUILD CONDITION: ", condition );

    var whereClause = condition ? " where " + condition : '';

    if (order_limit_offset) {
        order_by = " order by " + mysql.escapeId(order_limit_offset.order_by) + " "
                 + directionWord(order_limit_offset.direction);
        limit = limitClause(order_limit_offset.limit);
    }

    console.log( "SQL:", "select " + select + " from " + mysql.escapeId(table) + whereClause + order_by + limit)

    connection.query("select " + select + " from " + mysql.escapeId(table) + whereClause + order_by + limit, values,
                    function(err, rows, fields) {
                        doneReturn(err, rows);
                    });
}

function getSQL (connection, sql, doneReturn){
    async.waterfall([
        function (done){
            connection.query(sql, function(err, rows, fields) {
                if (err) {
                    err = err + " in request '" + sql + "'";
                }
                doneReturn(err, rows);
            });
        }
    ]);
}

exports.showAllTable = showAllTable;
exports.showColumnRequest = showColumnRequest;
exports.showValueRequest = showValueRequest;
exports.getTableColumns = getTableColumns;
exports.getReferencing = getReferencing;
exports.rowsCounter = rowsCounter;
exports.getSQL = getSQL;