/**
 * MOST Web Framework
 * A JavaScript Web Framework
 * http://themost.io
 * Created by Kyriakos Barbounakis<k.barbounakis@gmail.com> on 2014-02-03.
 *
 * Copyright (c) 2014, Kyriakos Barbounakis k.barbounakis@gmail.com
 Anthi Oikonomou anthioikonomou@gmail.com
 All rights reserved.
 Redistribution and use in source and binary forms, with or without
 modification, are permitted provided that the following conditions are met:
 * Redistributions of source code must retain the above copyright notice, this
 list of conditions and the following disclaimer.
 * Redistributions in binary form must reproduce the above copyright notice,
 this list of conditions and the following disclaimer in the documentation
 and/or other materials provided with the distribution.
 * Neither the name of MOST Web Framework nor the names of its
 contributors may be used to endorse or promote products derived from
 this software without specific prior written permission.
 THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
/**
 * @private
 */
var JDBC = require('jdbc'),
    jinst = require('jdbc/lib/jinst'),
    async = require('async'),
    util = require('util'),
    path = require('path'),
    qry = require('most-query');

if (!jinst.isJvmCreated()) {
    jinst.addOption("-Xrs");
    jinst.setupClasspath([ path.resolve(__dirname, './drivers/h2-latest.jar')]);
}


/**
 * @class
 * @constructor
 * @param {*|{path:string,database:string,host:string,port:number,user:string,password:string,pool:number}} options
 * @augments DataAdapter
 */
function H2Adapter(options)
{
    /**
     * @private
     * @type {Connection}
     */
    this.rawConnection = null;

    if (typeof options === 'undefined' || options == null) {
        throw new Error("Data adapter options may not be empty.");
    }

    this.getOptions = function() {
        var result;
        //build URL
        if (typeof options.path === 'string') {
            result = {
                url : util.format("jdbc:h2:%s;AUTO_SERVER=true;AUTO_RECONNECT=true", options.path),
                minpoolsize:1,
                maxpoolsize: typeof options.pool === 'number' ? options.pool : 25,
                properties : {
                    "user" : options.user,
                    "password": options.password
                }
            };
            return result;
        }
        else if (typeof options.host === 'string') {
            var host_ = options.port ? options.host + ":" + options.port : options.host;
            result = {
                url : util.format("jdbc:h2:tcp://%s/%s;AUTO_RECONNECT=true", host_, options.database),
                minpoolsize:1,
                maxpoolsize: typeof options.pool === 'number' ? options.pool : 25,
                properties : {
                    "user" : options.user,
                    "password": options.password
                }
            };
            return result;
        }
        else {
            throw new Error("Database path or host may not be empty.");
        }
    }

}
/**
 * @returns {string}
 * @private
 */
function getTimezone_() {
    var offset = (new Date()).getTimezoneOffset();
       return (offset<=0 ? '+' : '-') + zeroPad(-Math.floor(offset/60),2) + ':' + zeroPad(offset%60,2);
}
/**
 *
 * @param {Function} callback
 * @private
 */
function getDatabaseTimezone_(callback) {
    return this.execute('SELECT FORMATDATETIME(CURRENT_TIMESTAMP(),\'XXX\') as "timezone"', null, function (err, result) {
        if (err) { return callback(err); }
        return callback(null, result[0]["timezone"]);
    });
}

/**
 * Opens database connection
 */
H2Adapter.prototype.open = function(callback)
{
    callback = callback || function() {};
    var self = this;
    if (self.rawConnection) {
        return callback();
    }
    H2Adapter.pools = H2Adapter.pools || { };
    //get connection options
    var options = this.getOptions(), connectionPool;
    if (H2Adapter.pools.hasOwnProperty(options.url)) {
        connectionPool=H2Adapter.pools[options.url];
        connectionPool.reserve(function(err, connObj) {
            if (err) { return callback(err); }
            self.rawConnection = connObj;
            return callback();
        });
    }
    else {
        connectionPool = new JDBC(self.getOptions());
        H2Adapter.pools[options.url] = connectionPool;
        connectionPool.initialize(function(err) {
            if (err) { return callback(err); }
            connectionPool.reserve(function(err, connObj) {
                if (err) { return callback(err); }
                self.rawConnection = connObj;
                return callback();
            });
        });
    }

};
/**
 * @param {function(Error=)} callback
 */
H2Adapter.prototype.close = function(callback) {
    var self = this;
    callback = callback || function() {};
    if (typeof self.rawConnection === 'undefined' || self.rawConnection == null) {
        return callback();
    }
    H2Adapter.pools = H2Adapter.pools || { };
    var options = this.getOptions(),
        connectionPool=H2Adapter.pools[options.url];
    if (typeof connectionPool === 'undefined' || connectionPool == null) {
        return callback(new Error("Connection pool may not be empty at this context."))
    }
    connectionPool.release(self.rawConnection, function(err) {
        if (err) {
            console.log(err);
        }
        self.rawConnection=null;
        return callback();
    });
};

