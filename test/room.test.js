'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const room = require('../lib/room');

function createRoomWith(count) {
  const r = room.createRoom('ABCD');
  for (let i = 0; i < count; i++) room.addPlayer(r, `p${i}`, `Spiller ${i}`, `s${i}`);
  return r;
}

test('spillet krever minst tre spillere før det kan starte', () => {
  const r = createRoomWith(2);
  assert.throws(() => room.startGame(r), /minst 3/);

  room.addPlayer(r, 'p2', 'Ola', 's2');
  room.startGame(r);
  assert.equal(r.phase, 'ready');
});

test('avstemmingen lukkes automatisk når alle som er med har stemt', () => {
  const r = createRoomWith(3);
  room.startGame(r);
  room.startVote(r);

  room.castVote(r, 'p0', 'p1');
  room.castVote(r, 'p1', 'p2');
  assert.equal(r.phase, 'voting');

  room.castVote(r, 'p2', 'p1');
  assert.equal(r.phase, 'result');
  assert.equal(r.result.eliminatedId, 'p1');
  assert.equal(r.result.tie, false);
  assert.equal(r.players.get('p1').eliminated, true);
});

test('uavgjort kaster ingen ut', () => {
  const r = createRoomWith(4);
  room.startGame(r);
  room.startVote(r);

  room.castVote(r, 'p0', 'p2');
  room.castVote(r, 'p1', 'p3');
  room.castVote(r, 'p2', 'p3');
  room.castVote(r, 'p3', 'p2');

  assert.equal(r.phase, 'result');
  assert.equal(r.result.tie, true);
  assert.equal(r.result.eliminatedId, null);
  assert.ok([...r.players.values()].every((player) => !player.eliminated));
});

test('lukking uten stemmer kaster ingen ut', () => {
  const r = createRoomWith(3);
  room.startGame(r);
  room.startVote(r);

  room.closeVote(r);
  assert.equal(r.phase, 'result');
  assert.equal(r.result.eliminatedId, null);
  assert.equal(r.result.tie, true);
});

test('man kan ikke stemme på seg selv eller stemme to ganger', () => {
  const r = createRoomWith(3);
  room.startGame(r);
  room.startVote(r);

  assert.throws(() => room.castVote(r, 'p0', 'p0'), /deg selv/);

  room.castVote(r, 'p0', 'p1');
  assert.throws(() => room.castVote(r, 'p0', 'p2'), /allerede stemt/);
});

test('utkastede spillere kan ikke stemme, og neste runde ekskluderer dem', () => {
  const r = createRoomWith(3);
  room.startGame(r);
  room.startVote(r);
  room.castVote(r, 'p0', 'p1');
  room.castVote(r, 'p1', 'p2');
  room.castVote(r, 'p2', 'p1');

  room.startVote(r);
  assert.equal(r.round, 2);
  assert.throws(() => room.castVote(r, 'p1', 'p0'), /ikke med/);
  assert.throws(() => room.castVote(r, 'p0', 'p1'), /Ugyldig valg/);

  room.castVote(r, 'p0', 'p2');
  room.castVote(r, 'p2', 'p0');
  assert.equal(r.phase, 'result');
  assert.equal(r.result.eliminatedId, null);
  assert.equal(r.result.tie, true);
});

test('ny avstemming kan ikke starte når færre enn to er igjen', () => {
  const r = createRoomWith(3);
  room.startGame(r);
  room.startVote(r);
  room.castVote(r, 'p0', 'p1');
  room.castVote(r, 'p1', 'p0');
  room.castVote(r, 'p2', 'p0');
  assert.equal(r.players.get('p0').eliminated, true);

  r.players.get('p1').eliminated = true;
  assert.throws(() => room.startVote(r), /Minst to/);
});

test('gjenoppkobling beholder spilleren og lar den stemme videre', () => {
  const r = createRoomWith(3);
  room.startGame(r);
  room.startVote(r);
  room.castVote(r, 'p0', 'p1');

  r.players.get('p0').connected = false;
  const player = room.addPlayer(r, 'p0', 'Endret navn', 'nytt-socket');

  assert.equal(player.name, 'Spiller 0');
  assert.equal(player.connected, true);
  assert.equal(player.socketId, 'nytt-socket');
  assert.equal(r.players.size, 3);
  assert.equal(r.votes.get('p0'), 'p1');
});

test('nye spillere slipper ikke inn etter at spillet har startet', () => {
  const r = createRoomWith(3);
  room.startGame(r);
  assert.throws(() => room.addPlayer(r, 'ny', 'Sen', 'x'), /allerede startet/);
});

test('publicState viser ikke hvem som stemte på hvem', () => {
  const r = createRoomWith(3);
  room.startGame(r);
  room.startVote(r);
  room.castVote(r, 'p0', 'p1');

  const state = room.publicState(r);
  assert.equal(state.voteCount, 1);
  assert.equal(state.activeCount, 3);
  assert.equal('votes' in state, false);
  assert.equal(state.result, null);
});

test('navn renses og avkortes', () => {
  assert.equal(room.normalizeName('  Ola   Nordmann  '), 'Ola Nordmann');
  assert.equal(room.normalizeName('x'.repeat(50)).length, 20);
  assert.throws(() => room.normalizeName('   '), /Skriv inn et navn/);
});
