var async = require('async');
var requestHandlers = require('./requestHandlers');

function showAllTable(connection, doneReturn) {
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
            doneReturn(null, res);
        });
    });
}

function showTableRequest(connection, table, doneReturn) {
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
                    connection.query('select count(*) as count FROM ' + escape(table) + ';', function(err, result) {
                        if (err) {
                            console.log(err);
                        }

                        done(null, result.rows[0].count);
                    });
                },

                function(done){ //show indexes
                    connection.query("SELECT indexname, tablespace, indexdef FROM pg_indexes WHERE tablename = $1;", [table], function(err, result) {
                        if (err) {
                            console.log(err);
                        }

                        done(null, result.rows);
                    });
                },

                function(done){ //show Foreign-key
                    connection.query("SELECT conname, pg_catalog.pg_get_constraintdef(r.oid, true) as condef FROM pg_catalog.pg_constraint r WHERE r.conrelid ='" + escape(table) + "'::regclass AND r.contype = 'f';", function(err, result) {
                        if (err) {
                            console.log(err);
                        }

                        done(null, result.rows);
                    });
                },

                function(done){ //show Referenced
                    connection.query("SELECT conname, conrelid::pg_catalog.regclass, pg_catalog.pg_get_constraintdef(c.oid, true) as condef FROM pg_catalog.pg_constraint c WHERE c.confrelid = '" + escape(table) + "'::regclass AND c.contype = 'f';", function(err, result) {
                        if (err) {
                            console.log(err);
                        }

                        done(null, result.rows);
                    });
                },

                function(done){ //show Triggers
                    connection.query("SELECT pg_catalog.pg_get_triggerdef(t.oid) as creating FROM pg_catalog.pg_trigger t WHERE t.tgrelid = '" + escape(table) + "'::regclass AND t.tgconstraint = 0;", function(err, result) {
                        if (err) {
                            console.log(err);
                        }

                        done(null, result.rows);
                    });
                },

                function(done){ //show Status
                    connection.query("SELECT * FROM information_schema.tables WHERE table_name = $1;", [table], function(err, result) {
                        if (err) {
                            console.log(err);
                        }

                        done(null, result.rows);
                    });
                }
            ],
            function (err, results) {
                doneReturn(null, results);
            });
        } else {
            requestHandlers.showError(response, "Table '" + table + "' not found");
        }
    });
}

function showColumnRequest(connection, column, table, limit, done) {
    connection.query("select count(*) as count from pg_tables where tablename=$1" , [table], function(err, result) {
        if (result.rows[0].count > 0) {

            connection.query("SELECT count(*) as countC FROM information_schema.COLUMNS WHERE TABLE_NAME=$1 AND COLUMN_NAME=$2;", [table, column], function(err, result) {
                if (result.rows[0].countc > 0) {

                    connection.query("select " + escape(column) + ", count(*) as count from " + escape(table) + " group by " + escape(column) + " order by count desc limit " + limit + ";", function(err, result) {
                        if (err) {
                            console.log(err);
                        }

                        done(null, result.rows);
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
    connection.query("select count(*) as count from pg_tables where tablename=$1" , [table], function(err, result) {
        if (result.rows[0].count > 0) {

            connection.query("SELECT count(*) as countC FROM information_schema.COLUMNS WHERE TABLE_NAME=$1 AND COLUMN_NAME=$2;", [table, column], function(err, result) {
                if (result.rows[0].countc > 0) {

                    async.parallel([
                        function(done){
                            connection.query("select * from " + escape(table) + " where " + escape(column) + "=$1 limit " + limit + ";", [value], function(err, result) {
                                if (err) {
                                    console.log(err);
                                }

                                done(null, result.rows);
                            });
                        },

                        function(done){
                            connection.query("select count(*) as count from " + escape(table) + " where " + escape(column) + "=$1;", [value], function(err, result) {
                                if (err) {
                                    console.log(err);
                                }

                                done(null, result.rows[0].count);
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

function escape (text) {
    text = text.replace(/\%20|;|,|\%22|\%27/g, '\\$&');

    return text;
}

exports.showAllTable = showAllTable;
exports.showTableRequest = showTableRequest;
exports.showColumnRequest = showColumnRequest;
exports.showValueRequest = showValueRequest;