var resource = require('resource'),
    twitter = resource.define('twitter');

twitter.schema.description = "for interacting with the Twitter API";

twitter.property('credentials', {
  description: 'credentials for logging into twitter',
  properties: {
    type: 'object',
    consumer_key: {
      type: 'string',
      required: true
    },
    consumer_secret: {
      type: 'string',
      required: true
    },
    access_token_key: {
      type: 'string',
      required: true
    },
    access_token_secret: {
      type: 'string',
      required: true
    }
  }
});

//
// A user may be specified either by twitter screenName, or by twitter's
// numerical id for the same user. At least some methods in ntwitter require
// this numerical id in leiu of the screenName.
//
twitter.property('user', {
  description: 'a twitter user',
  properties: {
    id: {
      required: false
    },
    screenName: {
      type: 'string',
      required: false
    }
  }
});

//
// Many methods require a specified user in addition to other properties
//
function withUser(schema) {
  schema.properties = schema.properties || {};
  schema.properties.user = twitter.schema.properties.user;
  return schema;
}

//
// We keep track of both screenNames and ids for users that have active
// authenticated client instances
//
// TODO: Consider cases where the specified user does not have a client.
// ntwitter should have a method for looking up numerical ids given a
// screenName.
//
function getUser(options) {
  var user = options.user || options,
      screenName, id;

  if (user.screenName) {
    screenName = user.screenName;
    id = twitter.screenNames[screenName];
  }
  else if (user.id) {
    id = user.id;
    screenName = twitter.ids[id];
  }

  return {
    screenName: screenName,
    id: id
  };
}

twitter.property('tweet', {
  description: 'a twitter tweet',
  properties: {
    message: {
      type: 'string',
      default: 'I am big.'
    },
  }
});

twitter.property('stream', {
  description: 'a twitter stream',
  properties: {
    method: { type: 'string', required: true },
    follow: { type: 'string', required: false },
    track: { type: 'string', required: false },
    locations: { type: 'string', required: false }
  }
});

//
// When a user connects, their credentials are verified, their screenName
// and id are mutually cross-referenced, and the client is namespaced under
// their screenName
//
// TODO: Consider caching username/id pairs for non-authenticated users
// to avoid making unnecessary API calls, as a separate abstraction from
// the connections lookup table
//
twitter.connections = {};
twitter.screenNames = {};
twitter.ids = {};

twitter.method('connect', connect, {
  description: 'connects to twitter',
  properties: {
    options: twitter.schema.properties.credentials,
    callback: {
      type: 'function',
      default: function () {}
    }
  }
});
function connect (options, callback) {
  var Twitter = require('ntwitter');

  var client = new Twitter(options);
  client.verifyCredentials(function (err, user) {
    if (err) {
      return callback(err);
    }

    user.screenName = user.screen_name;

    twitter.screenNames[user.screen_name] = user.id;
    twitter.ids[user.id] = user.screen_name;
    twitter.connections[user.screen_name] = {
      client: client,
      user: user,
      streams: options.streams || {}
    };

    //
    // Open any streams passed in as connection parameters
    //
    var closedStreams = Object.keys(options.streams || {}),
        i = closedStreams.length;

    if (i) {
      closedStreams.forEach(function (streamId) {
        var opts = options.streams[streamId].options;
        twitter.addStream(opts, function (err) {
          if (err) {
            return callback(err);
          }

          i--;
          if (i <= 0) {
            callback(null, user);
          }
        });
      })
    }
    else {
      callback(null, user);
    }
  });
};

twitter.method('disconnect', disconnect, {
  description: 'disconnects from twitter',
  properties: {
    options: withUser({
      type: 'object'
    }),
    callback: {
      type: 'function',
      default: function () {}
    }
  }
});
function disconnect (options, callback) {
  var user = getUser(options),
      screenName = user.screenName,
      id = user.id;

  //
  // Clean up any active streams
  //
  var openStreams = Object.keys(twitter.connections[screenName].streams),
      i = openStreams.length;

  if (i) {
    openStreams.forEach(function (streamId) {
      twitter.removeStream({
        user: {
          screenName: screenName
        },
        streamId: streamId
      }, function (err) {
        if (err) {
          return callback(err);
        }

        i--;
        if (i <= 0) {
          //
          // Clean up user from lookup tables
          //
          delete twitter.connections[screenName];
          delete twitter.screenNames[screenName];
          delete twitter.ids[id];

          callback(null, true);
        }
      });
    });
  }
  else {
    callback(null, true);
  }
}

twitter.method('addStream', addStream, {
  description: 'starts listening to a twitter stream',
  properties: {
    options: withUser({
      properties: {
        stream: twitter.schema.properties.stream
      }
    }),
    callback: {
      type: 'function',
      default: function (error, options, stream) {}
    }
  }
});
function addStream (options, callback) {
  var params = {},
      user = getUser(options),
      method = options.stream.method;

  Object.keys(options.stream).forEach(function (k) {
    if (k === 'method' || k === 'user') {
      return;
    }
    params[k] = options.stream[k];
  });

  twitter.connections[user.screenName].client.stream(method, params, function (stream) {
    var uuid = options.stream.method + '-' + resource.uuid();

    twitter.connections[user.screenName].streams[uuid] = {
      stream: stream,
      options: options
    };

    stream.on('data', function (data) {
      data.message = data.text;
      data.user.screenName = data.user.screen_name;
      twitter.receive(data);
    });
    stream.on('limit', function (data) {
      twitter.limit(data);
    });
    stream.on('error', function (err, code) {
      if (typeof err == 'string' && typeof code !== 'undefined') {
        err = new Error(err + ' ' + code);
        err.code = code;
      }
      twitter.error(err);
    });

    options.streamId = uuid;
    callback(null, options);
  });
};

