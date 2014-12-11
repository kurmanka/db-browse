var async = require('async');
var mysql = require('mysql');

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

function showColumnRequest(connection, column, table, limit, doneReturn) {
    connection.query("select " + mysql.escapeId(column) + ", count(*) as count from " +
                    mysql.escapeId(table) + " group by " + mysql.escapeId(column) +
                    " order by count desc limit " + limit,
                    function(err, rows, fields) {
                        doneReturn(err, rows);
                    });
}

function showValueRequest(connection, table, where, doneReturn) {

    // this is copy-paste-adapted from db_postgres.js
    var condition = '';
    var values = [];
    var num = 1;
    for( var col in where ) {
        var val = where[col];
        if (num > 1) {
            condition += " AND ";
        }
        // mysql-specific escape and the placeholder
        condition += mysql.escapeId(col) + "=?";
        values.push(val);
        num++;
    }

    console.log( "BUILD CONDITION: ", condition );

    connection.query("select * from " + mysql.escapeId(table) +
                    " where " + condition, values,
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
exports.rowsCounter = rowsCounter;
exports.getSQL = getSQL;