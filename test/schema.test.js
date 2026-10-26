'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createLocalDatabase } = require('../scripts/local-db');

let db;
let rpc;

test.before(async () => {
  ({ db, rpc } = await createLocalDatabase());
});

test.after(async () => {
  await db.close();
});

const secret = () => crypto.randomBytes(12).toString('hex');

async function newGame(playerCount) {
  const hostSecret = secret();
  const code = await rpc('imposter_create_game', { p_host_secret: hostSecret });
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    const playerSecret = secret();
    const joined = await rpc('imposter_join_game', { p_code: code, p_name: `Player ${i}`, p_secret: playerSecret });
    players.push({ id: joined.playerId, secret: playerSecret });
  }
  return { code, hostSecret, players };
}

const host = (game, fn) => rpc(fn, { p_code: game.code, p_host_secret: game.hostSecret });
const vote = (game, voter, target) =>
  rpc('imposter_cast_vote', { p_code: game.code, p_secret: game.players[voter].secret, p_target: game.players[target].id });
const state = (game, player = null) =>
  rpc('imposter_get_state', { p_code: game.code, p_secret: player === null ? null : game.players[player].secret });

async function startVoting(playerCount) {
  const game = await newGame(playerCount);
  await host(game, 'imposter_start_game');
  await host(game, 'imposter_start_vote');
  return game;
}

test('the game needs at least 3 players to start', async () => {
  const game = await newGame(2);
  await assert.rejects(host(game, 'imposter_start_game'), /at least 3/);

  const joined = await rpc('imposter_join_game', { p_code: game.code, p_name: 'Ola', p_secret: secret() });
  assert.ok(joined.playerId);
  await host(game, 'imposter_start_game');
  assert.equal((await state(game)).phase, 'ready');
});

test('the vote closes by itself when everyone has voted, and the top player is out', async () => {
  const game = await startVoting(3);

  await vote(game, 0, 1);
  await vote(game, 1, 2);
  assert.equal((await state(game)).phase, 'voting');
  assert.equal((await state(game)).voteCount, 2);

  await vote(game, 2, 1);
  const after = await state(game);
  assert.equal(after.phase, 'result');
  assert.equal(after.result.eliminatedId, game.players[1].id);
  assert.equal(after.result.tie, false);
  assert.equal(after.result.counts[game.players[1].id], 2);
  assert.equal(after.players[1].eliminated, true);
});

test('a tie sends nobody out', async () => {
  const game = await startVoting(4);
  await vote(game, 0, 2);
  await vote(game, 1, 3);
  await vote(game, 2, 3);
  await vote(game, 3, 2);

  const after = await state(game);
  assert.equal(after.phase, 'result');
  assert.equal(after.result.tie, true);
  assert.equal(after.result.eliminatedId, null);
  assert.ok(after.players.every((player) => !player.eliminated));
});

test('the host can close a vote with no votes, and nobody is out', async () => {
  const game = await startVoting(3);
  await host(game, 'imposter_close_vote');

  const after = await state(game);
  assert.equal(after.phase, 'result');
  assert.equal(after.result.tie, true);
  assert.equal(after.result.eliminatedId, null);
});

test('you cannot vote for yourself or vote twice', async () => {
  const game = await startVoting(3);
  await assert.rejects(vote(game, 0, 0), /yourself/);
  await vote(game, 0, 1);
  await assert.rejects(vote(game, 0, 2), /already voted/);
});

test('players who are out cannot vote, and round 2 only counts the players left', async () => {
  const game = await startVoting(3);
  await vote(game, 0, 1);
  await vote(game, 1, 2);
  await vote(game, 2, 1);

  await host(game, 'imposter_start_vote');
  const round2 = await state(game);
  assert.equal(round2.round, 2);
  assert.equal(round2.phase, 'voting');
  assert.equal(round2.activeCount, 2);
  assert.equal(round2.voteCount, 0);

  await assert.rejects(vote(game, 1, 0), /not in this vote/);
  await assert.rejects(vote(game, 0, 1), /Invalid choice/);

  await vote(game, 0, 2);
  await vote(game, 2, 0);
  const after = await state(game);
  assert.equal(after.phase, 'result');
  assert.equal(after.result.round, 2);
  assert.equal(after.result.tie, true);
});