/**
 * Begins a data transaction and executes the given function
 * @param fn {Function}
 * @param callback {Function}
 */
H2Adapter.prototype.executeInTransaction = function(fn, callback)
{
    var self = this;
    //ensure callback
    callback = callback || function () {};
    //ensure that database connection is open
    self.open(function(err) {
        if (err) {
            return callback(err);
        }
        //execution is already in transaction
        if (self.transaction_) {
            //so invoke method
            fn.call(self, function(err)
            {
                //call callback
                return callback(err);
            });
        }
        else {
            //set auto commit to off
            return self.rawConnection.conn.setAutoCommit(false, function() {
                if (err) { return callback(err); }
                //set savepoint
                self.transaction_ = true;
                try {
                    //invoke method
                    fn.call(self, function(error)
                    {
                        if (error) {
                            self.rawConnection.conn.rollback(function(err) {
                                if (err) {
                                    //log transaction rollback error
                                    util.log("An error occured while rolling back savepoint.");
                                    util.log(err);
                                }
                                delete self.transaction_;
                                return self.rawConnection.conn.setAutoCommit(true, function() {
                                    return callback(error);
                                });
                            });
                        }
                        else {
                            self.rawConnection.conn.commit(function(err) {
                                delete self.transaction_;
                                return self.rawConnection.conn.setAutoCommit(true, function() {
                                    return callback(err);
                                });
                            });
                        }
                    });
                }
                catch(e) {
                    self.rawConnection.conn.rollback(function(err) {
                        if (err) {
                            //log transaction rollback error
                            util.log("An error occured while rolling back savepoint.");
                            util.log(err);
                        }
                        delete self.transaction_;
                        return self.rawConnection.conn.setAutoCommit(true, function() {
                            return callback(e);
                        });
                    });
                }
            });
        }
    });
};

/**
 * Executes an operation against database and returns the results.
 * @param batch {*}
 * @param callback {Function}
 */
H2Adapter.prototype.executeBatch = function(batch, callback) {
    callback = callback || function() {};
    callback(new Error('DataAdapter.executeBatch() is obsolete. Use DataAdapter.executeInTransaction() instead.'));
};

/**
 * Produces a new identity value for the given entity and attribute.
 * @param entity {String} The target entity name
 * @param attribute {String} The target attribute
 * @param callback {Function=}
 */
H2Adapter.prototype.selectIdentity = function(entity, attribute , callback) {

    var self = this;

    var migration = {
        appliesTo:'increment_id',
        model:'increments',
        description:'Increments migration (version 1.0)',
        version:'1.0',
        add:[
            { name:'id', type:'Counter', primary:true },
            { name:'entity', type:'Text', size:120 },
            { name:'attribute', type:'Text', size:120 },
            { name:'value', type:'Integer' }
        ]
    };
    //ensure increments entity
    self.migrate(migration, function(err)
    {
        //throw error if any
        if (err) { callback.call(self,err); return; }

        self.execute('SELECT * FROM "increment_id" WHERE "entity"=? AND "attribute"=?', [entity, attribute], function(err, result) {
            if (err) { callback.call(self,err); return; }
            if (result.length==0) {
                //get max value by querying the given entity
                var q = qry.query(entity).select([qry.fields.max(attribute)]);
                self.execute(q,null, function(err, result) {
                    if (err) { callback.call(self, err); return; }
                    var value = 1;
                    if (result.length>0) {
                        value = parseInt(result[0][attribute]) + 1;
                    }
                    self.execute('INSERT INTO "increment_id"("entity", "attribute", "value") VALUES (?,?,?)',[entity, attribute, value], function(err) {
                        //throw error if any
                        if (err) { callback.call(self, err); return; }
                        //return new increment value
                        callback.call(self, err, value);
                    });
                });
            }
            else {
                //get new increment value
                var value = parseInt(result[0].value) + 1;
                self.execute('UPDATE "increment_id" SET "value"=? WHERE "id"=?',[value, result[0].id], function(err) {
                    //throw error if any
                    if (err) { callback.call(self, err); return; }
                    //return new increment value
                    callback.call(self, err, value);
                });
            }
        });
    });
};

H2Adapter.prototype.lastIdentity = function(callback) {
    var self = this;
    self.open(function(err) {
        if (err) {
            callback(err);
        }
        else {
            self.execute('SELECT SCOPE_IDENTITY() as "lastval"', [], function(err, result) {
                if (err) {
                    callback(null, { insertId: null });
                }
                else {
                    result = result || [];
                    if (result.length>0)
                        callback(null, { insertId:parseInt(result[0]["lastval"]) });
                    else
                        callback(null, { insertId: null });
                }
            });
        }
    });
};

