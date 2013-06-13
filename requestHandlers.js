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

var authenticate = false;
if (config.authenticate) {
    authenticate = true;
}

// prepare some general data elements, that would
// be available to all the templates
exports.prepare_locals =
function prepare_locals (req, res, next) {
    var authenticate = false;
    if (config.authenticate) {
        authenticate = true;
    }

    res.locals( {
        req:          req,
        authenticate: authenticate,
        path:         req.params.path,
        config:       config,
        connection:   req.params.connect,
        pathname:     req.params.path,
        dbType:       req.params.dbType,
        table:        req.params.table,
        column:       req.params.column,
        value:        req.params.value,
        dbId:         req.params.db_id,
        sql:          req.body.sql,
        reqName:      req.body.name,
        user:         (req.session) ? req.session.user : null,
        comment:      req.body.comment,
    } );
    next();
}

// produce a response with a JUST template,
// from the ./view/ directory,
// but use res.locals to store the template data
function respond(res, template, data) {
    // integrate data into res.locals
    res.locals(data);
    // a trick to make locals available to
    // the template
    var locals = {};
    for (var p in res.locals) { locals[p] = res.locals[p]; }
    // execute the template
    just.render( template,
                 locals,
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
    console.log( 'selectDatabase()' );
    respond( res, 'listDatabase', {databaseList: config.db} );
}

function start(req, res) {
    var l = res.locals;

    var tabGr = [];
    async.waterfall([
        function (done){
            readFile(req.params.groups, done);
        },

        function (tableGroups, done){
            getArrayOfStrings(tableGroups, done);
        },

        function (tableGroups, done){
            tabGr = tableGroups;
            var db = getDbType(l.dbType);
            db.showAllTable(l.connection, done);
        }

    ], function (err, result) {
        if (err) {
            showError(req, res, err);
        } else {
            respond( res, 'tableList',
                {   tablesList: result,
                    tableGr: tabGr,
                    path_sql: l.pathname + ":sql" });
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
    var l = res.locals;

    async.waterfall([
        function (done){
            db = getDbType(l.dbType);
            db.showTableRequest(l.connection, l.table, done);
        }

    ], function (err, results) {
        if (err) {
            showError(req, res, err);
        } else {
            var data = {attrList: results[0], indexesArr: results[1], statusArr: results[2]};

            if (l.dbType == 'postgres') {
                data.referenced = results[3];
                data.triggers   = results[4];
                data.foreignKey  = results[5];
            }

            data.path      = l.pathname;
            data.tableName = l.table;
            data.dbType    = l.dbType;
            data.authenticate = authenticate;

            //respond( res, 'tableDetails', data ); -- not good enough
            just.render('tableDetails', data, function(error, html) {
                showPageTotalRecords(res, error, html, db, l.connection, l.table);
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
            showError(req, res, err);
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
    var l = res.locals;

    async.waterfall([
        function (done){
            db = getDbType(l.dbType);
            db.showColumnRequest(l.connection, l.column, l.table, limit, done);
        }

    ], function (err, results) {
        if (err) {
            showError(req, res, err);
        } else {
            respond(res, 'columnData',
                { columnData: results, authenticate: authenticate, path: l.pathname });
        }
    });
}

function showValue(req, res) {
    var limit = 10;
    var db;
    var l = res.locals;

    async.waterfall([
        function (done){
            db = getDbType(l.dbType);
            db.showValueRequest(l.connection, l.table, l.column, l.value, done);
        }
    ], function (err, results) {
        if (err) {
            showError(req, res, err);
        }

        else if (results == 0) {
            showError(req, res, "The value '" + l.value + "' is not present in column '" +
                l.column + "'");
        }

        else {
            respond(res, 'showValues',
                { values: results,
                    limit: limit,
                    authenticate: authenticate,
                    path: l.pathname });
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

function showError (req, res, msg, bc_path) {
    var pathname = bc_path || req.params.path;

    just.render('msg', {
            breadcrumbs_path: pathname,
            title: "404 Status",
            authenticate: authenticate,
            msg: msg },

        function(error, html) {
            if (error) {
                console.log(error);
            }

            console.log(msg);
            res.writeHead(404, {"Content-Type": "text/html"});
            res.write(html);
            res.end();
        }
    );
}

function cssConnect (req, res) {
    justStyle.render('style', {}, function(error, html) {
        showPage(res, error, html, 'css');
    });
}

function sqlRequest(req, res) {
    var l = res.locals;
    var path = l.pathname.replace(/\:/, '/');
    var type = '';

    if(req.params.path_breadcrumbs) {
        path = req.params.path_breadcrumbs;
        type='total change';
    }
    async.waterfall([
        function (done){
            if ( /ALTER|create|drop/i.exec(l.sql) ) {
                showError(req, res, "Request '" + l.sql + "' can not be executed");
            } else {
                done(null);
            }
        },

        function (done){
            var db = getDbType(l.dbType);

            var temp = /from\s+[^\s]+/.exec(l.sql).join();
            var table = temp.replace(/from\s+/, '');

            var temp = /select\s+[^\s]+/.exec(l.sql).join();
            var column = temp.replace(/select\s+/, '');

            db.getSQL(l.connection, l.sql, table, column, done);
        }

    ], function (err, results) {
        if (err) {
            showError(req, res, err);
        } else {
            async.waterfall([
                function(done){
                    if (req.params.sql_id) {
                        sqlite.changeRequest(l.sql, l.dbId, l.reqName, l.user, l.comment, done, req.params.sql_id, 'execute');
                    } else {
                        sqlite.saveRequest(l.sql, l.dbId, l.reqName, l.user, l.comment, done);
                    }
                },

                function(done){
                    just.render('showSqlRequest',
                        { authenticate: authenticate, path: path, sql: l.sql, results: results },
                        function(error, html) {
                            showPage (res, error, html);
                            done(null);
                        });
                }
            ], function (err, results) {
                if (err) {
                    showError(req, res, err);
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
            showError(req, res, err);
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
            showError(req, res, err);
        } else {
            respond( res, 'sqlDetails',
                { values: results, authenticate: authenticate,
                   sqlId: sqlId,   databaseList: config.db });
        }
    });
}

function sqlSave (req, res) {
    var l = res.locals;
    var bc_path = '/' + l.dbId + '/:sql/' + req.params.sql_id + '/saved';

    async.waterfall([
        function (done){
            sqlite.changeRequest(l.sql, l.dbId, l.reqName, l.user, l.comment, done, req.params.sql_id, 'save');
        }

    ], function (err, results) {
        if (err) {
            showError(req, res, err, bc_path);
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
    var l = res.locals;
    var bc_path = '/' + l.dbId + '/:sql/' + req.params.sql_id;

    async.waterfall([
        function (done){
            sqlite.remove(req.params.sql_id, done);
        }

    ], function (err, results) {
        if (err) {
            showError(req, res, err, bc_path);
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