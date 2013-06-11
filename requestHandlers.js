var config = require("./config");

// templating engine
var JUST      = require('just');
var just_usecache = false; // or true
var just      = new JUST({ root: './view', useCache: just_usecache, ext: '.html' });
var justStyle = new JUST({ root: './view', useCache: just_usecache, ext: '.css' });
var justJS    = new JUST({ root: './view', useCache: just_usecache, ext: '.js' });

var mysql    = require('./db_mysql.js');
var postgres = require('./db_postgres.js');
var sqlite   = require('./sqliteDB.js');

var async = require('async');

var connection, pathname, dbType, tableGroupsFile, table, column, value, sql, dbId, 
    reqName, user, comment, path_breadcrumbs, sqlId;

var authenticate = false;
if (config.authenticate) {
    authenticate = true;
}

function set_variables(req) {
    connection      = req.params.connect;
    pathname        = req.params.path;
    dbType          = req.params.dbType;
    tableGroupsFile = req.params.groups || '';
    table           = req.params.table;
    column          = req.params.column;
    value           = req.params.value;
    sql             = req.body.sql;
    dbId            = req.params.dbId;
    reqName         = req.body.name;
    user            = req.session.user;
    comment         = req.body.comment;
    path_breadcrumbs = req.params.path_breadcrumbs;
    sqlId           = req.params.sqlId;
}

function respond(res, template, data) {
    just.render( template, data, 
                 function(error, html) {
                    showPage(res, error, html);
                 });
}




function login (res, pathname, errmsg) {
    if (!pathname) {
        pathname = '/';
    }
    respond( res, 'login', { errormsg: errmsg, path: pathname} );
}

function selectDatabase (req, res) {
    respond( res, 'listDatabase', 
        { databaseList: config.db, authenticate: authenticate} );
}

function start(req, res) {
    set_variables(req);

    var tabGr = [];
    async.waterfall([
        function (done){
            readFile(tableGroupsFile, done);
        },

        function (tableGroups, done){
            getArrayOfStrings(tableGroups, done);
        },

        function (tableGroups, done){
            tabGr = tableGroups;
            var db = getDbType(dbType);
            db.showAllTable(connection, done);
        }

    ], function (err, result) {
        if (err) {
            showError (res, err, pathname);
        } else {
            respond( res, 'tableList',  
                { tablesList: result, path: pathname, tableGr: tabGr, 
                    authenticate: authenticate, path_sql: pathname + ":sql" });
        }
    });
}

function readFile(fileName, done) {
    var fs = require('fs');

    if (fileName) {
        fs.open(fileName, "r+", 0644, function(err, file_handle) {
            if (!err) {
                // read 100 kilobytes from the beginning of the file in ascii
                fs.read(file_handle, 100000, null, 'ascii', function(err, data) {
                    if (!err) {
                        fs.close(file_handle);
                        done(null, data);
                    } else {
                        done(err, '');
                    }
                });
            } else {
                console.log('Can not read file ' + fileName);
                done(err, '');
            }
        });
    } else {
        console.log('File with groups of tables is absent in the file config.js');
        done(null, '');
    }
}

function getArrayOfStrings(string, done) {
    var array = [];
    var i = 0;

    while (/\S/.exec(string)) {
        var temp = /[^\n]+[\n\r]*/.exec(string);
        if (/\S/.exec(temp)) {
            array[i] = temp.join().replace(/\n|\r/g, '');
            i++;
        }
        string = string.replace(/[^\n]+[\n\r]*/, '');
    }

    done(null, array);
}

function showTable(req, res) {
    var db;
    set_variables(req);

    async.waterfall([
        function (done){
            db = getDbType(dbType);
            db.showTableRequest(connection, table, done);
        }

    ], function (err, results) {
        if (err) {
            showError (res, err, pathname);
        } else {
            var data = {attrList: results[0], indexesArr: results[1], foreignKey: results[2]};

            if (dbType == 'postgres') {
                data.referenced = results[3];
                data.triggers   = results[4];
                data.statusArr  = results[5];
            }

            data.path      = pathname;
            data.tableName = table;
            data.dbType    = dbType;
            data.authenticate = authenticate;

            //respond( res, 'tableDetails', data ); -- not good enough
            just.render('tableDetails', data, function(error, html) {
                showPageTotalRecords(res, error, html, db, connection, table);
            });
        }
    });
}

function showPageTotalRecords (res, error, html, db, connection, table) {
async.waterfall([
    function (done) {
        if (error) {
            console.log(error);
        }
        res.writeHead(200, {"Content-Type": "text/html"});
        res.write(html);
        done(null);
    },

    function (done) {
        db.rowsCounter(connection, table, done);
    }

    ], function (err, counter) {
        if (err) {
            showError (res, err, pathname);
        } else {
            just.render('totalRecords', {rowsCounter: counter}, function(error, html_counter) {
                if (err) {
                    console.log(err);
                }
                res.write(html_counter);
                res.end();
            });
        }
    });
}

function showColumn(req, res) {
    var limit = 20;
    var db;
    set_variables(req);

    async.waterfall([
        function (done){
            db = getDbType(dbType);
            db.showColumnRequest(connection, column, table, limit, done);
        }

    ], function (err, results) {
        if (err) {
            showError (res, err, pathname);
        } else {
            respond(res, 'columnData', 
                { columnData: results, authenticate: authenticate, path: pathname });
        }
    });
}

