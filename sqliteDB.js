//https://github.com/developmentseed/node-sqlite3/wiki/API
var sqlite = require('sqlite3').verbose();
var async = require('async');

var connectStatus = {};
var db;

function saveRequest(sql, dbId, reqName, user, comment, doneReturn) {
    var created_at = getCurrentDate();;
    var last_used = getCurrentDate();
    var newId = 1;
    var used_timeNew = 1;
    var commentNew = comment;
    var nameNew = reqName;

    async.waterfall([
        connectCheck,

        function(done){
            db.each("SELECT max(id) AS id FROM sql", function(err, row) {
                if (row.id) {
                    newId = parseInt(row.id) + 1;
                }
                done(err);
            });
        },

        function(done){
            db.each(
                "SELECT max(used_times) as ut, id, comment, name, created_at "
                + " FROM sql WHERE sql=?", sql,
                function(err, row) {
                    if (row && row.ut) {
                        used_timeNew = parseInt(row.ut) + 1;
                        created_at = row.created_at;
                        newId = row.id;
                        if (!commentNew) {
                            commentNew = row.comment;
                        } if (!nameNew) {
                            nameNew = row.name;
                        }
                        db.run("delete FROM sql WHERE sql=?", sql);
                    }
                    done(err);
                }
            );
        }
    ], function (err) {
        if (err) {
            doneReturn(err);
        }
        var stmt = db.prepare("INSERT INTO sql VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        stmt.run(newId, sql, nameNew, commentNew, dbId, user, created_at, used_timeNew, last_used);
        stmt.finalize();

        doneReturn(null);
    });
}

function changeRequest(sql, dbId, reqName, user, comment, doneReturn, sqlId, type) {
    var created_at;
    var last_used;
    var used_time;

    async.waterfall([
        connectCheck,

        function(done){
            db.each(
                "SELECT max(used_times) as ut, id, comment, name, created_at, last_used "
                +"FROM sql WHERE id=?", sqlId,
                function(err, row) {
                    if (err) {
                        done(err);
                    }
                    if (row.id) {
                        created_at = row.created_at;
                        if (type == 'save') {
                            used_time = row.ut;
                            last_used = row.last_used;
                        } else {
                            used_time = parseInt(row.ut) + 1;
                            last_used = getCurrentDate();
                        }
                        db.run("delete FROM sql WHERE id=?", sqlId );
                    }
                    done(null);
                }
            );
        }
    ], function (err) {
        if (err) {
            doneReturn(err);
        }
        var stmt = db.prepare("INSERT INTO sql VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        stmt.run(sqlId, sql, reqName, comment, dbId, user, created_at, used_time, last_used);
        stmt.finalize();

        doneReturn(null);
    });
}


function connectCheck(done) {
    if (!connectStatus.db) {
        connectStatus.db = new sqlite.Database('usersRequests.sqlite');
        db = connectStatus.db;
        dbCheck(db, done);
    } else {
        done(null);
    }
}

function dbCheck(db, done) {
    db.serialize(function() {
        db.run("CREATE TABLE IF NOT EXISTS sql "
                +"(id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "
                +" sql TEXT NOT NULL, "
                +" name VARCHAR, "
                +" comment TEXT, "
                +" dbid VARCHAR NOT NULL,"
                +" created_by VARCHAR NOT NULL,"
                +" created_at DATETIME NOT NULL,"
                +" used_times INTEGER NOT NULL DEFAULT 0,"
                +" last_used DATETIME NOT NULL )");
        done(null);
    });
}

function getCurrentDate() {
    var date = new Date();

    var year = date.getYear() + 1900;
    var month = date.getMonth() +1 ;

    if (month < 10) {
        month = "0" + month;
    }

    var day = date.getDate();
    var hour = date.getHours();
    var min = date.getMinutes();

    return year + '-' + month + '-' + day + " " + hour + ":" + min;
    //return year + '-' + month + '-' + day;
}

function history(doneReturn) {
    async.waterfall([
        connectCheck,
        function(done){
            db.all("SELECT id, name, substr(sql, 1, 120) as sql, comment, dbid, " +
                  "created_by, last_used FROM sql order by used_times desc", doneReturn);
        }
    ]);
}

function details(doneReturn, sqlId) {
    async.waterfall([
        connectCheck,
        function(done){
            db.each("SELECT * FROM sql where id=?", sqlId, doneReturn);
        }
    ]);
}

function remove(sqlId, doneReturn) {
    async.waterfall([
        connectCheck,
        function(done){
            db.run("delete FROM sql WHERE id=?", sqlId, doneReturn);
        }
    ]);
}

exports.saveRequest = saveRequest;
exports.history = history;
exports.details = details;
exports.changeRequest = changeRequest;
exports.remove = remove;