/**
 * @param query {*}
 * @param values {*}
 * @param {function} callback
 */
H2Adapter.prototype.execute = function(query, values, callback) {
    var self = this, sql = null;
    try {

        if (typeof query == 'string') {
            sql = query;
        }
        else {
            //format query expression or any object that may be act as query expression
            var formatter = new H2Formatter();
            formatter.settings.nameFormat = H2Adapter.NAME_FORMAT;
            sql = formatter.format(query);
        }
        //validate sql statement
        if (typeof sql !== 'string') {
            callback.call(self, new Error('The executing command is of the wrong type or empty.'));
            return;
        }
        //ensure connection
        self.open(function(err) {
            if (err) {
                callback.call(self, err);
            }
            else {

                var startTime;
                if (process.env.NODE_ENV==='development') {
                    startTime = new Date().getTime();
                }
                //execute raw command
                var str = qry.prepare(sql, values);
                self.rawConnection.conn.createStatement(function(err, statement) {
                    if (err) { return callback(err); }
                    var executeQuery = statement.executeQuery;
                    if (!/^SELECT/i.test(str)) {
                        executeQuery = statement.executeUpdate;
                    }
                    executeQuery.call(statement, str, function(err, result) {
                        if (process.env.NODE_ENV==='development') {
                            console.log(util.format('SQL (Execution Time:%sms):%s, Parameters:%s', (new Date()).getTime()-startTime, sql, JSON.stringify(values)));
                        }
                        if (err) {
                            return callback(err);
                        }
                        if (typeof result.toObjArray === 'function') {
                            result.toObjArray(function(err, results) {
                                return callback(null, results);
                            });
                        }
                        else {
                            return callback(null, result);
                        }
                    });
                });
            }
        });
    }
    catch (e) {
        callback.call(self, e);
    }

};
/**
 * Formats an object based on the format string provided. Valid formats are:
 * %t : Formats a field and returns field type definition
 * %f : Formats a field and returns field name
 * @param format {string}
 * @param obj {*}
 */
H2Adapter.format = function(format, obj)
{
    var result = format;
    if (/%t/.test(format))
        result = result.replace(/%t/g,H2Adapter.formatType(obj));
    if (/%f/.test(format))
        result = result.replace(/%f/g,obj.name);
    return result;
};

H2Adapter.formatType = function(field)
{
    var size = parseInt(field.size);
    var scale = parseInt(field.scale);
    var s = 'VARCHAR(512) NULL';
    var type=field.type;
    switch (type)
    {
        case 'Boolean':
            s = 'BOOLEAN';
            break;
        case 'Byte':
            s = 'TINYINT';
            break;
        case 'Number':
        case 'Float':
            s = 'REAL';
            break;
        case 'Counter':
            return 'INT AUTO_INCREMENT NOT NULL';
        case 'Currency':
            s =  'DECIMAL(19,4)';
            break;
        case 'Decimal':
            s =  util.format('DECIMAL(%s,%s)', (size>0 ? size : 19),(scale>0 ? scale : 8));
            break;
        case 'Date':
            s = 'DATE';
            break;
        case 'DateTime':
            s = 'TIMESTAMP';
            break;
        case 'Time':
            s = 'TIME';
            break;
        case 'Integer':
            s = 'INTEGER';
            break;
        case 'Duration':
            s = size>0 ?  util.format('VARCHAR(%s)', size) : 'VARCHAR(36)';
            break;
        case 'BigInteger':
            s = 'BIGINT';
            break;
        case 'URL':
            s = size>0 ?  util.format('VARCHAR(%s)', size) : 'VARCHAR(512)';
            break;
        case 'Text':
            s = size>0 ?  util.format('VARCHAR(%s)', size) : 'VARCHAR(512)';
            break;
        case 'Note':
            s = size>0 ?  util.format('VARCHAR(%s)', size) : 'CLOB';
            break;
        case 'Image':
        case 'Binary':
            s = size > 0 ? util.format('BLOB(%s)', size) : 'BLOB';
            break;
        case 'Guid':
            s = 'VARCHAR(36)';
            break;
        case 'Short':
            s = 'SMALLINT';
            break;
        default:
            s = 'INTEGER';
            break;
    }
    s += typeof (field.nullable=== 'undefined') ? ' null': (field.nullable==true || field.nullable == 1) ? ' NULL': ' NOT NULL';
    return s;
};
/**
 * @param {string} name
 * @param {QueryExpression} query
 * @param {function(Error=)} callback
 */
H2Adapter.prototype.createView = function(name, query, callback) {
    this.view(name).create(query, callback);
};

/**
 *
 * @param  {DataModelMigration|*} obj - An Object that represents the data model scheme we want to migrate
 * @param {function(Error=,*=)} callback
 */
