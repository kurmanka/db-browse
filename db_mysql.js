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

function objectCheck(connection, doneReturn, done, table, column) {
    var select = {
        sql: "SELECT count(*) as count FROM information_schema.tables WHERE table_schema = DATABASE() and table_name = ?;",
        params: [table],
        err: "Table '" + table + "' not found"
    };

    if (column) {
        select.sql = "SELECT count(*) as count FROM information_schema.COLUMNS WHERE TABLE_NAME=? AND COLUMN_NAME=?;";
        select.params = [table, column];
        select.err = "Column '" + column + "' not found in table '" + table + "'";
    }

    connection.query(select.sql, select.params, function(err, rows, fields) {
        if (err) {
            doneReturn(err);
        }

        else if(rows[0].count == 0) {
            doneReturn(select.err);
			err = select.err;
        }

        else {
            done(null);
        }
    });
}

function showTableRequest(connection, table, doneReturn) {
    async.waterfall([
        function (done){
            objectCheck(connection, doneReturn, done, table);
        },

        function (done){
            async.parallel([
                function(done){
                    connection.query('SHOW COLUMNS FROM ' + mysql.escapeId(table) + ';', function(err, rows, fields) {
                        done(err, rows);
                   });
                },

                function(done){
                    connection.query('select count(*) as count FROM ' + mysql.escapeId(table) + ';', function(err, rows, fields) {
                        done(err, rows[0].count);
                    });
                },

                function(done){
                    connection.query('show create table ' + mysql.escapeId(table) + ';', function(err, rows, fields) {
                        //if (err) {
                        //    doneReturn(err);
                        //}

                        getIndexes(rows, done);
                    });
                },

                function(done){
                    connection.query('SELECT TABLE_NAME, Engine, Version, Row_format, TABLE_ROWS, Avg_row_length, Data_length, Max_data_length, Index_length,' +
                                     'Data_free, Auto_increment, Create_time, Update_time, Check_time, TABLE_COLLATION, Checksum, Create_options, TABLE_COMMENT ' +
                                     'FROM information_schema.tables WHERE table_schema = DATABASE() and table_name = ?;', [table], function(err, rows, fields) {
                        done(err, rows);
                    });
                }
            ],doneReturn);
        }
    ]);
}

function getIndexes(rows, done) {
    var resultArr = [];
    var i = 0;

    for (var key in rows[0]) {
        if (key == 'Create Table') {
            var text = rows[0][key];
        }
    }

    while ( /\s.*KEY.+,*/.exec(text) ) {
        resultArr[i] = /\s.*KEY.+,*/.exec(text);
        text = text.replace(/\s.*KEY.+,*/, '');
        i++;
    }

    done(null, resultArr);
}

function showColumnRequest(connection, column, table, limit, doneReturn) {
    async.waterfall([
        function (done){
            objectCheck(connection, doneReturn, done, table);
        },

        function (done){
           objectCheck(connection, doneReturn, done, table, column);
        },

        function (done){
            connection.query("select " + mysql.escapeId(column) + ", count(*) as count from " + mysql.escapeId(table) + " group by " + mysql.escapeId(column) + " order by count desc limit " + limit + ";", function(err, rows, fields) {
                doneReturn(err, rows);
            });
        }
    ]);
}

function showValueRequest(connection, table, column, value, limit, doneReturn) {
    async.waterfall([
        function (done){
            objectCheck(connection, doneReturn, done, table);
        },

        function (done){
           objectCheck(connection, doneReturn, done, table, column);
        },

        function (done){
            async.parallel([
                function(done){
                    connection.query("select * from " + mysql.escapeId(table) + " where " + mysql.escapeId(column) + "=? limit " + limit + ";", [value], function(err, rows, fields) {
                        done(err, rows);
                    });
                },

                function(done){
                    connection.query("select count(*) as count from " + mysql.escapeId(table) + " where " + mysql.escapeId(column) + "=?;", [value], function(err, rows, fields) {
                        done(err, rows[0].count);
                    });
                }
            ], doneReturn);
        }
    ]);
}

exports.showAllTable = showAllTable;
exports.showTableRequest = showTableRequest;
exports.showColumnRequest = showColumnRequest;
exports.showValueRequest = showValueRequest;