var f = require('util').format
  , Long = require('bson').Long;

// Incrementing request id
var _requestId = 0;

// Wire command operation ids
var OP_QUERY = 2004;
var OP_GETMORE = 2005;

// Query flags
var OPTS_NONE = 0;
var OPTS_TAILABLE_CURSOR = 2;
var OPTS_SLAVE = 4;
var OPTS_OPLOG_REPLAY = 8;
var OPTS_NO_CURSOR_TIMEOUT = 16;
var OPTS_AWAIT_DATA = 32;
var OPTS_EXHAUST = 64;
var OPTS_PARTIAL = 128;

// Response flags
var CURSOR_NOT_FOUND = 0;
var QUERY_FAILURE = 2;
var SHARD_CONFIG_STALE = 4;
var AWAIT_CAPABLE = 8;

// Set property function
var setProperty = function(obj, prop, flag, values) {
  Object.defineProperty(obj, prop.name, {
      set: function(value) {
        if(typeof value != 'boolean') throw new Error(f("%s required a boolean", prop.name));
        if(value) values.flags |= values.flag;
        if(!value) values.flags ^= values.flag;
        prop.value = value;
      }
    , get: function() { return prop.value; }
  });
}

// Set property function
var getProperty = function(obj, propName, fieldName, values, func) {
  Object.defineProperty(obj, propName, {
    get: function() { 
      // Not parsed yet, parse it
      if(!obj.isParsed()) {
        obj.parse();
      }

      // Do we have a post processing function
      if(typeof func == 'function') return func(values[fieldName]);
      // Return raw value
      return values[fieldName];
    }
  });
}

//
// Query message
var Query = function(bson, ns, query, options) {
  // Basic options needed to be passed in
  if(ns == null) throw new Error("ns must be specified for query");
  if(query == null) throw new Error("query must be specified for query");

  // Validate that we are not passing 0x00 in the colletion name
  if(!!~ns.indexOf("\x00")) {
    throw new Error("namespace cannot contain a null character");
  }

  // Ensure empty options
  options = options || {};

  // Additional options
  var numberToSkip = options.numberToSkip || 0;
  var numberToReturn = options.numberToReturn || 0;
  var returnFieldSelector = options.returnFieldSelector || null;  
  var requestId = _requestId++;

  // Serialization option
  var serializeFunctions = options.serializeFunctions || false;
  var maxBsonSize = options.maxBsonSize || 1024 * 1024 * 16;
  var checkKeys = options.checkKeys || true;

  // Properties
  var tailable = {name: 'tailable', value: 0};
  var slave = {name: 'slave', value: 0};
  var oplogReply = {name: 'oplogReply', value: 0};
  var noCursorTimeout = {name: 'noCursorTimeout', value: 0};
  var awaitData = {name: 'awaitData', value: 0};
  var exhaust = {name: 'exhaust', value: 0};
  var partial = {name: 'partial', value: 0};

  // Set the flags
  var values = {
    flags: 0
  }
  
  // Setup properties
  setProperty(this, tailable, OPTS_TAILABLE_CURSOR, values);
  setProperty(this, slave, OPTS_SLAVE, values);
  setProperty(this, oplogReply, OPTS_OPLOG_REPLAY, values);
  setProperty(this, noCursorTimeout, OPTS_NO_CURSOR_TIMEOUT, values);
  setProperty(this, awaitData, OPTS_AWAIT_DATA, values);
  setProperty(this, exhaust, OPTS_EXHAUST, values);
  setProperty(this, partial, OPTS_PARTIAL, values);

  // To Binary
  this.toBin = function() {
    // Basic length
    var length = 4 
      + Buffer.byteLength(ns) 
      + 1 + 4 + 4 
      + bson.calculateObjectSize(query, serializeFunctions, true) 
      + (4 * 4);

    // Additional size for field selection
    if(returnFieldSelector && Object.keys(returnFieldSelector).length > 0) {
      length += bson.calculateObjectSize(returnFieldSelector, serializeFunctions, true);
    }

    // Validate BSON size
    if(length > maxBsonSize) {
      throw new Error(f("command exceeds maximum bson size [%s > %s]", maxBsonSize, length));
    }

    // Create command buffer
    var buffer = new Buffer(length);
    var index = 0;
    
    // Write header information
    index = write32bit(index, buffer, length);
    index = write32bit(index, buffer, requestId);
    index = write32bit(index, buffer, 0);
    index = write32bit(index, buffer, OP_QUERY);
    index = write32bit(index, buffer, values.flags);

    // Write collection name
    index = index + buffer.write(ns, index, 'utf8') + 1;
    buffer[index - 1] = 0;

    // Write rest of fields
    index = write32bit(index, buffer, numberToSkip);
    index = write32bit(index, buffer, numberToReturn);

    // Serialize query
    var queryLength = bson.serializeWithBufferAndIndex(query
      , checkKeys
      , buffer, index
      , serializeFunctions) - index + 1;

    // Write document into buffer
    index = write32bit(index, buffer, queryLength);
    index = index - 4 + queryLength;
    buffer[index + 1] = 0x00;
    
    // If we have field selectors
    if(returnFieldSelector && Object.keys(returnFieldSelector).length > 0) {
      var fieldSelectorLength = bson.serializeWithBufferAndIndex(returnFieldSelector
        , checkKeys
        , buffer
        , index
        , serializeFunctions) - index + 1;
      index = write32bit(index, buffer, fieldSelectorLength);
      index = index - 4 + fieldSelectorLength;
      buffer[index + 1] = 0x00;
    }

    // Return buffer
    return buffer;
  }

  var write32bit = function(index, buffer, value) {
    buffer[index + 3] = (value >> 24) & 0xff;
    buffer[index + 2] = (value >> 16) & 0xff;
    buffer[index + 1] = (value >> 8) & 0xff;
    buffer[index] = (value) & 0xff;
    return index + 4;
  }
}