H2Adapter.prototype.migrate = function(obj, callback) {
    if (obj==null)
        return;
    var self = this;
    var migration = obj;
    if (migration.appliesTo==null)
        throw new Error("Model name is undefined");
    self.open(function(err) {
        if (err) {
            callback.call(self, err);
        }
        else {
            var db = self.rawConnection;
            async.waterfall([
                //1. Check migrations table existence
                function(cb) {
                    self.table('migrations').exists(function(err, exists) {
                        if (err) { return cb(err); }
                        cb(null, exists);
                    });
                },
                //2. Create migrations table if not exists
                function(arg, cb) {
                    if (arg>0) { return cb(null, 0); }
                    self.table('migrations').create([
                        { name:'id', type:'Counter', primary:true, nullable:false  },
                        { name:'appliesTo', type:'Text', size:'80', nullable:false  },
                        { name:'model', type:'Text', size:'120', nullable:true  },
                        { name:'description', type:'Text', size:'512', nullable:true  },
                        { name:'version', type:'Text', size:'40', nullable:false  }
                    ], function(err) {
                        if (err) { return cb(err); }
                        cb(null,0);
                    });
                },
                //3. Check if migration has already been applied
                function(arg, cb) {
                    self.execute('SELECT COUNT(*) AS "count" FROM "migrations" WHERE "appliesTo"=? and "version"=?',
                        [migration.appliesTo, migration.version], function(err, result) {
                            if (err) { return cb(err); }
                            cb(null, result[0].count);
                        });
                },
                //4a. Check table existence
                function(arg, cb) {
                    //migration has already been applied (set migration.updated=true)
                    if (arg>0) { obj['updated']=true; cb(null, -1); return; }
                    self.table(migration.appliesTo).exists(function(err, exists) {
                        if (err) { return cb(err); }
                        cb(null, exists);
                    });
                },
                //4b. Migrate target table (create or alter)
                function(arg, cb) {
                    //migration has already been applied
                    if (arg<0) { return cb(null, arg); }
                    if (arg==0) {
                        //create table
                        return self.table(migration.appliesTo).create(migration.add, function(err) {
                            if (err) { return cb(err); }
                            cb(null, 1);
                        });
                    }
                    //columns to be removed (unsupported)
                    if (util.isArray(migration.remove)) {
                        if (migration.remove.length>0) {
                            return cb(new Error('Data migration remove operation is not supported by this adapter.'));
                        }
                    }
                    //columns to be changed (unsupported)
                    if (util.isArray(migration.change)) {
                        if (migration.change.length>0) {
                            return cb(new Error('Data migration change operation is not supported by this adapter. Use add collection instead.'));
                        }
                    }
                    var column, newType, oldType;
                    if (util.isArray(migration.add)) {
                        //init change collection
                        migration.change = [];
                        //get table columns
                        self.table(migration.appliesTo).columns(function(err, columns) {
                            if (err) { return cb(err); }
                            for (var i = 0; i < migration.add.length; i++) {
                                var x = migration.add[i];
                                column = columns.find(function(y) { return (y.name===x.name); });
                                if (column) {
                                    //if column is primary key remove it from collection
                                    if (column.primary) {
                                        migration.add.splice(i, 1);
                                        i-=1;
                                    }
                                    else {
                                        //get new type
                                        newType = H2Adapter.format('%t', x);
                                        //get old type
                                        oldType = column.type1.replace(/\s+$/,'') + ((column.nullable==true || column.nullable == 1) ? ' NULL' : ' NOT NULL');
                                        //remove column from collection
                                        migration.add.splice(i, 1);
                                        i-=1;
                                        if (newType !== oldType) {
                                            //add column to alter collection
                                            migration.change.push(x);
                                        }
                                    }
                                }
                            }
                            //alter table
                            var targetTable = self.table(migration.appliesTo);
                            //add new columns (if any)
                            targetTable.add(migration.add, function(err) {
                                if (err) { return cb(err); }
                                //modify columns (if any)
                                targetTable.change(migration.change, function(err) {
                                    if (err) { return cb(err); }
                                    cb(null, 1);
                                });
                            });
                        });
                    }
                    else {
                        cb(new Error('Invalid migration data.'));
                    }
                },
                //Apply data model foreign keys
                function (arg, cb) {
                    if (arg<=0) { return cb(null, arg); }
                    if (migration.constraints) {
                        var tableForeignKeys = self.foreignKeys(migration.appliesTo);
                        //enumerate migration constraints
                        async.eachSeries(migration.constraints, function(constraint, constraintCallback) {
                            //if constraint is a foreign key constraint
                            if (constraint.type === 'foreignKey') {
                                //create table foreign key
                                return tableForeignKeys.create(constraint.foreignKeyField,
                                    constraint.primaryKeyTable,
                                    constraint.primaryKeyField,
                                    constraintCallback);
                            }
                            else {
                                //else do nothing
                                return constraintCallback();
                            }
                        }, function(err) {
                            //throw error
                            if (err) { return cb(err); }
                            //or return success flag
                            return cb(null, 1);
                        });
                    }
                    else {
                        //do nothing and exit
                        return cb(null, 1);
                    }
                },
                //Apply data model indexes
                function (arg, cb) {
                    if (arg<=0) { return cb(null, arg); }
                    if (migration.indexes) {
                        var tableIndexes = self.indexes(migration.appliesTo);
                        //enumerate migration constraints
                        async.eachSeries(migration.indexes, function(index, indexCallback) {
                            tableIndexes.create(index.name, index.columns, indexCallback);
                        }, function(err) {
                            //throw error
                            if (err) { return cb(err); }
                            //or return success flag
                            return cb(null, 1);
                        });
                    }
                    else {
                        //do nothing and exit
                        return cb(null, 1);
                    }
                }, function(arg, cb) {
                    if (arg>0) {
                        //log migration to database
                        self.execute('INSERT INTO "migrations" ("appliesTo","model","version","description") VALUES (?,?,?,?)', [migration.appliesTo,
                            migration.model,
                            migration.version,
                            migration.description ], function(err) {
                            if (err) { return cb(err); }
                            return cb(null, 1);
                        });
                    }
                    else
                        cb(null, arg);

                }
            ], function(err, result) {
                callback(err, result);
            });
        }
    });
};