function showValue(req, res) {
    var limit = 10;
    var db;
    set_variables(req);

    async.waterfall([
        function (done){
            db = getDbType(dbType);
            db.showValueRequest(connection, table, column, value, done);
        }
    ], function (err, results) {
        if (err) {
            showError (res, err, pathname);
        }

        else if (results == 0) {
            showError(res, "The value '" + value + "' is not present in column '" + 
                column + "'", pathname);
        }

        else {
            respond(res, 'showValues', 
                { values: results, 
                    limit: limit, 
                    authenticate: authenticate, 
                    path: pathname });
        }
    });
}

function getDbType (dbType) {
    var db = mysql;

    if (dbType == 'postgres') {
        db = postgres;
    }

    return db;
}

function showPage (res, error, html, type) {
    if (error) {
        console.log(error);
    }

    if (!type) {
        type = 'html';
    }

    res.writeHead(200, {"Content-Type": "text/" + type});
    res.write(html);
    res.end();
}

function showError (req, res, msg) {
    var pathname = req._pathname;
    just.render('msg', { breadcrumbs_path: pathname,
            title: "404 Status",
            authenticate: authenticate,
            msg: msg }, function(error, html) {
        if (error) {
            console.log(error);
        }

        console.log(msg);
        res.writeHead(404, {"Content-Type": "text/html"});
        res.write(html);
        res.end();
    });
}

function cssConnect (req, res) {
    justStyle.render('style', {}, function(error, html) {
        showPage (res, error, html, 'css');
    });
}

function sqlRequest(req, res) {
    set_variables(req);
    var path = pathname.replace(/\:/, '/');
    var type = '';

    if(path_breadcrumbs) {
        path = path_breadcrumbs;
        type='total change';
    }
    async.waterfall([
        function (done){
            if ( /ALTER|create|drop/i.exec(sql) ) {
                 showError (res, "Request '" + sql + "' can not be executed", pathname);
            } else {
                done(null);
            }
        },

        function (done){
            var db = getDbType(dbType);
            db.getSQL(connection, sql, done);
        }

    ], function (err, results) {
        if (err) {
            showError (res, err, pathname);
        } else {
            async.parallel([
                function(done){
                    if (sqlId) {
                        sqlite.changeRequest(sql, dbId, reqName, user, comment, done, sqlId, 'execute');
                    } else {
                        sqlite.saveRequest(sql, dbId, reqName, user, comment, done);
                    }
                },

                function(done){
                    just.render('showSqlRequest', 
                        { authenticate: authenticate, path: path, sql: sql, results: results }, 
                        function(error, html) {
                            showPage (res, error, html);
                            done(null);
                        });
                }
            ], function (err, results) {
                if (err) {
                    showError(res, err, pathname);
                }
            });
        }
    });
}

function sqlHistory (res) {
    var limit = 20;

    async.waterfall([
        function (done){
            sqlite.history(done);
        }

    ], function (err, results) {
        if (err) {
            showError (res, err, pathname);
        } else {
            respond( res, 'sqlHistory', 
                { values: results, limit: limit, authenticate: authenticate });
        }
    });
}

function sqlDetails (res, sqlId) {
    async.waterfall([
        function (done){
            sqlite.details(done, sqlId);
        }

    ], function (err, results) {
        if (err) {
            showError (res, err, pathname);
        } else {
            respond( res, 'sqlDetails', 
                { values: results, authenticate: authenticate, 
                   sqlId: sqlId,   databaseList: config.db });
        }
    });
}

function sqlSave (req, res) {
    set_variables(req);
    var bc_path = '/' + dbId + '/:sql/' + sqlId + '/saved';

    async.waterfall([
        function (done){
            sqlite.changeRequest(sql, dbId, reqName, user, comment, done, sqlId, 'save');
        }

    ], function (err, results) {
        if (err) {
            showError (res, err, bc_path);
        } else {
            respond( res, 'msg', 
                { breadcrumbs_path: bc_path, 
                  title: 'Saving status', 
                  msg: 'Saving was successful!', 
                  authenticate: authenticate });
        }
    });
}

function sqlRemove (req, res) {
    set_variables(req);
    var bc_path = '/' + dbId + '/:sql/' + sqlId;

    async.waterfall([
        function (done){
            sqlite.remove(sqlId, done);
        }

    ], function (err, results) {
        if (err) {
            showError (res, err, bc_path);
        } else {
            respond( res, 'msg', 
                { breadcrumbs_path: bc_path, title: 'Removing status', 
                msg: 'Removing was successful!', authenticate: authenticate});
        }
    });
}

exports.start = start;
exports.login = login;
exports.showTable      = showTable;
exports.cssConnect     = cssConnect;
exports.showColumn     = showColumn;
exports.showError      = showError;
exports.selectDatabase = selectDatabase;
exports.showValue      = showValue;
exports.sqlRequest     = sqlRequest;
exports.sqlHistory     = sqlHistory;
exports.sqlDetails     = sqlDetails;
exports.sqlSave        = sqlSave;
exports.sqlRemove      = sqlRemove;