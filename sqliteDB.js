const Database = require('better-sqlite3');

const DB_PATH = process.env.SQLITE_PATH || 'usersRequests.sqlite';
let db = null;

function getDb() {
    if (!db) {
        db = new Database(DB_PATH);
        db.exec(
            'CREATE TABLE IF NOT EXISTS sql ('
            + 'id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, '
            + 'sql TEXT NOT NULL, '
            + 'name VARCHAR, '
            + 'comment TEXT, '
            + 'dbid VARCHAR NOT NULL, '
            + 'created_by VARCHAR NOT NULL, '
            + 'created_at DATETIME NOT NULL, '
            + 'used_times INTEGER NOT NULL DEFAULT 0, '
            + 'last_used DATETIME NOT NULL)'
        );
    }
    return db;
}

function getCurrentDate() {
    var date = new Date();
    var month = String(date.getMonth() + 1).padStart(2, '0');
    return date.getFullYear() + '-' + month + '-' + date.getDate()
         + ' ' + date.getHours() + ':' + date.getMinutes();
}

function saveRequest(sql, dbId, reqName, user, comment, doneReturn) {
    try {
        var db       = getDb();
        var now      = getCurrentDate();
        var existing = db.prepare(
            'SELECT max(used_times) as ut, id, comment, name, created_at FROM sql WHERE sql=?'
        ).get(sql);

        if (existing && existing.ut) {
            db.prepare('DELETE FROM sql WHERE sql=?').run(sql);
            db.prepare('INSERT INTO sql VALUES (?,?,?,?,?,?,?,?,?)').run(
                existing.id, sql,
                reqName  || existing.name,
                comment  || existing.comment,
                dbId, user, existing.created_at,
                existing.ut + 1, now
            );
        } else {
            var maxRow = db.prepare('SELECT max(id) AS id FROM sql').get();
            var newId  = (maxRow && maxRow.id) ? maxRow.id + 1 : 1;
            db.prepare('INSERT INTO sql VALUES (?,?,?,?,?,?,?,?,?)').run(
                newId, sql, reqName, comment, dbId, user, now, 1, now
            );
        }
        doneReturn(null);
    } catch (err) {
        doneReturn(err);
    }
}

function changeRequest(sql, dbId, reqName, user, comment, doneReturn, sqlId, type) {
    try {
        var db  = getDb();
        var now = getCurrentDate();
        var row = db.prepare(
            'SELECT max(used_times) as ut, id, comment, name, created_at, last_used FROM sql WHERE id=?'
        ).get(sqlId);

        if (row && row.id) {
            var used_time = (type === 'save') ? row.ut           : (row.ut || 0) + 1;
            var last_used = (type === 'save') ? row.last_used    : now;
            db.prepare('DELETE FROM sql WHERE id=?').run(sqlId);
            db.prepare('INSERT INTO sql VALUES (?,?,?,?,?,?,?,?,?)').run(
                sqlId, sql, reqName, comment, dbId, user, row.created_at, used_time, last_used
            );
        }
        doneReturn(null);
    } catch (err) {
        doneReturn(err);
    }
}

function history(doneReturn) {
    try {
        var rows = getDb().prepare(
            'SELECT id, name, substr(sql,1,120) as sql, comment, dbid, created_by, last_used, used_times '
            + 'FROM sql ORDER BY used_times DESC'
        ).all();
        doneReturn(null, rows);
    } catch (err) {
        doneReturn(err);
    }
}

function details(doneReturn, sqlId) {
    try {
        var row = getDb().prepare('SELECT * FROM sql WHERE id=?').get(sqlId);
        doneReturn(null, row);
    } catch (err) {
        doneReturn(err);
    }
}

function remove(sqlId, doneReturn) {
    try {
        getDb().prepare('DELETE FROM sql WHERE id=?').run(sqlId);
        doneReturn(null);
    } catch (err) {
        doneReturn(err);
    }
}

exports.saveRequest   = saveRequest;
exports.changeRequest = changeRequest;
exports.history       = history;
exports.details       = details;
exports.remove        = remove;