H2Adapter.prototype.table = function(name) {
    var self = this;

    return {
        /**
         * @param {function(Error,Boolean=)} callback
         */
        exists:function(callback) {
            callback = callback || function() {};
            self.execute('SELECT COUNT(*) AS "count" FROM information_schema.TABLES WHERE TABLE_NAME=? AND TABLE_SCHEMA=?',
                [ name, 'PUBLIC' ], function(err, result) {
                    if (err) { return callback(err); }
                    callback(null, result[0].count);
                });
        },
        /**
         * @param {function(Error,string=)} callback
         */
        version:function(callback) {
            callback = callback || function() {};
            self.execute('SELECT MAX("version") AS "version" FROM "migrations" WHERE "appliesTo"=?',
                [name], function(err, result) {
                    if (err) { return callback(err); }
                    if (result.length==0)
                        callback(null, '0.0');
                    else
                        callback(null, result[0].version || '0.0');
                });
        },
        /**
         * @param {function(Error=,Array=)} callback
         */
        columns:function(callback) {
            callback = callback || function() {};
            self.execute('SELECT COLUMN_NAME AS "name", TYPE_NAME as "type",CHARACTER_MAXIMUM_LENGTH as "size", ' +
            'CASE WHEN IS_NULLABLE=\'YES\' THEN 1 ELSE 0 END AS "nullable", NUMERIC_PRECISION as "precision",' +
            'NUMERIC_SCALE as "scale" ,(SELECT COUNT(*) FROM information_schema.INDEXES WHERE TABLE_CATALOG="c".TABLE_CATALOG AND TABLE_SCHEMA="c".TABLE_SCHEMA AND TABLE_NAME="c".TABLE_NAME ' +
            'AND PRIMARY_KEY=true AND COLUMN_NAME="c".COLUMN_NAME) AS "primary" ,CONCAT(TYPE_NAME, (CASE WHEN "NULLABLE" = 0 THEN \' NOT NULL\' ELSE \'\' END)) ' +
            'AS "type1" FROM information_schema.COLUMNS AS "c" WHERE TABLE_NAME=? AND TABLE_SCHEMA=?',
                [ name, 'PUBLIC' ], function(err, result) {
                    if (err) { return callback(err); }
                    callback(null, result);
                });
        },
        /**
         * @param {{name:string,type:string,primary:boolean|number,nullable:boolean|number,size:number, scale:number,precision:number,oneToMany:boolean}[]|*} fields
         * @param callback
         */
        create: function(fields, callback) {
            callback = callback || function() {};
            fields = fields || [];
            if (!util.isArray(fields)) {
                return callback(new Error('Invalid argument type. Expected Array.'))
            }
            if (fields.length == 0) {
                return callback(new Error('Invalid argument. Fields collection cannot be empty.'))
            }
            var strFields = fields.filter(function(x) {
                return !x.oneToMany;
            }).map(
                function(x) {
                    return H2Adapter.format('"%f" %t', x);
                }).join(', ');
            //add primary key constraint
            var strPKFields = fields.filter(function(x) { return (x.primary == true || x.primary == 1); }).map(function(x) {
                return H2Adapter.format('"%f"', x);
            }).join(', ');
            if (strPKFields.length>0) {
                strFields += ', ' + util.format('PRIMARY KEY (%s)', strPKFields);
            }
            var sql = util.format('CREATE TABLE "%s" (%s)', name, strFields);
            self.execute(sql, null, function(err) {
                callback(err);
            });
        },
        /**
         * Alters the table by adding an array of fields
         * @param {{name:string,type:string,primary:boolean|number,nullable:boolean|number,size:number,oneToMany:boolean}[]|*} fields
         * @param callback
         */
        add:function(fields, callback) {
            callback = callback || function() {};
            callback = callback || function() {};
            fields = fields || [];
            if (!util.isArray(fields)) {
                //invalid argument exception
                return callback(new Error('Invalid argument type. Expected Array.'))
            }
            if (fields.length == 0) {
                //do nothing
                return callback();
            }
            var formatter = new H2Formatter();
            var strTable = formatter.escapeName(name);
            //generate SQL statement
            var sql = fields.map(function(x) {
                return H2Adapter.format('ALTER TABLE ' + strTable + ' ADD "%f" %t', x);
            }).join(';');
            self.execute(sql, [], function(err) {
                callback(err);
            });
        },
        /**
         * Alters the table by modifying an array of fields
         * @param {{name:string,type:string,primary:boolean|number,nullable:boolean|number,size:number,oneToMany:boolean}[]|*} fields
         * @param callback
         */
        change:function(fields, callback) {
            callback = callback || function() {};
            callback = callback || function() {};
            fields = fields || [];
            if (!util.isArray(fields)) {
                //invalid argument exception
                return callback(new Error('Invalid argument type. Expected Array.'))
            }
            if (fields.length == 0) {
                //do nothing
                return callback();
            }
            var formatter = new H2Formatter();
            var strTable = formatter.escapeName(name);
            //generate SQL statement
            var sql = fields.map(function(x) {
                return H2Adapter.format('ALTER TABLE ' + strTable + ' ALTER COLUMN "%f" %t', x);
            }).join(';');
            self.execute(sql, [], function(err) {
                callback(err);
            });
        }
    }
};