twitter.method('getStream', getStream, {
  description: 'gets an active twitter stream',
  properties: {
    options: withUser({
      type: 'object',
      properties: {
        streamId: {
          type: 'string'
        }
      }
    }),
    callback: {
      type: 'function'
    }
  }
});
function getStream (options, callback) {

  var stream,
      screenName = getUser(options).screenName;

  try {
    stream = twitter.connections[screenName].streams[options.streamId];
  }
  catch (err) {
    return callback(err);
  }
  callback(null, stream);
}

twitter.method('removeStream', removeStream, {
  description: 'stops listening to a twitter stream',
  properties: {
    object: withUser({
      type: 'object',
      properties: {
        streamId: {
          type: 'string'
        }
      }
    }),
    callback: {
      type: 'function',
      default: function (error, options) {}
    }
  }
});
function removeStream (options, callback) {
  var screenName = getUser(options).screenName;

  twitter.getStream(options, function (err, stream) {

    if (err) {
      return callback(err);
    }

    stream.stream.destroy();
    stream.stream.on('destroy', function () {
      delete twitter.connections[screenName].streams[options.streamId];
      callback(null, options);
    });
  });
}


twitter.method('limit', limit, {
  description: 'collects rate limiting events from twitter',
  properties: {
    options: {
      type: 'object'
    },
    callback: {
      type: 'function',
      default: function () {}
    }
  }
});
function limit (callback) {
  resource.logger.warn('limit: ', data);
  callback(data);
};

twitter.method('error', onError, {
  description: 'collects error events from twitter',
  properties: {
    error: {},
    callback: {
      type: 'function',
      default: function () {}
    }
  }
});
function onError (error, callback) {
  if (typeof error === 'string') {
    error = new Error(error);
  }
  resource.logger.error(error.message);
  resource.logger.error(error.stack);
  callback(error);
};

//
// Send and receive tweets
//
twitter.method('send', send, {
  description: 'sends a tweet (updates your status)',
  properties: {
    options: withUser({
      type: 'object',
      properties: {
        tweet: twitter.schema.properties.tweet
      }
    }),
    callback: {
      default: function () {
        resource.logger.info('sent tweet: ');
        [].slice.call(arguments).forEach(function (arg, i) {
          resource.logger.info(i + ': ' + arg);
        });
      }
    }
  }
});
function send (options, callback) {

  // TODO: retweets
  // TODO: "true" replies
  // These will probably be separate methods.

  var screenName = getUser(options).screenName,
      tweet = options.tweet.message;

  // TODO: Intelligent trimming of tweet?
  twitter.connections[screenName].client.updateStatus(tweet, function (err, result) {
    if (err) {
      return callback(err);
    }
    callback(null, result);
  });
};

twitter.method('receive', receive, {
  description: 'receives tweets from activated streams',
  properties: {
    options: twitter.schema.properties.tweet,
    callback: {
      default: function () {
        resource.logger.info('received tweet: ');
        [].slice.call(arguments).forEach(function (arg, i) {
          resource.logger.info(i + ': ' + arg);
        });
      }
    }
  }
});
function receive (options, callback) {
  callback(null, options);
};

twitter.method('follow', follow, {
  description: 'follows a twitter user',
  properties: {
    options: withUser(twitter.schema.properties.user),
    callback: {
      type: 'function',
      default: function () {
        resource.logger.info('followed: ');
        [].slice.call(arguments).forEach(function (arg, i) {
          resource.logger.info(i + ': ' + arg);
        });
      }
    }
  }
});
function follow (options, callback) {
  var screenName = getUser(options).screenName;

  twitter.connections[screenName].client.createFriendship(options.id, callback);
};

twitter.method('unfollow', unfollow, {
  description: 'unfollows a twitter user',
  properties: {
    options: withUser({
      type: 'object'
    }),
    callback: {
      type: 'function',
      default: function () {
        resource.logger.info('unfollowed: ');
        [].slice.call(arguments).forEach(function (arg, i) {
          resource.logger.info(i + ': ' + arg);
        });
      }
    }
  }
});
function unfollow (options, callback) {
  twitter.client.destroyFriendship(options.id, callback);
};

// TODO: unblock
twitter.method('block', block, {
  description: 'blocks a twitter user',
  properties: {
    options: withUser({
      type: 'object'
    }),
    callback: {
      type: 'function',
      default: function () {
        resource.logger.info('blocked: ');
        [].slice.call(arguments).forEach(function (arg, i) {
          resource.logger.info(i + ': ' + arg);
        });
      }
    }
  }
});
function block (options, callback) {
  var screenName = getUser(options).screenName;

  twitter.connections[screenName].client.createBlock(options.id, callback);
};

twitter.method('report', report, {
  description: 'reports a twitter user',
  properties: {
    options: withUser(twitter.schema.properties.user),
    callback: {
      type: 'function',
      default: function () {
        resource.logger.warn('reported:');
        [].slice.call(arguments).forEach(function (arg, i) {
          resource.logger.warn(i + ': ' + arg);
        });
      }
    }
  }
});
function report (options, callback) {
  var screenName = getUser(options).screenName;

  twitter.connections[screenName].client.reportSpam(options.id, callback);
};

twitter.method('tweetLength', tweetLength, {
  description: 'gets the length of a tweet',
  properties: {
    options: twitter.schema.properties.tweet,
    callback: {
      type: 'function',
      required: false
    }
  }
});
function tweetLength (options, callback) {
  var l = require('twitter-text').getTweetLength(options.message);

  if (callback) {
    callback(null, l);
  }
  else {
    return l;
  }
};

exports.twitter = twitter;
exports.dependencies = {
  "ntwitter": "0.5.0",
  "twitter-text": "1.5.2"
};
