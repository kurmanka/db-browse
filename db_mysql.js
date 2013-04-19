var async = require('async');
var requestHandlers = require('./requestHandlers');
var mysql = require('mysql');

function showAllTable(connection, doneReturn) {
    connection.query('SHOW TABLES;', function(err, rows, fields) {
        if (err) {
            console.log(err);
        }

        async.waterfall([
            function (done){
                var resultArr = [];

                for (var key in rows[0]) {
                    for (var i = 0; i < rows.length; i++) {
                        if(key != 'parse' && key != '_typeCast') {
                            resultArr[i] = rows[i][key];
                        }
                    }
                }
                done(null, resultArr);
            }

        ], function (err, result) {
            doneReturn(null, result);
        });
    });
}

function showTableRequest(connection, table, doneReturn) {
    connection.query("SELECT count(*) as countT FROM information_schema.tables WHERE table_schema = DATABASE() and table_name = ?;", [table], function(err, rows, fields) {
        if (rows[0].countT > 0) {

             async.parallel([
                function(done){
                    connection.query('SHOW COLUMNS FROM ' + mysql.escapeId(table) + ';', function(err, rows, fields) {
                        if (err) {
                            console.log(err);
                        }

                        done(null, rows);
                   });
                },

                function(done){
                    connection.query('select count(*) as count FROM ' + mysql.escapeId(table) + ';', function(err, rows, fields) {
                        if (err) {
                            console.log(err);
                        }

                        done(null, rows[0].count);
                    });
                },

                function(done){
                    connection.query('show create table ' + mysql.escapeId(table) + ';', function(err, rows, fields) {
                        if (err) {
                            console.log(err);
                        }

                        getIndexes(rows, done);
                    });
                },

                function(done){
                    connection.query('SELECT TABLE_NAME, Engine, Version, Row_format, TABLE_ROWS, Avg_row_length, Data_length, Max_data_length, Index_length,' +
                                     'Data_free, Auto_increment, Create_time, Update_time, Check_time, TABLE_COLLATION, Checksum, Create_options, TABLE_COMMENT ' +
                                     'FROM information_schema.tables WHERE table_schema = DATABASE() and table_name = ?;', [table], function(err, rows, fields) {
                        if (err) {
                            console.log(err);
                        }

                        done(null, rows);
                    });
                }
            ],
            function (err,results) {
                doneReturn(null, results);
            });
        } else {
            requestHandlers.showError(response, "Table '" + table + "' not found");
        }
    });
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

function showColumnRequest(connection, column, table, limit, done) {
    connection.query("SELECT count(*) as countT FROM information_schema.tables WHERE table_schema = DATABASE() and table_name = ?;", [table], function(err, rows, fields) {
        if (rows[0].countT > 0) {

            connection.query("SELECT count(*) as countC FROM information_schema.COLUMNS WHERE TABLE_NAME=? AND COLUMN_NAME=?;", [table, column], function(err, rows, fields) {
                if (rows[0].countC > 0) {

                    connection.query("select " + mysql.escapeId(column) + ", count(*) as count from " + mysql.escapeId(table) + " group by " + mysql.escapeId(column) + " order by count desc limit " + limit + ";", function(err, rows, fields) {
                        if (err) {
                            console.log(err);
                        }

                        done(null, rows);
                    });
                } else {
                    requestHandlers.showError(response, "Column '" + column + "' not found in table '" + table + "'");
                }
            });
        } else {
            requestHandlers.showError(response, "Table '" + table + "' not found");
        }
    });
}

function showValueRequest(connection, table, column, value, limit, doneReturn) {
    connection.query("SELECT count(*) as countT FROM information_schema.tables WHERE table_schema = DATABASE() and table_name = ?;", [table], function(err, rows, fields) {
        if (rows[0].countT > 0) {

            connection.query("SELECT count(*) as countC FROM information_schema.COLUMNS WHERE TABLE_NAME=? AND COLUMN_NAME=?;", [table, column], function(err, rows, fields) {
                if (rows[0].countC > 0) {

                    async.parallel([
                        function(done){
                            connection.query("select * from " + mysql.escapeId(table) + " where " + mysql.escapeId(column) + "=? limit " + limit + ";", [value], function(err, rows, fields) {
                                if (err) {
                                    console.log(err);
                                }

                                done(null, rows);
                            });
                        },

                        function(done){
                            connection.query("select count(*) as count from " + mysql.escapeId(table) + " where " + mysql.escapeId(column) + "=?;", [value], function(err, rows, fields) {
                                if (err) {
                                    console.log(err);
                                }

                                done(null, rows[0].count);
                            });
                        }
                    ],
                    function (err, results) {
                        doneReturn(null, results);
                    });
                } else {
                    requestHandlers.showError(response, "Column '" + column + "' not found in table '" + table + "'");
                }
            });
        } else {
            requestHandlers.showError(response, "Table '" + table + "' not found");
        }
    });
}

exports.showAllTable = showAllTable;
exports.showTableRequest = showTableRequest;
exports.showColumnRequest = showColumnRequest;
exports.showValueRequest = showValueRequest;