var GetMore = function() {  
}

var Response = function(bson, data, opts) {
  opts = opts || {promoteLongs: true};
  var parsed = false;
  var values = {
    documents: []
  }

  // Set error properties
  getProperty(this, 'cursorNotFound', 'responseFlags', values, function(value) {
    return (value & CURSOR_NOT_FOUND) != 0;
  });

  getProperty(this, 'queryFailure', 'responseFlags', values, function(value) {
    return (value & QUERY_FAILURE) != 0;
  });

  getProperty(this, 'shardConfigStale', 'responseFlags', values, function(value) {
    return (value & SHARD_CONFIG_STALE) != 0;
  });

  getProperty(this, 'awaitCapable', 'responseFlags', values, function(value) {
    return (value & AWAIT_CAPABLE) != 0;
  });

  // Set standard properties
  getProperty(this, 'length', 'length', values);
  getProperty(this, 'requestId', 'requestId', values);
  getProperty(this, 'responseTo', 'responseTo', values);
  getProperty(this, 'responseFlags', 'responseFlags', values);
  getProperty(this, 'cursorId', 'cursorId', values);
  getProperty(this, 'startingFrom', 'startingFrom', values);
  getProperty(this, 'numberReturned', 'numberReturned', values);
  getProperty(this, 'documents', 'documents', values);

  this.isParsed = function() {
    return parsed;
  }

  this.parse = function(options) {
    // Don't parse again if not needed
    if(parsed) return;
    options = options || {};
    // Allow the return of raw documents instead of parsing
    var raw = options.raw || false;

    //
    // Parse Header
    //
    var index = 0;
    // Read the message length
    values.length = data.readUInt32LE(index);
    index = index + 4;
    // Fetch the request id for this reply
    values.requestId = data.readUInt32LE(index);
    index = index + 4;
    // Fetch the id of the request that triggered the response
    values.responseTo = data.readUInt32LE(index);
    // Skip op-code field
    index = index + 4 + 4;
    // Unpack flags
    values.responseFlags = data.readUInt32LE(index);
    index = index + 4; 
    // Unpack the cursor
    var lowBits = data.readUInt32LE(index);
    index = index + 4; 
    var highBits = data.readUInt32LE(index);
    index = index + 4; 
    // Create long object
    values.cursorId = new Long(lowBits, highBits);
    // Unpack the starting from
    values.startingFrom = data.readUInt32LE(index);
    index = index + 4; 
    // Unpack the number of objects returned
    values.numberReturned = data.readUInt32LE(index);
    index = index + 4; 

    // Parse options
    var _options = {promoteLongs: opts.promoteLongs};

    //
    // Parse Body
    //
    for(var i = 0; i < values.numberReturned; i++) {
      var bsonSize = data.readUInt32LE(index);

      // If we have raw results specified slice the return document
      if(raw) {
        values.documents.push(data.slice(index, index + bsonSize));
      } else {
        values.documents.push(bson.deserialize(data.slice(index, index + bsonSize), _options));
      }

      // Adjust the index
      index = index + bsonSize;
    }

    // Set parsed
    parsed = true;
  }
}

module.exports = {
    Query: Query
  , GetMore: GetMore
  , Response: Response
}