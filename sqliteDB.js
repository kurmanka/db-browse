var sqlite = require('sqlite3').verbose();
var async = require('async');

function saveRequest(sql, dbId, reqName, user, doneReturn) {
    sql = sql.replace(/;/g, '');
    var db = new sqlite.Database('usersRequests.sqlite.sqlite');
    var created_at = getCurrentDate();
    var last_used = getCurrentDate();
    var newId = 1;
    var used_timeNew = 1;

    async.waterfall([
        function(done){
            dbCheck(db, done);
        },

        function(done){
            db.each("SELECT max(id) AS id FROM sql", function(err, row) {
                if (row.id) {
                    newId = parseInt(row.id) + 1;
                }
                done(err);
            });
        },

        function(done){
            db.each("SELECT max(used_times) as ut, id FROM sql WHERE sql = '" + sql + "'", function(err, row) {
                if (row.ut) {
                    used_timeNew = parseInt(row.ut) + 1;
                    newId = row.id;
                    db.each("delete FROM sql WHERE sql = '" + sql + "'", function(err, row) {});
                }
                done(err);
            });
        }
    ], function (err) {
        var stmt = db.prepare("INSERT INTO sql VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        stmt.run(newId, sql, reqName, '', dbId, user, created_at, used_timeNew, last_used);
        stmt.finalize();
        doneReturn(err);
    });
}

function dbCheck(db, done) {
    db.serialize(function() {
        db.run("CREATE TABLE IF NOT EXISTS sql (id INTEGER PRIMARY KEY  AUTOINCREMENT  NOT NULL , sql TEXT NOT NULL , name VARCHAR, comment TEXT, dbid VARCHAR NOT NULL , created_by VARCHAR NOT NULL , created_at DATETIME NOT NULL , used_times INTEGER NOT NULL  DEFAULT 0, last_used DATETIME NOT NULL )");
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

exports.saveRequest = saveRequest;