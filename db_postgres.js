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
    connection.query('select count(*) as count FROM ' + escape(table),
                    function(err, result) {
                        done(err, result.rows[0].count);
                    });
}


exports.getTableDetails = 
function getTableDetails(connection, table, doneReturn) {
    async.series([
        function(done){
            connection.query("SELECT column_name as Column, data_type as Type, " +
                            "character_maximum_length as mLength, " +
                            "column_default, is_nullable " +
                            "FROM information_schema.columns WHERE table_name=$1", [table],
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
                                    "FROM pg_catalog.pg_constraint c WHERE c.confrelid = '" +
                                    escape(table) + "'::regclass AND c.contype = 'f'",
                                    function(err, result) {
                                        resultReturn(err, result, done, doneReturn);
                                    });
        },

        function(done){ //show Triggers
            connection.query("SELECT pg_catalog.pg_get_triggerdef(t.oid) as creating " +
                            "FROM pg_catalog.pg_trigger t WHERE t.tgrelid = '" +
                            escape(table) + "'::regclass AND t.tgconstraint = 0",
                            function(err, result) {
                                resultReturn(err, result, done, doneReturn);
                            });
        },

        function(done){ //show Foreign-key
            connection.query("SELECT conname, " +
                            "pg_catalog.pg_get_constraintdef(r.oid, true) as condef " +
                            "FROM pg_catalog.pg_constraint r WHERE r.conrelid ='" +
                            escape(table) + "'::regclass AND r.contype = 'f'",
                            function(err, result) {
                                resultReturn(err, result, done, doneReturn);
                            });
        }
    ], doneReturn);
}

function showColumnRequest(connection, column, table, limit, doneReturn) {
    connection.query("select " + escape(column) + ", count(*) as count from "
                    + escape(table) + " group by " + escape(column) +
                    " order by count desc limit " + limit,
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

function showValueRequest(connection, table, where, doneReturn) {
    var condition = '';
    var values = [];
    var num = 1;
    for( var col in where ) {
        var val = where[col];
        if (num > 1) {
            condition += " AND ";
        }
        condition += escape(col) + "=$" + num + " ";
        values.push(val);
        num++;
    }

    console.log( "BUILD CONDITION: ", condition );

    connection.query("select * from " + escape(table) + " where " + condition, values,
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

function escape (text) {
    text = text.replace(/\%20|;|,|\%22|\%27/g, '\\$&');

    return text;
}

exports.showAllTable = showAllTable;
exports.showColumnRequest = showColumnRequest;
exports.showValueRequest = showValueRequest;
exports.rowsCounter = rowsCounter;
exports.getSQL = getSQL;
