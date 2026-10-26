'use strict';

const crypto = require('crypto');

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 40;
const MAX_NAME_LENGTH = 20;
const CODE_LENGTH = 4;
// Uten I, O, 0 og 1 så koden er lett å lese av fra tavla.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const AVATARS = ['🐰', '🦊', '🐻', '🐸', '🐨', '🐯', '🦉', '🐵', '🐼', '🐙', '🦁', '🐧', '🐮', '🐷', '🦄', '🐊'];

class GameError extends Error {}

function createCode(isTaken = () => false) {
  let code;
  do {
    code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (isTaken(code));
  return code;
}

function createRoom(code) {
  return {
    code,
    hostToken: null,
    hostSocketId: null,
    phase: 'lobby', // lobby -> ready -> voting -> result -> ... -> ended
    round: 0,
    players: new Map(),
    votes: new Map(), // voterId -> targetId, kun for åpen avstemming
    result: null,
    lastActivity: Date.now(),
  };
}

function normalizeName(raw) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  if (!name) throw new GameError('Please enter your name.');
  return name;
}

function activePlayers(room) {
  return [...room.players.values()].filter((player) => !player.eliminated);
}

function addPlayer(room, playerId, rawName, socketId) {
  const existing = room.players.get(playerId);
  if (existing) {
    // Gjenoppkobling: beholder plass, stemme og status.
    existing.connected = true;
    existing.socketId = socketId;
    return existing;
  }
  if (room.phase !== 'lobby') throw new GameError('The game has already started.');
  if (room.players.size >= MAX_PLAYERS) throw new GameError('The game is full.');

  const player = {
    id: playerId,
    name: normalizeName(rawName),
    avatar: AVATARS[room.players.size % AVATARS.length],
    eliminated: false,
    connected: true,
    socketId,
  };
  room.players.set(playerId, player);
  return player;
}

function startGame(room) {
  if (room.phase !== 'lobby') throw new GameError('The game has already started.');
  if (room.players.size < MIN_PLAYERS) throw new GameError(`You need at least ${MIN_PLAYERS} players to start.`);
  room.phase = 'ready';
}

function startVote(room) {
  if (room.phase !== 'ready' && room.phase !== 'result') throw new GameError("You can't start a vote now.");
  if (activePlayers(room).length < 2) throw new GameError('At least two players must be left to vote.');
  room.round += 1;
  room.votes = new Map();
  room.result = null;
  room.phase = 'voting';
}

function castVote(room, voterId, targetId) {
  if (room.phase !== 'voting') throw new GameError('There is no open vote.');

  const voter = room.players.get(voterId);
  if (!voter || voter.eliminated) throw new GameError('You are not in this vote.');
  if (room.votes.has(voterId)) throw new GameError('You have already voted.');

  const target = room.players.get(targetId);
  if (!target || target.eliminated) throw new GameError('Invalid choice.');
  if (targetId === voterId) throw new GameError("You can't vote for yourself.");

  room.votes.set(voterId, targetId);

  // Avstemmingen lukkes når alle som er med har stemt.
  if (room.votes.size === activePlayers(room).length) closeVote(room);
}

// Lukker avstemmingen, teller stemmene og kaster ut den med flest stemmer.
// Ved uavgjort eller ingen stemmer blir ingen kastet ut.
function closeVote(room) {
  if (room.phase !== 'voting') throw new GameError('There is no open vote.');

  const counts = {};
  for (const player of activePlayers(room)) counts[player.id] = 0;
  for (const targetId of room.votes.values()) counts[targetId] += 1;

  const highest = Math.max(0, ...Object.values(counts));
  const leaders = Object.keys(counts).filter((id) => counts[id] === highest);
  const tie = highest === 0 || leaders.length > 1;
  const eliminatedId = tie ? null : leaders[0];

  if (eliminatedId) room.players.get(eliminatedId).eliminated = true;

  room.result = {
    round: room.round,
    counts,
    eliminatedId,
    tie,
    votesCast: room.votes.size,
  };
  room.phase = 'result';
}

function endGame(room) {
  room.phase = 'ended';
  room.votes = new Map();
  room.result = null;
}

// Den delen av tilstanden som alle klienter får se. Stemmene til den enkelte spilleren holdes privat.
function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      eliminated: player.eliminated,
      connected: player.connected,
    })),
    activeCount: activePlayers(room).length,
    voteCount: room.votes.size,
    result: room.result,
  };
}

module.exports = {
  MIN_PLAYERS,
  MAX_PLAYERS,
  GameError,
  createCode,
  createRoom,
  normalizeName,
  addPlayer,
  startGame,
  startVote,
  castVote,
  closeVote,
  endGame,
  publicState,
};