test('a new vote cannot start when fewer than two players are left', async () => {
  const game = await startVoting(3);
  await vote(game, 0, 1);
  await vote(game, 1, 0);
  await vote(game, 2, 0);
  await db.query('update imposter_players set eliminated = true where id = $1', [game.players[1].id]);
  await assert.rejects(host(game, 'imposter_start_vote'), /At least two/);
});

test('joining again with the same key returns the same player and keeps the vote', async () => {
  const game = await startVoting(3);
  await vote(game, 0, 1);

  const again = await rpc('imposter_join_game', { p_code: game.code, p_name: 'Another name', p_secret: game.players[0].secret });
  assert.equal(again.playerId, game.players[0].id);

  const mine = await state(game, 0);
  assert.equal(mine.meId, game.players[0].id);
  assert.equal(mine.myVote, game.players[1].id);
  assert.equal(mine.players.length, 3);
  assert.equal(mine.players[0].name, 'Player 0');
});

test('new players cannot join after the game has started', async () => {
  const game = await newGame(3);
  await host(game, 'imposter_start_game');
  await assert.rejects(
    rpc('imposter_join_game', { p_code: game.code, p_name: 'Late', p_secret: secret() }),
    /already started/,
  );
});

test('the state never shows who voted for whom', async () => {
  const game = await startVoting(4);
  await vote(game, 0, 1);

  const everyone = await state(game);
  assert.equal(everyone.voteCount, 1);
  assert.equal(everyone.myVote, null);
  assert.equal(everyone.meId, null);

  const other = await state(game, 2);
  assert.equal(other.myVote, null);

  const voter = await state(game, 0);
  assert.equal(voter.myVote, game.players[1].id);
});

test('names are cleaned up, and a name can only be used once', async () => {
  const game = await newGame(0);
  const first = await rpc('imposter_join_game', { p_code: game.code, p_name: '  Emma    Rose  ', p_secret: secret() });
  assert.ok(first.playerId);
  assert.equal((await state(game)).players[0].name, 'Emma Rose');

  await assert.rejects(rpc('imposter_join_game', { p_code: game.code, p_name: 'emma rose', p_secret: secret() }), /taken/);
  await assert.rejects(rpc('imposter_join_game', { p_code: game.code, p_name: '   ', p_secret: secret() }), /enter your name/);

  const long = await rpc('imposter_join_game', { p_code: game.code, p_name: 'x'.repeat(50), p_secret: secret() });
  assert.ok(long.playerId);
  assert.equal((await state(game)).players[1].name.length, 20);
});

test('only the host can control the game', async () => {
  const game = await newGame(3);
  await assert.rejects(rpc('imposter_start_game', { p_code: game.code, p_host_secret: secret() }), /Only the host/);
  await assert.rejects(rpc('imposter_start_game', { p_code: game.code, p_host_secret: game.players[0].secret }), /Only the host/);
  await assert.rejects(rpc('imposter_end_game', { p_code: game.code, p_host_secret: null }), /Only the host/);
});

test('an unknown game code gives a clear error', async () => {
  await assert.rejects(rpc('imposter_get_state', { p_code: 'ZZZZ' }), /Game not found/);
});

test('ending the game shows the end screen', async () => {
  const game = await newGame(3);
  await host(game, 'imposter_end_game');
  assert.equal((await state(game)).phase, 'ended');
});

test('the browser role can read games but not secrets, players or votes', async () => {
  const game = await newGame(3);
  await db.exec('set role anon');
  try {
    const games = await db.query('select code, phase from imposter_games where code = $1', [game.code]);
    assert.equal(games.rows.length, 1);
    for (const table of ['imposter_secrets', 'imposter_players', 'imposter_votes']) {
      await assert.rejects(db.query(`select * from ${table}`), /permission denied/);
    }
    await assert.rejects(db.query('update imposter_games set phase = $1', ['ended']), /permission denied/);
    await assert.rejects(db.query('select imposter_close_vote_internal($1)', [game.code]), /permission denied/);
  } finally {
    await db.exec('reset role');
  }
});
