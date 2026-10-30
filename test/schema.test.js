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
const setImpostors = (game, indexes) =>
  rpc('imposter_set_impostors', {
    p_code: game.code,
    p_host_secret: game.hostSecret,
    p_ids: indexes.map((i) => game.players[i].id),
  });
const vote = (game, voter, target) =>
  rpc('imposter_cast_vote', { p_code: game.code, p_secret: game.players[voter].secret, p_target: game.players[target].id });
const state = (game, player = null, asHost = false) =>
  rpc('imposter_get_state', {
    p_code: game.code,
    p_secret: player === null ? null : game.players[player].secret,
    p_host_secret: asHost ? game.hostSecret : null,
  });

// Starter spillet, velger impostorer og åpner første avstemming.
async function startVoting(playerCount, impostors = [0]) {
  const game = await newGame(playerCount);
  await host(game, 'imposter_start_game');
  await setImpostors(game, impostors);
  await host(game, 'imposter_start_vote');
  return game;
}

// Lar hver spiller stemme: votes er [velger, valgt]-par.
async function castAll(game, votes) {
  for (const [voter, target] of votes) await vote(game, voter, target);
}

test('the game needs at least 3 players to start', async () => {
  const game = await newGame(2);
  await assert.rejects(host(game, 'imposter_start_game'), /at least 3/);

  const joined = await rpc('imposter_join_game', { p_code: game.code, p_name: 'Ola', p_secret: secret() });
  assert.ok(joined.playerId);
  await host(game, 'imposter_start_game');
  assert.equal((await state(game)).phase, 'ready');
});

test('the host picks the impostors before the first vote, and the vote needs a valid pick', async () => {
  const game = await newGame(4);
  await host(game, 'imposter_start_game');

  await assert.rejects(host(game, 'imposter_start_vote'), /at least one impostor/);
  await setImpostors(game, [0, 1, 2]);
  await assert.rejects(host(game, 'imposter_start_vote'), /more crew than impostors/);

  await setImpostors(game, [1]);
  await host(game, 'imposter_start_vote');
  assert.equal((await state(game)).phase, 'voting');

  await assert.rejects(setImpostors(game, [2]), /before the first vote/);
});

test('only the host can pick impostors, and only players in the game', async () => {
  const game = await newGame(3);
  const other = await newGame(3);
  await host(game, 'imposter_start_game');

  await assert.rejects(
    rpc('imposter_set_impostors', { p_code: game.code, p_host_secret: secret(), p_ids: [game.players[0].id] }),
    /Only the host/,
  );
  await assert.rejects(
    rpc('imposter_set_impostors', { p_code: game.code, p_host_secret: game.hostSecret, p_ids: [other.players[0].id] }),
    /Invalid choice/,
  );
});

test('the impostors are hidden from players and shown to the host', async () => {
  const game = await startVoting(4, [2]);

  assert.equal((await state(game, 0)).impostorIds, null);
  assert.equal((await state(game)).impostorIds, null);
  assert.deepEqual((await state(game, null, true)).impostorIds, [game.players[2].id]);
});

test('the vote closes by itself when everyone has voted, and the top player is out', async () => {
  const game = await startVoting(5);

  await castAll(game, [[0, 1], [1, 2]]);
  assert.equal((await state(game)).phase, 'voting');
  assert.equal((await state(game)).voteCount, 2);

  await castAll(game, [[2, 1], [3, 1], [4, 1]]);
  const after = await state(game);
  assert.equal(after.phase, 'result');
  assert.equal(after.result.eliminatedId, game.players[1].id);
  assert.equal(after.result.tie, false);
  assert.equal(after.result.counts[game.players[1].id], 4);
  assert.equal(after.players[1].eliminated, true);
});

test('a tie starts a runoff between the tied players only', async () => {
  const game = await startVoting(5);
  // Player 1 and player 2 both get two votes.
  await castAll(game, [[0, 1], [3, 1], [1, 2], [4, 2], [2, 0]]);

  const tied = await state(game);
  assert.equal(tied.phase, 'result');
  assert.equal(tied.result.tie, true);
  assert.equal(tied.result.eliminatedId, null);
  assert.deepEqual([...tied.result.runoffIds].sort(), [game.players[1].id, game.players[2].id].sort());
  assert.ok(tied.players.every((player) => !player.eliminated));

  await host(game, 'imposter_start_vote');
  const runoff = await state(game);
  assert.equal(runoff.phase, 'voting');
  assert.equal(runoff.round, 2);
  assert.equal(runoff.inRunoff, true);
  assert.equal(runoff.candidateIds.length, 2);

  await assert.rejects(vote(game, 3, 0), /players who tied/);
  await assert.rejects(vote(game, 1, 1), /yourself/);

  await castAll(game, [[0, 1], [3, 1], [4, 1], [1, 2], [2, 1]]);
  const done = await state(game);
  assert.equal(done.phase, 'result');
  assert.equal(done.result.eliminatedId, game.players[1].id);
  assert.equal(done.result.runoffIds, null);
  assert.equal(Object.keys(done.result.counts).length, 2);
});

