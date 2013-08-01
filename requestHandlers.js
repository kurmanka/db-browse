var config = require("./config");

var Memcached = require('memcached');
var memcached = ( config.cache ) ? new Memcached(config.cache_memcached)
                                 : null;

// Just templating engine, https://github.com/baryshev/just
var JUST      = require('just');
var just_usecache = false; // or true
var just      = new JUST({ root: './view', useCache: just_usecache, ext: '.html' });

var mysql    = require('./db_mysql.js');
var postgres = require('./db_postgres.js');
var sqlite   = require('./sqliteDB.js');
var util     = require('./util.js');

var async    = require('async');
var child_process = require('child_process');
var checksum = require('checksum');

var authenticate = false;
if (config.authenticate) {
    authenticate = true;
}

// prepare some general data elements, that would
// be available to all the templates
exports.prepare_locals =
function prepare_locals (req, res, next) {
    var authenticate = false;
    if (config.authenticate || config.authenticate_userfile) {
        authenticate = true;
    }

    if (req.body.comment == 'comment...'){
        req.body.comment = '';
    }

    res.locals( {
        req:           req,
        authenticate:  authenticate,
        databaseList:  config.db,
        path:          req.params.path,
        config:        config,
        connection:    req.params.connect,
        pathname:      req.params.path,
        dbType:        req.params.dbType,
        table:         req.params.table,
        column:        req.params.column,
        value:         req.params.value,
        dbId:          req.params.db_id,
        sql:           (req.body.sql) ? req.body.sql.replace(/;/, ''): '',
        reqName:       req.body.name,
        user:          (req.session) ? req.session.user : null,
        comment:       req.body.comment || '',
        sql_id:        req.params.sql_id,
        lastStringReq: '',
        breadcrumbs:   []
    } );
    // prepare breadcrumbs}}{}
    breadcrumbs(req, res);
    next();
}

// produce a response with a JUST template,
// from the ./view/ directory,
// but use res.locals to store the template data
function respond(res, template, data, callback) {
    // integrate data into res.locals
    res.locals(data);
    // a trick to make locals available to
    // the template
    var locals = {};
    for (var p in res.locals) { locals[p] = res.locals[p]; }
    // the default callback
    callback = (callback) ? callback
                          : function(error, html) { showPage(res, error, html); };
    // execute the template
    just.render( template,
                 locals,
                 callback );
}

// produce error response if there is error,
// or produce page response otherwise
function finish( req, res, template, data, cb) {
    // return a function
    return function (err, result) {
        if (err) {
            showError(req, res, err);
        } else {
            respond( res, template, data, cb );
        }
    };
}

function finish_jade( req, res, template, data, cb) {
    if (!template.match(/\.jade$/)) {
        template = template + '.jade';
    }

    cb = (cb) ? cb
              : function(error, html) { showPage(res, error, html); };

    // return a function
    return function (err, result) {
        if (err) {
            showError(req, res, err);
        } else {
            res.render( template, data, cb );
        }
    };
}

function showPage (res, error, content, type) {
    if (error) {
        console.log(error);
    }

    if (!type) {
        type = 'html';
    }

    res.set('Content-Type', 'text/' + type );
    res.send(content);
}

function showError (req, res, msg, title) {
    breadcrumbs( req, res );

    just.render('msg', {
            breadcrumbs: res.locals.breadcrumbs,
            title: title || "Error",
            authenticate: authenticate,
            msg: msg },

        function(error, html) {
            if (error) {
                console.log(error);
            }

            console.log(msg);
            res.send(500, html);
        }
    );
}

function breadcrumbs(req, res, next) {
    var l = res.locals;
    var bc = [];
    var db_id = req.params.db_id,
      table   = req.params.table,
      column  = req.params.column,
      value   = req.params.value;
    if (db_id || req.params.path != '') {
        bc.push({u: '', t:'Home'});
    }
    if (table) {
        bc.push({u: db_id, t: db_id });
    }
    if (column) {
        bc.push({u: db_id + '/' + table, t: table });
    }
    if (value) {
        bc.push({u: db_id + '/' + table + '/' + column, t: column });
    }
    if (req.params.sql_id) {
        bc.push({u: ':sql', t: 'SQL' });        
    }

    l.breadcrumbs = bc;
    if (next) next();
}



