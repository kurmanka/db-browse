var JUST = require('just');
var async = require('async');
var just = new JUST({ root : './view', useCache : true, ext : '.html' });
var requestHandlers = require('./requestHandlers');

function showAllTable(response, connection, pathname, tableGroups) {
    connection.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';", function(err, result) {
        if (err) {
            console.log(err);
        }

        async.waterfall([
            function (done){
                var resultArr = [];

                for (var key in result.rows[0]) {
                    for (var i = 0; i < result.rows.length; i++) {
                        if(key != 'parse' && key != '_typeCast') {
                            resultArr[i] = result.rows[i][key];
                        }
                    }
                }
                done(null, resultArr);
            }

        ], function (err, res) {
            just.render('start', { tablesList: res, path: pathname, tableGr: tableGroups }, function(error, html) {
                requestHandlers.showPage (response, error, html);
            });
        });
    });
}

function showTableRequest(response, connection, pathname, table) {
    connection.query("select count(*) as count from pg_tables where tablename=$1;", [table], function(err, result) {
        if (err) {
            console.log(err);
        }

        if (result.rows[0].count > 0) {

             async.parallel([
                function(done){
                    connection.query("SELECT column_name as Column, data_type as Type, character_maximum_length as mLength, column_default, is_nullable FROM information_schema.columns WHERE table_name=$1;", [table], function(err, result) {
                        if (err) {
                            console.log(err);
                        }

                        done(null, result.rows);
                   });
                },

                function(done){
                    connection.query('select count(*) as count FROM ' + myEscaping(table) + ';', function(err, result) {
                        if (err) {
                            console.log(err);
                        }

                        done(null, result.rows[0].count);
                    });
                },

                function(done){
                    connection.query("SELECT indexname, tablespace, indexdef FROM pg_indexes WHERE tablename = $1;", [table], function(err, result) {
                        if (err) {
                            console.log(err);
                        }

                        done(null, result.rows);
                    });
                },

                function(done){
                    connection.query("SELECT * FROM information_schema.tables WHERE table_name = $1;", [table], function(err, result) {
                        if (err) {
                            console.log(err);
                        }

                        done(null, result.rows);
                    });
                }
            ],
            function (err,results) {
                just.render('tablePage', {path: pathname, tableName: table, attrList: results[0], rowsCounter: results[1], indexesArr: results[2], statusArr: results[3], dbType: 'postgres'}, function(error, html) {
                    requestHandlers.showPage (response, error, html);
                });
            }
            );

        } else {
            requestHandlers.showError(response, "Table '" + table + "' not found");
        }
    });
}

function showColumnRequest(response, connection, column, table, limit) {
    connection.query("select count(*) as count from pg_tables where tablename=$1" , [table], function(err, result) {
        if (result.rows[0].count > 0) {

            connection.query("SELECT count(*) as countC FROM information_schema.COLUMNS WHERE TABLE_NAME=$1 AND COLUMN_NAME=$2;", [table, column], function(err, result) {
                if (result.rows[0].countc > 0) {

                    connection.query("select " + myEscaping(column) + ", count(*) as count from " + myEscaping(table) + " group by " + myEscaping(column) + " order by count desc limit " + limit + ";", function(err, result) {
                        if (err) {
                            console.log(err);
                        }

                        just.render('columnData', { columnData: result.rows }, function(error, html) {
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

function myEscaping (text) {
    text = text.replace(/\%20|;|,|\%22|\%27/g, '\\$&');

    return text;
}

exports.showAllTable = showAllTable;
exports.showTableRequest = showTableRequest;
exports.showColumnRequest = showColumnRequest;