H2Adapter.prototype.view = function(name) {
    var self = this, owner, view;

    var matches = /(\w+)\.(\w+)/.exec(name);
    if (matches) {
        //get schema owner
        owner = matches[1];
        //get table name
        view = matches[2];
    }
    else {
        view = name;
    }
    return {
        /**
         * @param {function(Error,Boolean=)} callback
         */
        exists:function(callback) {
            var sql = 'SELECT COUNT(*) AS "count" FROM information_schema.TABLES WHERE TABLE_NAME=? AND TABLE_TYPE=\'VIEW\' AND TABLE_SCHEMA=?';
            self.execute(sql, [name, 'PUBLIC'], function(err, result) {
                if (err) { callback(err); return; }
                callback(null, (result[0].count>0));
            });
        },
        /**
         * @param {function(Error=)} callback
         */
        drop:function(callback) {
            callback = callback || function() {};
            self.open(function(err) {
                if (err) { return callback(err); }
                var sql = 'SELECT COUNT(*) AS "count" FROM information_schema.TABLES WHERE TABLE_NAME=? AND TABLE_TYPE=\'VIEW\' AND TABLE_SCHEMA=?';
                self.execute(sql, [name, 'PUBLIC'], function(err, result) {
                    if (err) { return callback(err); }
                    var exists = (result[0].count>0);
                    if (exists) {
                        var sql = util.format('DROP VIEW "%s"',name);
                        self.execute(sql, undefined, function(err) {
                            if (err) { callback(err); return; }
                            callback();
                        });
                    }
                    else {
                        callback();
                    }
                });
            });
        },
        /**
         * @param {QueryExpression|*} q
         * @param {function(Error=)} callback
         */
        create:function(q, callback) {
            var thisArg = this;
            self.executeInTransaction(function(tr) {
                thisArg.drop(function(err) {
                    if (err) { tr(err); return; }
                    try {
                        var sql = util.format('CREATE VIEW "%s" AS ',name);
                        var formatter = new H2Formatter();
                        sql += formatter.format(q);
                        self.execute(sql, [], tr);
                    }
                    catch(e) {
                        tr(e);
                    }
                });
            }, function(err) {
                callback(err);
            });

        }
    };
};

