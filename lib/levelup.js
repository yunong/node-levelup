/* Copyright (c) 2012-2013 LevelUP contributors
 * See list at <https://github.com/rvagg/node-levelup#contributing>
 * MIT +no-false-attribs License
 * <https://github.com/rvagg/node-levelup/blob/master/LICENSE>
 */

var EventEmitter   = require('events').EventEmitter
  , inherits       = require('util').inherits
  , extend         = require('xtend')
  , prr            = require('prr')

  , dtrace         = require('./dtrace')
  , errors         = require('./errors')
  , readStream     = require('./read-stream')
  , writeStream    = require('./write-stream')
  , util           = require('./util')

  , getOptions     = util.getOptions
  , defaultOptions = util.defaultOptions
  , getLevelDOWN   = util.getLevelDOWN


  , createLevelUP = function (location, options, callback) {

      // Possible status values:
      //  - 'new'     - newly created, not opened or closed
      //  - 'opening' - waiting for the database to be opened, post open()
      //  - 'open'    - successfully opened the database, available for use
      //  - 'closing' - waiting for the database to be closed, post close()
      //  - 'closed'  - database has been successfully closed, should not be
      //                 used except for another open() operation

      var status = 'new'
        , error
        , levelup

        , isOpen        = function () { return status == 'open' }
        , isOpening     = function () { return status == 'opening' }

        , dispatchError = function (error, callback) {
            return typeof callback == 'function'
              ? callback(error)
              : levelup.emit('error', error)
          }

        , getCallback = function (options, callback) {
            return typeof options == 'function' ? options : callback
          }

        , deferred = [ 'get', 'put', 'batch', 'del', 'approximateSize' ]
            .reduce(function (o, method) {
              o[method] = function () {
                var args = Array.prototype.slice.call(arguments)
                levelup.once('ready', function () {
                  levelup.db[method].apply(levelup.db, args)
                })
              }
              return o
            }, {})

      if (typeof options == 'function') {
        callback = options
        options  = {}
      }

      options = getOptions(levelup, options)

      if (typeof location != 'string') {
        error = new errors.InitializationError(
            'Must provide a location for the database')
        if (callback)
          return callback(error)
        throw error
      }

      function LevelUP (location, options) {
        EventEmitter.call(this)
        this.setMaxListeners(Infinity)

        this.options = extend(defaultOptions, options)
        // set this.location as enumerable but not configurable or writable
        prr(this, 'location', location, 'e')
      }

      inherits(LevelUP, EventEmitter)

      LevelUP.prototype.open = function (callback) {
        dtrace._levelup_probes['open-start'].fire(function () { return ([]) })
        var self = this
          , dbFactory
          , db

        if (isOpen()) {
          if (callback) {
            process.nextTick(function () { callback(null, self) })
          }
          dtrace._levelup_probes['open-done'].fire(function () { return ([]) })
          return self
        }

        if (isOpening()) {
          dtrace._levelup_probes['open-done'].fire(function () { return ([]) })
          return callback && levelup.once(
              'open'
            , function () { callback(null, self) }
          )
        }

        levelup.emit('opening')

        status = 'opening'
        self.db = deferred

        dbFactory = levelup.options.db || getLevelDOWN()
        db        = dbFactory(levelup.location)

        db.open(levelup.options, function (err) {
          if (err) {
            err = new errors.OpenError(err)
            dtrace._levelup_probes['open-done'].fire(function () {
              return ([err.toString()])
            })
            return dispatchError(err, callback)
          } else {
            levelup.db = db
            status = 'open'
            if (callback)
              callback(null, levelup)
            levelup.emit('open')
            levelup.emit('ready')
            dtrace._levelup_probes['open-done'].fire(function () {
              return ([])
            })
          }
        })
      }

      LevelUP.prototype.close = function (callback) {
        dtrace._levelup_probes['close-start'].fire(function () { return ([]) })
        if (isOpen()) {
          status = 'closing'
          this.db.close(function () {
            status = 'closed'
            levelup.emit('closed')
            if (callback)
              callback.apply(null, arguments)
            dtrace._levelup_probes['close-done'].fire(function () {
              return ([])
            })
          })
          levelup.emit('closing')
          this.db = null
        } else if (status == 'closed' && callback) {
          callback()
          dtrace._levelup_probes['close-done'].fire(function () { return ([]) })
        } else if (status == 'closing' && callback) {
          levelup.once('closed', callback)
          dtrace._levelup_probes['close-done'].fire(function () { return ([]) })
        } else if (isOpening()) {
          levelup.once('open', function () {
            levelup.close(callback)
            dtrace._levelup_probes['close-done'].fire(function () {
              return ([])
            })
          })
        }
      }

      LevelUP.prototype.isOpen = function () { return isOpen() }

      LevelUP.prototype.isClosed = function () { return (/^clos/).test(status) }

      LevelUP.prototype.get = function (key_, options, callback) {
        dtrace._levelup_probes['get-start'].fire(function () {
          return ([key_, options])
        })
        var key
          , err

        callback = getCallback(options, callback)

        if (typeof callback != 'function') {
          err = new errors.ReadError('get() requires key and callback arguments')
          dtrace._levelup_probes['get-done'].fire(function () {
            return ([err.toString(), key_, null])
          })
          return dispatchError(err)
        }

        if (!isOpening() && !isOpen()) {
          err = new errors.ReadError('Database is not open')
          dtrace._levelup_probes['get-done'].fire(function () {
            return ([err.toString(), key_, null])
          })
          return dispatchError(err, callback)
        }

        options = util.getOptions(levelup, options)
        key = util.encodeKey(key_, options)

        options.asBuffer = util.isValueAsBuffer(options)

        this.db.get(key, options, function (err, value) {
          if (err) {
            if ((/notfound/i).test(err)) {
              err = new errors.NotFoundError(
                  'Key not found in database [' + key_ + ']', err)
            } else {
              err = new errors.ReadError(err)
            }
            dtrace._levelup_probes['get-done'].fire(function () {
              return ([err.toString(), key_, value])
            })
            return dispatchError(err, callback)
          }
          if (callback) {
            try {
              value = util.decodeValue(value, options)
            } catch (e) {
              dtrace._levelup_probes['get-done'].fire(function () {
                return ([e.toString(), key_, value])
              })
              return callback(new errors.EncodingError(e))
            }
            dtrace._levelup_probes['get-done'].fire(function () {
              return ([null, key_, value])
            })
            callback(null, value)
          }
        })
      }

      LevelUP.prototype.put = function (key_, value_, options, callback) {
        dtrace._levelup_probes['put-start'].fire(function () {
          return ([key_, value_, options])
        })
        var err
          , key
          , value

        callback = getCallback(options, callback)

        if (key_ === null || key_ === undefined
              || value_ === null || value_ === undefined) {
          err = new errors.WriteError('put() requires key and value arguments')
          dtrace._levelup_probes['put-done'].fire(function () {
            return ([err.toString(), key_, value_, options])
          })
          return dispatchError(err, callback)
        }

        if (!isOpening() && !isOpen()) {
          err = new errors.WriteError('Database is not open')
          dtrace._levelup_probes['put-done'].fire(function () {
            return ([err.toString(), key_, value_, options])
          })
          return dispatchError(err, callback)
        }

        options = getOptions(levelup, options)
        key     = util.encodeKey(key_, options)
        value   = util.encodeValue(value_, options)

        this.db.put(key, value, options, function (err) {
          if (err) {
            err = new errors.WriteError(err)
            dtrace._levelup_probes['put-done'].fire(function () {
              return ([err.toString(), key_, value_, options])
            })
            return dispatchError(err, callback)
          } else {
            levelup.emit('put', key_, value_)
            if (callback)
              callback()
            dtrace._levelup_probes['put-done'].fire(function () {
              return ([null, key_, value_, options])
            })
          }
        })
      }

      LevelUP.prototype.del = function (key_, options, callback) {
        dtrace._levelup_probes['del-start'].fire(function () {
          return ([key_, options])
        })
        var err
          , key

        callback = getCallback(options, callback)

        if (key_ === null || key_ === undefined) {
          err = new errors.WriteError('del() requires a key argument')
          dtrace._levelup_probes['del-done'].fire(function () {
            return ([err.toString(), key_, options])
          })
          return dispatchError(err, callback)
        }

        if (!isOpening() && !isOpen()) {
          err = new errors.WriteError('Database is not open')
          dtrace._levelup_probes['del-done'].fire(function () {
            return ([err.toString(), key_, options])
          })
          return dispatchError(err, callback)
        }

        options = getOptions(levelup, options)
        key     = util.encodeKey(key_, options)

        this.db.del(key, options, function (err) {
          if (err) {
            err = new errors.WriteError(err)
            dtrace._levelup_probes['del-done'].fire(function () {
              return ([err.toString(), key_, options])
            })
            return dispatchError(err, callback)
          } else {
            levelup.emit('del', key_)
            if (callback)
              callback()
            dtrace._levelup_probes['del-done'].fire(function () {
              return ([null, key_, options])
            })
          }
        })
      }

      function Batch (db) {
        this.batch = db.batch()
        this.ops = []
      }

      Batch.prototype.put = function (key_, value_, options) {
        dtrace._levelup_probes['batchput-start'].fire(function () {
          return ([key_, value_, options])
        })
        options = getOptions(levelup, options)

        var key   = util.encodeKey(key_, options)
          , value = util.encodeValue(value_, options)

        try {
          this.batch.put(key, value)
        } catch (e) {
          dtrace._levelup_probes['batchput-done'].fire(function () {
            return ([e.toString(), key_, value_, options])
          })
          throw new errors.WriteError(e)
        }
        this.ops.push({ type : 'put', key : key, value : value })

        dtrace._levelup_probes['batchput-done'].fire(function () {
          return ([null, key_, value_, options])
        })

        return this
      }

      Batch.prototype.del = function (key_, options) {
        dtrace._levelup_probes['batchdel-start'].fire(function () {
          return ([key_, options])
        })
        options = getOptions(levelup, options)
        var key     = util.encodeKey(key_, options)

        try {
          this.batch.del(key)
        } catch (err) {
          dtrace._levelup_probes['batchdel-done'].fire(function () {
            return ([err.toString(), key_, options])
          })
          throw new errors.WriteError(err)
        }
        this.ops.push({ type : 'del', key : key })

        dtrace._levelup_probes['batchdel-done'].fire(function () {
          return ([null, key_, options])
        })

        return this
      }

      Batch.prototype.clear = function () {
        dtrace._levelup_probes['batchclear-start'].fire(function () {
          return ([])
        })
        try {
          this.batch.clear()
        } catch (err) {
          dtrace._levelup_probes['batchclear-done'].fire(function () {
            return ([err.toString()])
          })
          throw new errors.WriteError(err)
        }

        this.ops = []
        dtrace._levelup_probes['batchclear-done'].fire(function () {
          return ([])
        })
        return this
      }

      Batch.prototype.write = function (callback) {
        var ops = this.ops
        dtrace._levelup_probes['batchwrite-start'].fire(function() {
          return ([ops])
        })
        try {
          this.batch.write(function (err) {
            if (err) {
              dtrace._levelup_probes['batchwrite-done'].fire(function() {
                return ([err.toString(), ops])
              })
              return dispatchError(new errors.WriteError(err), callback)
            }
            levelup.emit('batch', ops)
            dtrace._levelup_probes['batchwrite-done'].fire(function() {
              return ([null, ops])
            })
            if (callback)
              callback()
          })
        } catch (err) {
          dtrace._levelup_probes['batchwrite-done'].fire(function() {
            return ([err.toString(), ops])
          })
          throw new errors.WriteError(err)
        }
      }

      LevelUP.prototype.batch = function (arr_, options, callback) {
        dtrace._levelup_probes['batchnew-start'].fire(function () {
          return ([arr_, options])
        })
        var keyEnc
          , valueEnc
          , err
          , arr

        if (!arguments.length) {
          dtrace._levelup_probes['batchnew-done'].fire(function () {
            return ([null, arr_, options])
          })
          return new Batch(this.db)
        }

        callback = getCallback(options, callback)

        if (!Array.isArray(arr_)) {
          err = new errors.WriteError('batch() requires an array argument')
          dtrace._levelup_probes['batchnew-done'].fire(function () {
            return ([err.toString(), arr_, options])
          })
          return dispatchError(err, callback)
        }

        if (!isOpening() && !isOpen()) {
          err = new errors.WriteError('Database is not open')
          dtrace._levelup_probes['batchnew-done'].fire(function () {
            return ([err.toString(), arr_, options])
          })
          return dispatchError(err, callback)
        }

        options  = getOptions(levelup, options)
        keyEnc   = options.keyEncoding
        valueEnc = options.valueEncoding

        arr = arr_.map(function (e) {
          if (e.type === undefined || e.key === undefined) {
            return {}
          }

          // inherit encoding
          var kEnc = e.keyEncoding || keyEnc
            , vEnc = e.valueEncoding || e.encoding || valueEnc
            , o

          // If we're not dealing with plain utf8 strings or plain
          // Buffers then we have to do some work on the array to
          // encode the keys and/or values. This includes JSON types.

          if (kEnc != 'utf8' && kEnc != 'binary'
              || vEnc != 'utf8' && vEnc != 'binary') {
            o = {
                type: e.type
              , key: util.encodeKey(e.key, options, e)
            }

            if (e.value !== undefined)
              o.value = util.encodeValue(e.value, options, e)

            return o
          } else {
            return e
          }
        })

        this.db.batch(arr, options, function (err) {
          if (err) {
            err = new errors.WriteError(err)
            dtrace._levelup_probes['batchnew-done'].fire(function () {
              return ([err.toString(), arr_, options])
            })
            return dispatchError(err, callback)
          } else {
            levelup.emit('batch', arr_)
            if (callback)
              callback()
            dtrace._levelup_probes['batchnew-done'].fire(function () {
              return ([null, arr_, options])
            })
          }
        })
      }

      // DEPRECATED: prefer accessing LevelDOWN for this: db.db.approximateSize()
      LevelUP.prototype.approximateSize = function (start_, end_, callback) {
        var err
          , start
          , end

        if (start_ === null || start_ === undefined
              || end_ === null || end_ === undefined
              || typeof callback != 'function') {
          err = new errors.ReadError('approximateSize() requires start, end and callback arguments')
          return dispatchError(err, callback)
        }

        start = util.encodeKey(start_, options)
        end   = util.encodeKey(end_, options)

        if (!isOpening() && !isOpen()) {
          err = new errors.WriteError('Database is not open')
          return dispatchError(err, callback)
        }

        this.db.approximateSize(start, end, function (err, size) {
          if (err) {
            err = new errors.OpenError(err)
            return dispatchError(err, callback)
          } else if (callback)
            callback(null, size)
        })
      }

      LevelUP.prototype.readStream =
      LevelUP.prototype.createReadStream = function (options) {
        options = extend(this.options, options)
        return readStream.create(
            options
          , this
          , function (options) {
              return levelup.db.iterator(options)
            }
        )
      }

      LevelUP.prototype.keyStream =
      LevelUP.prototype.createKeyStream = function (options) {
        return this.readStream(extend(options, { keys: true, values: false }))
      }

      LevelUP.prototype.valueStream =
      LevelUP.prototype.createValueStream = function (options) {
        return this.readStream(extend(options, { keys: false, values: true }))
      }

      LevelUP.prototype.writeStream =
      LevelUP.prototype.createWriteStream = function (options) {
        return writeStream.create(extend(options), this)
      }

      LevelUP.prototype.toString = function () {
        return 'LevelUP'
      }

      levelup = new LevelUP(location, options)
      levelup.open(callback)
      return levelup
    }

  , utilStatic = function (name) {
      return function (location, callback) {
        getLevelDOWN()[name](location, callback || function () {})
      }
    }

module.exports         = createLevelUP
module.exports.copy    = util.copy
// DEPRECATED: prefer accessing LevelDOWN for this: require('leveldown').destroy()
module.exports.destroy = utilStatic('destroy')
// DEPRECATED: prefer accessing LevelDOWN for this: require('leveldown').repair()
module.exports.repair  = utilStatic('repair')
