'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const game = require('./lib/room');

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map(); // kode -> rom
const sessions = new Map(); // socket.id -> { code, role, playerId? }

function getRoom(code) {
  const room = rooms.get(String(code || '').trim().toUpperCase());
  if (!room) throw new game.GameError('Fant ikke spillet. Sjekk koden.');
  room.lastActivity = Date.now();
  return room;
}

function requireHost(socket) {
  const session = sessions.get(socket.id);
  if (!session || session.role !== 'host') throw new game.GameError('Bare verten kan gjøre dette.');
  const room = getRoom(session.code);
  if (room.hostSocketId !== socket.id) throw new game.GameError('Bare verten kan gjøre dette.');
  return room;
}

function requirePlayer(socket) {
  const session = sessions.get(socket.id);
  if (!session || session.role !== 'player') throw new game.GameError('Du er ikke med i et spill.');
  return { room: getRoom(session.code), playerId: session.playerId };
}

// Sender felles tilstand til alle i rommet, og hver spillers egen stemme privat.
function broadcast(room) {
  for (const player of room.players.values()) {
    if (player.connected && player.socketId) {
      io.to(player.socketId).emit('player:me', {
        playerId: player.id,
        myVote: room.votes.get(player.id) || null,
      });
    }
  }
  io.to(room.code).emit('room:state', game.publicState(room));
}

function baseUrlFor(socket, requested) {
  if (/^https?:\/\/[^/\s]+$/.test(String(requested || ''))) return requested;
  return `http://${socket.handshake.headers.host}`;
}

async function hostPayload(room, socket, baseUrl) {
  const joinUrl = `${baseUrlFor(socket, baseUrl)}/?code=${room.code}`;
  const qr = await QRCode.toDataURL(joinUrl, {
    margin: 1,
    width: 480,
    color: { dark: '#3A211B', light: '#FFFFFF' },
  });
  return { code: room.code, hostToken: room.hostToken, joinUrl, qr };
}

io.on('connection', (socket) => {
  // Samler feilhåndtering: GameError vises til brukeren, alt annet logges.
  function on(event, handler) {
    socket.on(event, (payload, ack) => {
      Promise.resolve()
        .then(() => handler(payload || {}))
        .then((result) => typeof ack === 'function' && ack({ ok: true, ...result }))
        .catch((err) => {
          const known = err instanceof game.GameError;
          if (!known) console.error(err);
          if (typeof ack === 'function') ack({ ok: false, error: known ? err.message : 'Noe gikk galt.' });
        });
    });
  }

  on('host:create', async ({ baseUrl }) => {
    const room = game.createRoom(game.createCode((code) => rooms.has(code)));
    room.hostToken = crypto.randomBytes(16).toString('hex');
    room.hostSocketId = socket.id;
    rooms.set(room.code, room);
    sessions.set(socket.id, { code: room.code, role: 'host' });
    socket.join(room.code);
    const payload = await hostPayload(room, socket, baseUrl);
    broadcast(room);
    return payload;
  });

  on('host:resume', async ({ code, hostToken, baseUrl }) => {
    const room = getRoom(code);
    if (!hostToken || hostToken !== room.hostToken) throw new game.GameError('Fant ikke spillet ditt lenger.');
    room.hostSocketId = socket.id;
    sessions.set(socket.id, { code: room.code, role: 'host' });
    socket.join(room.code);
    const payload = await hostPayload(room, socket, baseUrl);
    broadcast(room);
    return payload;
  });

  on('host:start', () => {
    const room = requireHost(socket);
    game.startGame(room);
    broadcast(room);
    return {};
  });

  on('host:startVote', () => {
    const room = requireHost(socket);
    game.startVote(room);
    broadcast(room);
    return {};
  });

  on('host:closeVote', () => {
    const room = requireHost(socket);
    game.closeVote(room);
    broadcast(room);
    return {};
  });

  on('host:end', () => {
    const room = requireHost(socket);
    game.endGame(room);
    broadcast(room);
    return {};
  });

  on('player:join', ({ code, name, playerId }) => {
    const room = getRoom(code);
    if (typeof playerId !== 'string' || playerId.length < 8 || playerId.length > 64) {
      throw new game.GameError('Ugyldig spiller. Last siden på nytt.');
    }
    game.addPlayer(room, playerId, name, socket.id);
    sessions.set(socket.id, { code: room.code, role: 'player', playerId });
    socket.join(room.code);
    broadcast(room);
    return { code: room.code };
  });

  on('player:vote', ({ targetId }) => {
    const { room, playerId } = requirePlayer(socket);
    game.castVote(room, playerId, targetId);
    broadcast(room);
    return {};
  });

  socket.on('disconnect', () => {
    const session = sessions.get(socket.id);
    sessions.delete(socket.id);
    const room = session && rooms.get(session.code);
    if (!room) return;

    if (session.role === 'player') {
      const player = room.players.get(session.playerId);
      // Hopp over hvis spilleren allerede har koblet til på nytt med en annen socket.
      if (!player || player.socketId !== socket.id) return;
      player.connected = false;
      broadcast(room);
    }
  });
});

setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.lastActivity < cutoff) rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Imposter-spillet kjører på http://localhost:${PORT}/host`);
});
