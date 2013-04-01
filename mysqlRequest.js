var JUST = require('just');
var async = require('async');
var just = new JUST({ root : './view', useCache : true, ext : '.html' });
var requestHandlers = require('./requestHandlers');
var mysql = require('mysql');

function showAllTable(response, connection, pathname, tableGroups) {
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
            just.render('start', { tablesList: result, path: pathname, tableGr: tableGroups }, function(error, html) {
                requestHandlers.showPage (response, error, html);
            });
        });
    });
}

function showTableRequest(response, connection, pathname, table) {
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
                just.render('tablePage', {path: pathname, tableName: table, attrList: results[0], rowsCounter: results[1], indexesArr: results[2], statusArr: results[3], dbType: 'mysql'}, function(error, html) {
                   requestHandlers.showPage (response, error, html);
                });
            }
            );
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

function showColumnRequest(response, connection, column, table, limit) {
    connection.query("SELECT count(*) as countT FROM information_schema.tables WHERE table_schema = DATABASE() and table_name = ?;", [table], function(err, rows, fields) {
        if (rows[0].countT > 0) {

            connection.query("SELECT count(*) as countC FROM information_schema.COLUMNS WHERE TABLE_NAME=? AND COLUMN_NAME=?;", [table, column], function(err, rows, fields) {
                if (rows[0].countC > 0) {

                    connection.query("select " + mysql.escapeId(column) + ", count(*) as count from " + mysql.escapeId(table) + " group by " + mysql.escapeId(column) + " order by count desc limit " + limit + ";", function(err, rows, fields) {
                        if (err) {
                            console.log(err);
                        }

                        just.render('columnData', { columnData: rows }, function(error, html) {
                            requestHandlers.showPage (response, error, html);
                        });
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