H2Adapter.prototype.indexes = function(table) {
  var self = this, formatter = new H2Formatter();
    return {
        list: function (callback) {
            self.execute('SELECT INDEX_NAME as "indexName", TABLE_NAME as "tableName", COLUMN_NAME as "columnName" FROM "INFORMATION_SCHEMA".INDEXES ' +
                'WHERE TABLE_NAME=? AND TABLE_SCHEMA=? AND INDEX_TYPE_NAME=\'INDEX\'', [ table, 'PUBLIC'] , function (err, result) {
                if (err) { return callback(err); }
                var indexes = [];
                result.forEach(function(x) {
                   var ix = indexes.find(function(y) {
                      return y.name === x.indexName;
                   });
                    if (ix) {
                        ix.columns.push(x.columnName);
                    }
                    else {
                        indexes.push({
                            name:x.indexName,
                            columns: [ x.columnName ]
                        })
                    }
                });
                return callback(null, indexes);
            });
        },
        /**
         * @param {string} name
         * @param {Array|string} columns
         * @param {Function} callback
         */
        create: function(name, columns, callback) {
            var cols = [];
            if (typeof columns === 'string') {
                cols.push(columns)
            }
            else if (util.isArray(columns)) {
                cols.push.apply(cols, columns);
            }
            else {
                return callback(new Error("Invalid parameter. Columns parameter must be a string or an array of strings."));
            }

            this.list(function(err, indexes) {
               if (err) { return callback(err); }
               var ix = indexes.find(function(x) { return x.name === name; });
                //format create index SQL statement
                var sqlCreateIndex = util.format("CREATE INDEX %s ON %s(%s)",
                    formatter.escapeName(name),
                    formatter.escapeName(table),
                    cols.map(function(x) {
                        return formatter.escapeName(x)
                    }).join(","));
                if (typeof ix === 'undefined' || ix == null) {
                    self.execute(sqlCreateIndex, [], callback);
                }
                else {
                    var nCols = cols.length;
                    //enumerate existing columns
                    ix.columns.forEach(function(x) {
                        if (cols.indexOf(x)>=0) {
                            //column exists in index
                            nCols -= 1;
                        }
                    });
                    if (nCols>0) {
                        //drop index
                        this.drop(name, function(err) {
                           if (err) { return callback(err); }
                           //and create it
                            self.execute(sqlCreateIndex, [], callback);
                        });
                    }
                    else {
                        //do nothing
                        return callback();
                    }
                }
            });


        },
        drop: function(name, callback) {
            if (typeof name !== 'string') {
                return callback(new Error("Name must be a valid string."))
            }
            self.execute('SELECT COUNT(*) as "count" FROM "INFORMATION_SCHEMA".INDEXES WHERE  TABLE_NAME=? AND TABLE_SCHEMA=? AND INDEX_NAME=?', [ table, 'PUBLIC', name ], function(err, result) {
                if (err) { return callback(err); }
                var exists = (result.length>0) && (result[0].count>0);
                if (!exists) {
                    return callback();
                }
                self.execute(util.format("DROP INDEX %s", self.escapeName(name)), [], callback);
            });
        }
    }
};

H2Adapter.prototype.foreignKeys = function(table) {
  var self = this;
    return {
        /**
         * Gets the collection of the foreign keys associated with the given table
         * @param callback
         */
        list:function (callback) {
            self.execute('SELECT FK_NAME as "foreignKeyName" ,PKTABLE_NAME as "primaryKeyTable",PKCOLUMN_NAME as "primaryKeyColumn", ' +
                'FKTABLE_NAME as "foreignKeyTable",FKCOLUMN_NAME as "foreignKeyColumn" ' +
                'FROM "INFORMATION_SCHEMA".CROSS_REFERENCES WHERE FKTABLE_NAME=? AND FKTABLE_SCHEMA=?', [ table, "PUBLIC" ], function(err, result) {
                if (err) {
                    return callback(err);
                }
                return callback(null, result);
            });
        },
        /**
         * Creates a foreign key association between two tables
         * @param {string} foreignKeyColumn
         * @param {string} primaryKeyTable
         * @param {string} primaryKeyColumn
         * @param {Function} callback
         */
        create:function(foreignKeyColumn, primaryKeyTable, primaryKeyColumn, callback) {
            self.execute('SELECT COUNT(*) as "count" FROM "INFORMATION_SCHEMA".CROSS_REFERENCES ' +
                'WHERE FKTABLE_NAME=? AND FKTABLE_SCHEMA=? AND FKCOLUMN_NAME=? AND PKTABLE_NAME=? AND PKCOLUMN_NAME=?',
                [ table, "PUBLIC", foreignKeyColumn, primaryKeyTable, primaryKeyColumn ], function(err, result) {
                if (err) {
                    return callback(err);
                }
                //if foreign key already exists
                if (result[0] && result[0].count>0) {
                    return callback();
                }
                var sql = util.format('ALTER TABLE "%s" ADD FOREIGN KEY ("%s") REFERENCES "%s"("%s")', table, foreignKeyColumn, primaryKeyTable, primaryKeyColumn);
                self.execute(sql, [], function(err) {
                    return callback(err);
                });
            });
        },
        /**
         * Drops a foreign key association between two tables
         * @param {string} foreignKeyColumn
         * @param {string} primaryKeyTable
         * @param {string} primaryKeyColumn
         * @param {Function} callback
         */
        drop:function(foreignKeyColumn, primaryKeyTable, primaryKeyColumn, callback) {
            self.execute('SELECT FK_NAME as "foreignKeyName" FROM "INFORMATION_SCHEMA".CROSS_REFERENCES ' +
                'WHERE FKTABLE_NAME=? AND FKTABLE_SCHEMA=? AND FKCOLUMN_NAME=? AND PKTABLE_NAME=? AND PKCOLUMN_NAME=?',
                [ table, "PUBLIC", foreignKeyColumn, primaryKeyTable, primaryKeyColumn ], function(err, result) {
                    if (err) {
                        return callback(err);
                    }
                    if (result[0]) {
                        var sql = util.format('ALTER TABLE "%s" DROP CONSTRAINT "%s";', table, result[0].foreignKeyName);
                        self.execute(sql, [], function(err) {
                            return callback(err);
                        });
                    }
                    else {
                        return callback();
                    }
                });
        }
    }
};