function login( req, res, errmsg ) {
    res.render( 'login.jade', { req: req, errormsg: errmsg } );
}

function selectDatabase (req, res) {
    console.log( 'selectDatabase()' );
    res.render( 'listDatabase.jade', { addons: res.app.addons } );
}

function _list_tables(req, res, next) {
    var l = res.locals;
    // this is to be refactored soon XXX
    l.path_sql = l.pathname + ":sql";

    async.waterfall([
        function (done){
            util.readFile(req.params.groups, done);
        },

        function (tableGroups, done){
            util.getArrayOfStrings(tableGroups, done);
        },

        function (tableGroups, done){
            l.tableGr = tableGroups;
            var db = getDbType(l.dbType);
            db.showAllTable(l.connection, done);
        },

        function (tablesList, done) {
            l.tablesList = tablesList;

            // get all actual tables names in an index, the tables variable 
            // object.
            // make two identical indexes.
            var tables = {};
            var the_rest_obj = {};  // this one will have items removed from later
  
            for (var i in tablesList) {
                var t = tablesList[i];
                tables[t] = 1;
                the_rest_obj[t] = 1;
            }
            l.tables = tables;

  
            // if table groups are defined...
            if (l.tableGr.length) {
                var groups =  l.groups = [],
                    g;

                // go through the tableGr array
                // which is an array of strings
                for (var i = 0; i < l.tableGr.length; i++) {
                    t = l.tableGr[i];

                    // skip empty lines
                    if (t.length== 0) { continue; }

                    // if line starts with a space, it is a group start
                    if (t.charAt(0) == " ") {
                        // new group
                        g = {name:t,list:[]};
                        groups.push(g);

                    // else it is a group entry
                    } else if (g) {
                        g.list.push(t);
                        delete the_rest_obj[t];

                    // no group to add an entry to? non-sense.
                    } else {
                        console.log( 'no group to add '+t+' to.' );
                    }

                };

                // the list of tables existing in the db, but not mentioned
                // in the groups file
                l.the_rest = Object.keys(the_rest_obj);
            }

            done(null);
        },
    ], next
    );
}

_list_tables.cache_key = function(r) {return r.url;}
_list_tables.template = 'tableList';
_list_tables.jade = true;
                           // in the order of appearance:
_list_tables.produce_locals = [ 'path_sql', 'tableGr', 'tables', 'groups', 'the_rest', ];

function list_tables (req, res, next) {
    cache_wrapper( req, res, _list_tables);
}

function mysqlChecker (res, methodRun, attrList, done) {
    var l = res.locals;

    if (l.dbType == 'mysql') {
        methodRun(attrList, done, res);//get last string of request 'show create table'
    } else {
        done(null, attrList);
    }
}

function showTable(req, res, next) {
    var db;
    var l = res.locals;

    async.waterfall([
        function (done){
            db = getDbType(l.dbType);
            db.showTableRequest(l.connection, l.table, done);
        },

        function (attrList, done){
            l.create_table = attrList[1];
            // get last string of request 'show create table' for tables of db mysql
            mysqlChecker(res, getCreateTableDetails, attrList, done);
        },

        function (attrList, done){
            // get Indexes for tables of db mysql
            mysqlChecker(res, getIndexes, attrList, done); 
        },

        function (attrList, done){
            // added columns Collate and Charset for tables of db mysql
            mysqlChecker(res, addCollateCharset, attrList, done); 
        },

        function (results, done){
            var data = {attrList: results[0], indexesArr: results[1], statusArr: results[2]};

            if (l.dbType == 'postgres') {
                data.referenced = results[3];
                data.triggers   = results[4];
                data.foreignKey = results[5];
            }
            res.locals(data);
            done(null);
        }

    ],  function (err, data) {
            // err is most likely being "Table xxx not found". at least, that's
            // what we assume here
            if (err) {
                // call the next chained function, specifically, check for an addon feature
                // of the same name
                next();
            } else {
                // provide a custom callback for the template
                var handler = finish(req, res, 'tableDetails', {},
                    function(error, html) {
                    showPageTotalRecords(req, res, error, html, db);
                });
                handler(err,data);
            }
        }
    );
}