test('a tie in the runoff sends nobody out, and the next vote is a normal one', async () => {
  const game = await startVoting(6);
  await castAll(game, [[0, 1], [3, 1], [1, 2], [4, 2], [2, 0], [5, 3]]);
  assert.equal((await state(game)).result.runoffIds.length, 2);

  await host(game, 'imposter_start_vote');
  await castAll(game, [[0, 1], [3, 1], [4, 2], [5, 2], [1, 2], [2, 1]]);
  const tiedAgain = await state(game);
  assert.equal(tiedAgain.phase, 'result');
  assert.equal(tiedAgain.result.tie, true);
  assert.equal(tiedAgain.result.eliminatedId, null);
  assert.equal(tiedAgain.result.runoffIds, null);

  await host(game, 'imposter_start_vote');
  const normal = await state(game);
  assert.equal(normal.round, 3);
  assert.equal(normal.inRunoff, false);
  assert.equal(normal.candidateIds, null);
});

test('closing a vote with no votes sends nobody out and starts no runoff', async () => {
  const game = await startVoting(4);
  await host(game, 'imposter_close_vote');

  const after = await state(game);
  assert.equal(after.phase, 'result');
  assert.equal(after.result.tie, true);
  assert.equal(after.result.eliminatedId, null);
  assert.equal(after.result.runoffIds, null);

  await host(game, 'imposter_start_vote');
  assert.equal((await state(game)).candidateIds, null);
});