function zeroPad(number, length) {
    number = number || 0;
    var res = number.toString();
    while (res.length < length) {
        res = '0' + res;
    }
    return res;
}

/**
 * @class H2Formatter
 * @constructor
 * @augments {SqlFormatter}
 */
function H2Formatter() {
    this.settings = {
        nameFormat:H2Formatter.NAME_FORMAT,
        forceAlias:true
    }
}
util.inherits(H2Formatter, qry.classes.SqlFormatter);

H2Formatter.NAME_FORMAT = '"$1"';

H2Formatter.prototype.escapeName = function(name) {
    if (typeof name === 'string') {
        if (/^(\w+)\.(\w+)$/g.test(name)) {
            return name.replace(/(\w+)/g, H2Formatter.NAME_FORMAT);
        }
        return name.replace(/(\w+)$|^(\w+)$/g, H2Formatter.NAME_FORMAT);
    }
    return name;
};

H2Formatter.prototype.escape = function(value,unquoted)
{
    if (value==null || typeof value==='undefined')
        return qry.escape(null);

    if(typeof value==='string') {
        if (unquoted) {
            return value.replace(/'/g, "''");
        }
        return '\'' + value.replace(/'/g, "''") + '\'';
    }

    if (typeof value==='boolean')
        return value ? 1 : 0;
    if (typeof value === 'object')
    {
        if (value instanceof Date)
            return this.escapeDate(value);
        if (value.hasOwnProperty('$name'))
            return this.escapeName(value.$name);
    }
    if (unquoted)
        return value.valueOf();
    else
        return qry.escape(value);
};

/**
 * @param {Date|*} val
 * @returns {string}
 */
H2Formatter.prototype.escapeDate = function(val) {
    /*
    Important Note
    H2 database engine uses server timezone while inserting date values.
    
    Tip #1: convert date to GMT: new Date(val.valueOf() + val.getTimezoneOffset() * 60000); 
    */
    var year   = val.getFullYear();
    var month  = zeroPad(val.getMonth() + 1, 2);
    var day    = zeroPad(val.getDate(), 2);
    var hour   = zeroPad(val.getHours(), 2);
    var minute = zeroPad(val.getMinutes(), 2);
    var second = zeroPad(val.getSeconds(), 2);
    var datetime = year + '-' + month + '-' + day + ' ' + hour + ':' + minute + ':' + second;
    var offset = val.getTimezoneOffset(), 
        timezone = (offset<=0 ? '+' : '-') + zeroPad(-Math.floor(offset/60),2) + ':' + zeroPad(offset%60,2);
    return "'" + datetime.concat(timezone) + "'";
};

/**
 * Implements length(a) expression formatter.
 * @param {*} p0
 * @returns {string}
 */
H2Formatter.prototype.$length = function(p0)
{
    return util.format('LENGTH(%s)', this.escape(p0));
};

H2Formatter.prototype.$day = function(p0) {
    return util.format('DAY_OF_MONTH(%s)', this.escape(p0));
};

H2Formatter.prototype.$date = function(p0) {
    return util.format('CAST(%s AS DATE)', this.escape(p0));
};

H2Formatter.prototype.$mod = function(p0, p1)
{
    //validate params
    if (Object.isNullOrUndefined(p0) || Object.isNullOrUndefined(p1))
        return '0';
    return util.format('MOD(%s,%s)', this.escape(p0), this.escape(p1));
};

H2Formatter.prototype.$bit = function(p0, p1)
{
    //validate params
    if (Object.isNullOrUndefined(p0) || Object.isNullOrUndefined(p1))
        return '0';
    return util.format('BITAND(%s,%s)', this.escape(p0), this.escape(p1));
}

if (typeof exports !== 'undefined')
{
    module.exports = {
        H2Formatter : H2Formatter,
        H2Adapter : H2Adapter,
        /**
         * Creates an instance of H2Adapter object that represents a MySql database connection.
         * @param options An object that represents the properties of the underlying database connection.
         * @returns {DataAdapter}
         */
        createInstance: function(options) {
            return new H2Adapter(options);
        }

    }
}