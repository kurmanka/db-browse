var async = require('async');

function showAllTable(connection, doneReturn) {
    async.waterfall([
        function (done){
            connection.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';", function(err, result) {
                if (err) {
                    doneReturn(err);
                } else {
                    done(null, result.rows);
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
        sql: "select count(*) as count from pg_tables where tablename=$1;",
        params: [table],
        err: "Table '" + table + "' not found"
    };

    if (column) {
        select.sql = "SELECT count(*) as count FROM information_schema.COLUMNS WHERE TABLE_NAME=$1 AND COLUMN_NAME=$2;";
        select.params = [table, column];
        select.err = "Column '" + column + "' not found in table '" + table + "'";
    }

    connection.query(select.sql, select.params, function(err, result) {
        if (err) {
            doneReturn(err);
        }

        else if(result.rows[0].count == 0) {
            doneReturn(select.err);
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
                    connection.query("SELECT column_name as Column, data_type as Type, character_maximum_length as mLength, column_default, is_nullable FROM information_schema.columns WHERE table_name=$1;", [table], function(err, result) {
                        if (err) {
                            doneReturn(err);
                        }

                        done(null, result.rows);
                   });
                },

                function(done){
                    connection.query('select count(*) as count FROM ' + escape(table) + ';', function(err, result) {
                        if (err) {
                            doneReturn(err);
                        }

                        done(null, result.rows[0].count);
                    });
                },

                function(done){ //show indexes
                    connection.query("SELECT indexname, tablespace, indexdef FROM pg_indexes WHERE tablename = $1;", [table], function(err, result) {
                        if (err) {
                            doneReturn(err);
                        }

                        done(null, result.rows);
                    });
                },

                function(done){ //show Foreign-key
                    connection.query("SELECT conname, pg_catalog.pg_get_constraintdef(r.oid, true) as condef FROM pg_catalog.pg_constraint r WHERE r.conrelid ='" + escape(table) + "'::regclass AND r.contype = 'f';", function(err, result) {
                        if (err) {
                            doneReturn(err);
                        }

                        done(null, result.rows);
                    });
                },

                function(done){ //show Referenced
                    connection.query("SELECT conname, conrelid::pg_catalog.regclass, pg_catalog.pg_get_constraintdef(c.oid, true) as condef FROM pg_catalog.pg_constraint c WHERE c.confrelid = '" + escape(table) + "'::regclass AND c.contype = 'f';", function(err, result) {
                        if (err) {
                            doneReturn(err);
                        }

                        done(null, result.rows);
                    });
                },

                function(done){ //show Triggers
                    connection.query("SELECT pg_catalog.pg_get_triggerdef(t.oid) as creating FROM pg_catalog.pg_trigger t WHERE t.tgrelid = '" + escape(table) + "'::regclass AND t.tgconstraint = 0;", function(err, result) {
                        if (err) {
                            doneReturn(err);
                        }

                        done(null, result.rows);
                    });
                },

                function(done){ //show Status
                    connection.query("SELECT * FROM information_schema.tables WHERE table_name = $1;", [table], function(err, result) {
                        if (err) {
                            doneReturn(err);
                        }

                        done(null, result.rows);
                    });
                }
            ],
            function (err, results) {
                doneReturn(null, results);
            });
        }
    ]);
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
            connection.query("select " + escape(column) + ", count(*) as count from " + escape(table) + " group by " + escape(column) + " order by count desc limit " + limit + ";", function(err, result) {
                doneReturn(err, result.rows);
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
                    connection.query("select * from " + escape(table) + " where " + escape(column) + "=$1 limit " + limit + ";", [value], function(err, result) {
                        if (err) {
                            doneReturn(err);
                        }

                        done(null, result.rows);
                    });
                },

                function(done){
                    connection.query("select count(*) as count from " + escape(table) + " where " + escape(column) + "=$1;", [value], function(err, result) {
                        if (err) {
                            doneReturn(err);
                        }

                        done(null, result.rows[0].count);
                    });
                }
            ],
            function (err, results) {
                doneReturn(err, results);
            });
        }
    ]);
}

function escape (text) {
    text = text.replace(/\%20|;|,|\%22|\%27/g, '\\$&');

    return text;
}

exports.showAllTable = showAllTable;
exports.showTableRequest = showTableRequest;
exports.showColumnRequest = showColumnRequest;
exports.showValueRequest = showValueRequest;