"use strict";

const express = require('express'), socketio = require('socket.io'), http = require('http'), Redis = require('ioredis'), request = require('request'), pg = require('pg').native;

let db = new pg.Pool({database: 'kaori'});

let SC = require('node-soundcloud');
SC.init({
  client_id: process.env.SC_APIKEY
});

let app = express();
app.use(express.static('static'));
app.get('/sc_apikey.js', function (req, res) {
  res.send('var sc_apikey = '+process.env.SC_APIKEY+';');
});

let srv = http.Server(app);

let redis = new Redis({db: 5});
redis.set('user-count', 0);

let io = socketio(srv);

io.on('connection', function (socket) {
  redis.incr('user-count').then(function (result) {
    io.emit('user-count', result);
  });
  socket.on('disconnect', function () {
    redis.decr('user-count').then(function (result) {
      io.emit('user-count', result);
    });
  });
  socket.on('get-current', function () {
    redis.pipeline().get('current-song').ttl('current-song').get('current-song-length').exec().then(function (result) {
      socket.emit('current-song', [result[0][1], (result[2][1] - result[1][1]) * 1000]);
    });
  });
  socket.on('suggest', function (url) {
    request({
      url: 'https://api.soundcloud.com/resolve',
      qs: {client_id: process.env.SC_APIKEY, url: url}
    }, function (err, response, result) {
      let result2 = JSON.parse(result);
      if (err || 'errors' in result2) {
        socket.emit('message', "An error occured while adding the song");
      } else {
        db.query("INSERT INTO songs (id, length, title, author) VALUES ($1, $2, $3, $4)", [result2.id, (result2.duration / 1000 + 5).toFixed(0), result2.title, result2.user.username]).then(function (err, result) {
          if (err) throw err;
          socket.emit('message', 'Added ' + result2.title + " by " + result2.user.username + ' to songs pool.');
        });
      }
    });
  });
  socket.on('skip', function () {
    redis.expire('current-song', 0);
    autoCheck();
  });
  socket.on('vote', function (song) {

    db.query("UPDATE songs SET last_access = DEFAULT, votes = votes+1 WHERE id = $1", [song]).then(function (err, result) {
      if (err) throw err;

      socket.emit('voted-up', song);
    })

  })
});

function autoCheck() {
  clearTimeout(autoCheckTimeout);
  redis.get('current-song').then(function (result) {
    if (result == null) {
      throw Error;
    }
  }).catch(function () {
    db.query('SELECT * FROM kaori.public.songs ORDER BY votes DESC, last_access ASC LIMIT 1;', [], function (err, result) {
      if (err) throw err;
      io.emit('current-song', [result.rows[0].id, 0]);
      io.emit('message', `Now playing ${result.rows[0].title} by ${result.rows[0].author}`);
      redis.pipeline().set('current-song', result.rows[0].id).expire('current-song', result.rows[0].length).set('current-song-length', result.rows[0].length).exec();
      db.query('UPDATE songs SET last_access = DEFAULT, votes = 0 WHERE id = $1', [result.rows[0].id]).then(function () {
        autoCheckTimeout = setTimeout(autoCheck, (result.rows[0].length + 1) * 1000);
      });
    });
  });
};

let autoCheckTimeout = setTimeout(autoCheck, 5000);

srv.listen(3000);