function getValueFromKey (keyName, array) {
    for (var key in array) {
        if (key == keyName) {
            return array[key];
        }
    }
    return null;
}

function getCreateTableDetails(attrList, done, res) {
    var request = getValueFromKey('Create Table', attrList[1][0]);

    var lastString = /(\).+)$/.exec(request);

    res.locals.lastStringReq = lastString[0].replace(/\)/, '');
    done (null, attrList);
}

function getIndexes(attrList, done) {
    var resultArr = [];
    var i = 0;

    var request = getValueFromKey('Create Table', attrList[1][0]);

    while ( /\s.*KEY.+,*/.exec(request) ) {
        resultArr[i] = /\s.*KEY.+,*/.exec(request);
        request = request.replace(/\s.*KEY.+,*/, '');
        i++;
    }

    attrList[1] = resultArr;
    done(null, attrList);
}

function addCollateCharset(attrList, doneReturn) {
    var resultArr = [];
    var rows = attrList[0];

    async.waterfall([
        function (done){
            searchCollateCharset(attrList[1], done);
        },

        function (CollateCharsetArr, done){
            for ( var i = 0; i < rows.length; i++ ) {
                var tempArr = [];
                var j = 0;
                var columnName;
                for ( var key in rows[0] ) {
                    if (j == 0) {
                        columnName = rows[i][key];
                    }
                    if (j == 2) {
                        tempArr.Charset = CollateCharsetArr.charset[columnName] || '';
                        tempArr.Collate = CollateCharsetArr.collate[columnName] || '';
                    }
                    tempArr[key] = rows[i][key];
                    j++;
                }
                resultArr[i] = tempArr;
            }
            attrList[0] = resultArr;
            doneReturn(null, attrList);
        }
    ]);
}

function searchCollateCharset(data, done) {
    var dataText;
    var resultArr = [];

    var collates = searchObject(data, 'COLLATE');
    var charsets = searchObject(data, 'CHARACTER SET');

    resultArr['collate'] = collates;
    resultArr['charset'] = charsets;

    done(null, resultArr);
}