test('the crew wins when the last impostor is out', async () => {
  const game = await startVoting(4);
  await castAll(game, [[1, 0], [2, 0], [3, 0], [0, 1]]);

  const after = await state(game);
  assert.equal(after.phase, 'over');
  assert.equal(after.winner, 'crew');
  assert.equal(after.result.eliminatedId, game.players[0].id);
  assert.deepEqual(after.impostorIds, [game.players[0].id]);
  await assert.rejects(host(game, 'imposter_start_vote'), /can't start a vote/);
});

test('the impostors win when they are as many as the crew', async () => {
  const game = await startVoting(4);
  await castAll(game, [[0, 1], [2, 1], [3, 1], [1, 2]]);
  assert.equal((await state(game)).phase, 'result');

  await host(game, 'imposter_start_vote');
  await castAll(game, [[0, 2], [3, 2], [2, 3]]);
  const after = await state(game);
  assert.equal(after.phase, 'over');
  assert.equal(after.winner, 'impostors');
  assert.deepEqual(after.impostorIds, [game.players[0].id]);
});

test('two impostors win as soon as they are as many as the crew', async () => {
  const game = await startVoting(5, [0, 1]);
  await castAll(game, [[0, 2], [1, 2], [3, 2], [4, 2], [2, 3]]);

  const after = await state(game);
  assert.equal(after.phase, 'over');
  assert.equal(after.winner, 'impostors');
  assert.equal(after.impostorIds.length, 2);
});

test('you cannot vote for yourself or vote twice', async () => {
  const game = await startVoting(4);
  await assert.rejects(vote(game, 0, 0), /yourself/);
  await vote(game, 0, 1);
  await assert.rejects(vote(game, 0, 2), /already voted/);
});

test('players who are out cannot vote, and later rounds only count the players left', async () => {
  const game = await startVoting(5);
  await castAll(game, [[0, 1], [2, 1], [3, 1], [4, 1], [1, 2]]);

  await host(game, 'imposter_start_vote');
  const round2 = await state(game);
  assert.equal(round2.round, 2);
  assert.equal(round2.activeCount, 4);
  assert.equal(round2.voteCount, 0);

  await assert.rejects(vote(game, 1, 0), /not in this vote/);
  await assert.rejects(vote(game, 0, 1), /Invalid choice/);
});

test('joining again with the same key returns the same player and keeps the vote', async () => {
  const game = await startVoting(4);
  await vote(game, 0, 1);

  const again = await rpc('imposter_join_game', { p_code: game.code, p_name: 'Another name', p_secret: game.players[0].secret });
  assert.equal(again.playerId, game.players[0].id);

  const mine = await state(game, 0);
  assert.equal(mine.meId, game.players[0].id);
  assert.equal(mine.myVote, game.players[1].id);
  assert.equal(mine.players.length, 4);
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
  assert.equal((await state(game, 2)).myVote, null);
  assert.equal((await state(game, 0)).myVote, game.players[1].id);
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

const kill = (game, target) =>
  rpc('imposter_kill_player', { p_code: game.code, p_host_secret: game.hostSecret, p_player: game.players[target].id });

test('the host can mark a player as killed before a vote, and the player is out for everyone', async () => {
  const game = await newGame(5);
  await assert.rejects(kill(game, 3), /before a vote/); // lobby
  await host(game, 'imposter_start_game');
  await assert.rejects(kill(game, 3), /Pick the impostors first/);
  await setImpostors(game, [0]);

  await kill(game, 3);
  const after = await state(game);
  assert.equal(after.phase, 'ready');
  assert.equal(after.players[3].eliminated, true);
  assert.deepEqual(after.killedIds, [game.players[3].id]);
  assert.equal(after.activeCount, 4);
  await assert.rejects(kill(game, 3), /Invalid choice/);

  // The dead player cannot be voted for or vote, and the kill stays visible during the vote.
  await host(game, 'imposter_start_vote');
  assert.deepEqual((await state(game)).killedIds, [game.players[3].id]);
  await assert.rejects(vote(game, 0, 3), /Invalid choice/);
  await assert.rejects(vote(game, 3, 0), /not in this vote/);
  await assert.rejects(kill(game, 2), /before a vote/);

  // Only the four who are alive vote, and the kill is cleared when the vote closes.
  await castAll(game, [[0, 1], [2, 1], [4, 1], [1, 0]]);
  const result = await state(game);
  assert.equal(result.phase, 'result');
  assert.equal(result.result.eliminatedId, game.players[1].id);
  assert.equal(result.killedIds, null);
});

test('only the host can mark a kill', async () => {
  const game = await newGame(4);
  await host(game, 'imposter_start_game');
  await setImpostors(game, [0]);
  await assert.rejects(
    rpc('imposter_kill_player', { p_code: game.code, p_host_secret: secret(), p_player: game.players[1].id }),
    /Only the host/,
  );
  await assert.rejects(
    rpc('imposter_kill_player', { p_code: game.code, p_host_secret: game.players[0].secret, p_player: game.players[1].id }),
    /Only the host/,
  );
});

test('kills can end the game, like votes do', async () => {
  const crewGone = await newGame(4);
  await host(crewGone, 'imposter_start_game');
  await setImpostors(crewGone, [0]);
  await kill(crewGone, 1);
  assert.equal((await state(crewGone)).phase, 'ready');
  await kill(crewGone, 2);
  const lost = await state(crewGone);
  assert.equal(lost.phase, 'over');
  assert.equal(lost.winner, 'impostors');
  assert.deepEqual(lost.impostorIds, [crewGone.players[0].id]);
  await assert.rejects(host(crewGone, 'imposter_start_vote'), /can't start a vote/);

  const impostorGone = await newGame(4);
  await host(impostorGone, 'imposter_start_game');
  await setImpostors(impostorGone, [0]);
  await kill(impostorGone, 0);
  assert.equal((await state(impostorGone)).winner, 'crew');
});

test('a kill between rounds removes the player from a waiting runoff', async () => {
  const game = await startVoting(6);
  await castAll(game, [[0, 1], [3, 1], [1, 2], [4, 2], [2, 0], [5, 3]]);
  assert.equal((await state(game)).result.runoffIds.length, 2);

  await kill(game, 1);
  await host(game, 'imposter_start_vote');
  const next = await state(game);
  assert.equal(next.inRunoff, false);
  assert.equal(next.candidateIds, null);
  assert.equal(next.activeCount, 5);
});

test('the vote count travels on the game row, and starts over each round', async () => {
  const game = await startVoting(4);
  const count = async () => (await db.query('select vote_count from imposter_games where code = $1', [game.code])).rows[0].vote_count;
  assert.equal(await count(), 0);

  await vote(game, 0, 1);
  assert.equal(await count(), 1);
  await vote(game, 2, 1);
  assert.equal(await count(), 2);
  await castAll(game, [[3, 1], [1, 0]]);
  assert.equal((await state(game)).phase, 'result');
  assert.equal(await count(), 4);

  await host(game, 'imposter_start_vote');
  assert.equal(await count(), 0);
});

test('players stay marked as online when they refresh often', async () => {
  const game = await newGame(3);
  for (let i = 0; i < 3; i++) await state(game, 0);
  const after = await state(game, 0);
  assert.equal(after.meId, game.players[0].id);
  assert.equal(after.players[0].connected, true);
});

test('a player sees their own role once the impostors are saved, and impostors see each other', async () => {
  const game = await newGame(5);
  await host(game, 'imposter_start_game');
  assert.equal((await state(game, 0)).myRole, null, 'no role before the host has picked');

  await setImpostors(game, [1, 3]);
  const crew = await state(game, 0);
  assert.equal(crew.myRole, 'crew');
  assert.equal(crew.mates, null);
  assert.equal(crew.impostorIds, null);

  const first = await state(game, 1);
  assert.equal(first.myRole, 'impostor');
  assert.deepEqual(first.mates, [game.players[3].id]);
  assert.deepEqual((await state(game, 3)).mates, [game.players[1].id]);

  // Nobody learns anything without their own key
  const nobody = await state(game);
  assert.equal(nobody.myRole, null);
  assert.equal(nobody.mates, null);
  assert.equal(nobody.impostorIds, null);
});

test('a lone impostor has no team mates, and a new pick changes the roles', async () => {
  const game = await newGame(4);
  await host(game, 'imposter_start_game');
  await setImpostors(game, [2]);
  const lone = await state(game, 2);
  assert.equal(lone.myRole, 'impostor');
  assert.deepEqual(lone.mates, []);
  assert.equal((await state(game, 0)).myRole, 'crew');

  await setImpostors(game, [0]);
  assert.equal((await state(game, 2)).myRole, 'crew');
  assert.equal((await state(game, 0)).myRole, 'impostor');
});
