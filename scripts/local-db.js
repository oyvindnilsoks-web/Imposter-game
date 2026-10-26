'use strict';

// En lokal Postgres (PGlite) som kjører nøyaktig samme SQL som Supabase.
// Brukes av testene og av `npm run local`, så ingenting her trenger en Supabase-konto.

const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const SCHEMA_FILE = path.join(__dirname, '..', 'supabase', 'schema.sql');

// De samme funksjonene som nettleseren får lov til å kalle i Supabase.
const PUBLIC_FUNCTIONS = new Set([
  'imposter_create_game',
  'imposter_join_game',
  'imposter_start_game',
  'imposter_start_vote',
  'imposter_cast_vote',
  'imposter_close_vote',
  'imposter_end_game',
  'imposter_get_state',
]);

async function createLocalDatabase() {
  const db = new PGlite();
  // Supabase har disse rollene fra før.
  await db.exec('create role anon nologin; create role authenticated nologin;');
  await db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));

  // PGlite har én tilkobling, så kallene tas ett om gangen.
  let queue = Promise.resolve();

  function rpc(name, args = {}) {
    if (!PUBLIC_FUNCTIONS.has(name)) throw new Error(`Unknown function: ${name}`);
    const keys = Object.keys(args).filter((key) => /^p_[a-z_]+$/.test(key));
    const params = keys.map((key, index) => `${key} => $${index + 1}`).join(', ');
    const run = queue.then(() => db.query(`select ${name}(${params}) as result`, keys.map((key) => args[key])));
    queue = run.catch(() => {});
    return run.then(({ rows }) => rows[0].result);
  }

  return { db, rpc };
}

module.exports = { createLocalDatabase, PUBLIC_FUNCTIONS };