function searchObject(data, obType) {
    var request = getValueFromKey('input', data[0]);

    var checker = /CHARACTER SET/;
    if (obType == 'COLLATE') {
        checker = /COLLATE/;
    }

    var objects = [];
    var i = 0;
    while (checker.exec(request)) {
        var object = '';
        if (obType == 'COLLATE') {
            object = /.+COLLATE\s+[^\s]+/.exec(request);
        } else {
            object = /.+CHARACTER SET\s+[^\s]+/.exec(request);
        }

        var key = /\`.+\`/.exec(object);
        if (key) {
            key = key.join().replace(/\`/g, '');

            if (obType == 'COLLATE') {
                object = /COLLATE\s+[^\s]+/.exec(object);
            } else {
                object = /CHARACTER SET\s+[^\s]+/.exec(object);
            }

            if (obType == 'COLLATE') {
                object = object.join().replace(/COLLATE\s+/, '');
            } else {
                object = object.join().replace(/CHARACTER SET\s+/, '');
            }

            objects[key] = object;
            i++;
        }
        request = request.replace(checker, '');
    }

    return objects;
}

function noSuchTable (req, res, next) {
    res.send('No such table: ' + req.params.table);
}


function showPageTotalRecords (req, res, error, html, db) {
    var l = res.locals;

    async.waterfall([
        function (done) {
            if (error) {
                console.log(error);
            }
            // send the main part of the page
            res.writeHead(200, {"Content-Type": "text/html"});
            res.write(html);
            done(null);
        },

        function (done) {
            db.rowsCounter(l.connection, l.table, done);
        },

        function (count, done) {
            l.rowsCounter = count;
            done(null);
        }
    ],
    finish(req, res, 'totalRecords', {},
        function(err, html) {
                if (err) {
                    console.log(err);
                }
                res.write(html);
                res.end();
        })
    );
}

function _showColumn(req, res, next) {
    var limit = parseInt(req.query.limit, 10) || 20;
    var db;
    var l = res.locals;
    l.nextlimit = limit + 20;

    async.waterfall([
        function (done){
            db = getDbType(l.dbType);
            db.showColumnRequest(l.connection, l.column, l.table, limit, done);
        },
        function( columnData, done ) {
            l.columnData = columnData;
            done(null);
        }
    ], 
      next
    );
}

_showColumn.cache_key      = function(req) { return req.url; }
_showColumn.produce_locals = ['columnData','nextlimit'];
_showColumn.template       = 'columnData';

function showColumn(req, res) {
    cache_wrapper(req, res, _showColumn);
}


function showValue(req, res) {
    var limit = 10;
    var db;
    var l = res.locals;
    var template;

    var v = req.param('v');
    if ( v == 'single' ) {
        template = 'showValues_single';
    }
    else if ( v == 'row' ) {
        template = 'showValues_row';
    }
    else {
        template = 'showValues_col';
    }

    async.waterfall([
        function (done){
            db = getDbType(l.dbType);
            db.showValueRequest(l.connection, l.table, l.column, l.value, done);
        },

        function (results, done) {
            if (results == 0) {
                // error
                done( "The value '" + l.value + "' is not present in column '" +
                      l.column + "'" );
            } else {
                l.values = results;
                done(null);
            }
        }
    ], finish( req, res, template, { limit: limit } )
    );
}

function getDbType (dbType) {
    var db = mysql;

    if (dbType == 'postgres') {
        db = postgres;
    }

    return db;
}

function sqlRequest(req, res) {
    var l = res.locals;

    console.log( 'sql:', l.sql );

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
            db.getSQL(l.connection, l.sql, done);
        },

        function (results,done){
            l.results = results;
            if (req.params.sql_id) {
                sqlite.changeRequest(l.sql, l.dbId, l.reqName, l.user, l.comment, done,
                                     req.params.sql_id, 'execute');
            } else {
                sqlite.saveRequest(l.sql, l.dbId, l.reqName, l.user, l.comment, done);
            }
        }, 
    ], 

        finish( req, res, 'showSqlRequest' ) 
    );
}

function sqlHistory (req, res) {
    var limit = 20;
    var l = res.locals;

    async.waterfall([
        sqlite.history,
        function (result, done){
            l.values = result;
            done(null);
        },
    ], 
        finish_jade( req, res, 'sqlHistory.jade', { limit: limit })
    );
}

function sqlDetails (req, res) {
    var l = res.locals;

    async.waterfall([
        function (done){
            sqlite.details(done, req.params.sql_id);
        },

        function (result, done){
            l.values = result;
            done(null);
        },
    ],
    finish( req, res, 'sqlDetails' )
    );
}

function sqlSave (req, res) {
    var l = res.locals;

    async.waterfall([
        function (done){
            sqlite.changeRequest(l.sql, l.dbId, l.reqName, l.user, l.comment,
                                  done, req.params.sql_id, 'save');
        }

    ],
    finish ( req, res, 'msg', { 
                                title: 'Saving status',
                                msg: 'Saving was successful!' }
           )
    );
}

function sqlRemove (req, res) {
    var l = res.locals;

    async.waterfall([
        function (done){
            sqlite.remove(req.params.sql_id, done);
        }

    ],
    finish ( req, res, 'msg', { 
                                 title: 'Removing status',
                                msg: 'Removing was successful!' }
            )
    );
}


function produce_db_schema (req, res, next) {

    var exec      = child_process.exec;
    var pg_path   = config.pg_dump_path || "pg_dump";

    var dbconfig  = req.dbconfig; // same as config.db[l.dbId]
    var user      = dbconfig.user;
    var db_name   = dbconfig.database;
    var pass      = dbconfig.password;
    var buffer    = dbconfig.dump_buffer || 2000;
    var extra_params = '';

    if (dbconfig.host) {
        extra_params = " -h " + dbconfig.host;
    }

    if (dbconfig.port) {
        extra_params = " -p " + dbconfig.port;
    }

    var command = pg_path + " -U " + user + extra_params + " -s " + db_name;
    console.log( 'db_schema command:', command );
    console.log( 'db_schema buffer:', buffer );

    exec( command, 
        { env: { PGPASSWORD: pass }, maxBuffer: buffer * 1024 }, 
        function (err, stdout, stderr) {
            res.locals.schema = stdout;
            next(err);
        }
    );

}

produce_db_schema.cache_key = function(req) { return [req.params.db_id]; }

produce_db_schema.produce_locals = ['schema'];

produce_db_schema.template = 'db_schema';


function show_db_schema (req, res) {
    cache_wrapper(req,res,produce_db_schema);
}

function cache_wrapper (req, res, handler) {
    var l = res.locals;

    // handler is the function that does the main job
    // of processing the request. It sets some keys in 
    // locals.

    var cache_key_core = handler.cache_key(req);

    var cache_key = handler.name + checksum(JSON.stringify(cache_key_core));
    console.log( 'cache key:', cache_key );

    var template = handler.template;
    if (typeof template == 'function') { template = template(req) }

    var render = (handler.jade) ? finish_jade( req, res, template )
                                : finish( req, res, template );

    var the_locals = handler.produce_locals;
    if (typeof the_locals == 'function') { the_locals = the_locals(req) }

    // in seconds
    var cache_ttl  = handler.cache_ttl || 600;

    // accepts (err,anything)
    var r = function(err,something) {
        // produce a response
        render(err);

        // cache it, if it is not an error and there is somewhere to cache it in
        if (! err && memcached) {
            // prepare the cacheable data.
            // cache_val_o is the container.
            var cache_val_o = [];
            for ( var i in the_locals ) {
                var k = the_locals[i];
                cache_val_o[i] = l[k];
                console.log('take '+k+' from locals');
            }
            //console.log( 'cache_val_o:', cache_val_o );
            // serialize the container
            var string = JSON.stringify(cache_val_o);
            // store it
            console.log( 'save to cache:', cache_key );
            memcached.set( cache_key, string, cache_ttl,
                function(err) { console.log('set:', err ? err : 'success'); });
        }        
    };

    if (memcached) {
        // check the cache        
        var cl = memcached.get(cache_key, function (err,string) {
            if (string) {
                console.log('cache: hit!');
                // deserialize
                var cache_val_o = JSON.parse(string);
                // transfer to locals
                for ( var i in the_locals ) {
                    var k = the_locals[i];
                    l[k] = cache_val_o[i];
                    console.log('set '+k+' in locals');
                }
                // render the template to produce the response
                render();

            } else {
                console.log('cache: miss:', err);
                handler(req, res, r);
            }
        });
    } else {
        handler(req, res, r);
    }

}




exports.list_tables       = list_tables;
exports.login             = login;
exports.showTable         = showTable;
exports.noSuchTable       = noSuchTable;
exports.showColumn        = showColumn;
exports.showError         = showError;
exports.selectDatabase    = selectDatabase;
exports.showValue         = showValue;
exports.sqlRequest        = sqlRequest;
exports.sqlHistory        = sqlHistory;
exports.sqlDetails        = sqlDetails;
exports.sqlSave           = sqlSave;
exports.sqlRemove         = sqlRemove;
exports.show_db_schema    = show_db_schema;
