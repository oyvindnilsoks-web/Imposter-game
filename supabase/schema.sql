-- Imposter game: database for Supabase.
--
-- Run this whole file once in the Supabase SQL editor (Dashboard -> SQL Editor).
-- It is safe to run again later: it only creates what is missing and replaces the functions.
--
-- How it is locked down:
--   * The browser never touches the tables directly. The only table it may read is
--     imposter_games (code, phase, round, result), so Realtime can tell it "something changed".
--   * Everything else goes through the imposter_* functions below. They check the host key or
--     the player key, so nobody can vote for someone else or see who voted for whom.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists imposter_games (
  code text primary key,
  phase text not null default 'lobby'
    check (phase in ('lobby', 'ready', 'voting', 'result', 'ended')),
  round integer not null default 0,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists imposter_secrets (
  code text primary key references imposter_games (code) on delete cascade,
  host_secret text not null
);

create table if not exists imposter_players (
  id uuid primary key default gen_random_uuid(),
  game_code text not null references imposter_games (code) on delete cascade,
  name text not null,
  avatar text not null,
  secret text not null,
  eliminated boolean not null default false,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  unique (game_code, secret)
);

create index if not exists imposter_players_game_idx on imposter_players (game_code);

create table if not exists imposter_votes (
  game_code text not null references imposter_games (code) on delete cascade,
  round integer not null,
  voter_id uuid not null references imposter_players (id) on delete cascade,
  target_id uuid not null references imposter_players (id) on delete cascade,
  primary key (game_code, round, voter_id)
);

-- Added later: impostors, winner and runoff votes. Safe to run again.
alter table imposter_players add column if not exists is_impostor boolean not null default false;
alter table imposter_games add column if not exists winner text;
alter table imposter_games add column if not exists runoff_ids uuid[];
alter table imposter_games add column if not exists candidate_ids uuid[];
alter table imposter_games add column if not exists in_runoff boolean not null default false;
alter table imposter_games add column if not exists killed_ids uuid[];
-- Number of votes so far. It travels with the live update, so screens can show progress without asking again.
alter table imposter_games add column if not exists vote_count integer not null default 0;

-- Keeps the player list in the order people joined, even when two join in the same moment.
alter table imposter_players alter column joined_at set default clock_timestamp();

-- The night: the impostors choose who to kill. night_no counts the nights, night_ends_at is the
-- deadline, and night_result says what happened ({"killedId": ... or null}).
alter table imposter_games add column if not exists night_no integer not null default 0;
alter table imposter_games add column if not exists night_ends_at timestamptz;
alter table imposter_games add column if not exists night_result jsonb;
-- Counts the rounds of play with the same players (New round). Screens use it to start fresh.
alter table imposter_games add column if not exists series integer not null default 0;

alter table imposter_games drop constraint if exists imposter_games_phase_check;
alter table imposter_games add constraint imposter_games_phase_check
  check (phase in ('lobby', 'ready', 'night', 'voting', 'result', 'over', 'ended'));

-- What each impostor wants to kill tonight. Only the impostors can see this (through get_state).
create table if not exists imposter_night_picks (
  game_code text not null references imposter_games (code) on delete cascade,
  impostor_id uuid not null references imposter_players (id) on delete cascade,
  target_id uuid not null references imposter_players (id) on delete cascade,
  primary key (game_code, impostor_id)
);

-- The team pot: crew and players who are out solve English tasks, and the pot unlocks help.
alter table imposter_games add column if not exists pot integer not null default 0;
alter table imposter_games add column if not exists pot_level integer not null default 0;
alter table imposter_games add column if not exists shield_ready boolean not null default false;
alter table imposter_games add column if not exists clue_ids uuid[];
alter table imposter_players add column if not exists current_task integer;

-- The tasks. The answers stay here: the browser only gets the question and the choices.
create table if not exists imposter_tasks (
  id serial primary key,
  kind text not null check (kind in ('choice', 'order')),
  prompt text not null,
  options text[] not null,
  answer text not null,
  unique (prompt, answer)
);

create table if not exists imposter_task_log (
  id bigserial primary key,
  game_code text not null references imposter_games (code) on delete cascade,
  player_id uuid not null references imposter_players (id) on delete cascade,
  task_id integer not null references imposter_tasks (id) on delete cascade,
  round integer not null,
  correct boolean not null,
  counted boolean not null,
  answered_at timestamptz not null default now()
);
create index if not exists imposter_task_log_player_idx on imposter_task_log (game_code, player_id, round);

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------

alter table imposter_games enable row level security;
alter table imposter_secrets enable row level security;
alter table imposter_players enable row level security;
alter table imposter_votes enable row level security;
alter table imposter_night_picks enable row level security;
alter table imposter_tasks enable row level security;
alter table imposter_task_log enable row level security;

revoke all on imposter_games, imposter_secrets, imposter_players, imposter_votes, imposter_night_picks,
  imposter_tasks, imposter_task_log
  from anon, authenticated;

grant select on imposter_games to anon, authenticated;

drop policy if exists imposter_games_read on imposter_games;
create policy imposter_games_read on imposter_games
  for select to anon, authenticated using (true);

-- Lets the browser get a live "something changed" signal. If Realtime is off, the pages still
-- work: they also check for changes every few seconds.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'imposter_games'
     ) then
    alter publication supabase_realtime add table imposter_games;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable from the browser)
-- ---------------------------------------------------------------------------

create or replace function imposter_normalize_name(p_name text)
returns text
language plpgsql
immutable
as $$
declare
  v_name text;
begin
  v_name := btrim(left(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 20));
  if v_name = '' then
    raise exception 'Please enter your name.';
  end if;
  return v_name;
end;
$$;

-- Finds the game, locks it so votes are counted one at a time, and checks the host key.
create or replace function imposter_lock_host_game(p_code text, p_host_secret text)
returns imposter_games
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game imposter_games;
begin
  select * into v_game from imposter_games where code = upper(btrim(p_code)) for update;
  if not found then
    raise exception 'Game not found. Check the code.';
  end if;
  if p_host_secret is null or not exists (
    select 1 from imposter_secrets s where s.code = v_game.code and s.host_secret = p_host_secret
  ) then
    raise exception 'Only the host can do this.';
  end if;
  return v_game;
end;
$$;

-- Counts the votes, crosses out the player with the most votes, and shows the result.
-- A tie (or no votes at all) means nobody is voted out.
create or replace function imposter_close_vote_internal(p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game imposter_games;
  v_counts jsonb := '{}'::jsonb;
  v_max bigint := 0;
  v_leaders uuid[];
  v_tie boolean;
  v_out uuid;
  v_cast integer;
  v_runoff uuid[];
  v_phase text := 'result';
  v_winner text;
  v_crew integer;
  v_impostors integer;
  r record;
begin
  select * into v_game from imposter_games where code = p_code;

  -- Only the candidates are counted (everyone in a normal round, the tied players in a runoff).
  for r in
    select p.id,
           (select count(*) from imposter_votes v
             where v.game_code = v_game.code and v.round = v_game.round and v.target_id = p.id) as n
      from imposter_players p
     where p.game_code = v_game.code and not p.eliminated
       and (v_game.candidate_ids is null or p.id = any(v_game.candidate_ids))
  loop
    v_counts := v_counts || jsonb_build_object(r.id::text, r.n);
    if r.n > v_max then
      v_max := r.n;
    end if;
  end loop;

  select array_agg(key::uuid) into v_leaders
    from jsonb_each_text(v_counts)
   where value::bigint = v_max;

  v_tie := v_max = 0 or coalesce(array_length(v_leaders, 1), 0) <> 1;
  v_out := case when v_tie then null else v_leaders[1] end;

  -- A tie means a runoff between the tied players. A tie in the runoff itself, or no votes at all,
  -- means nobody is out and the next vote is a normal one.
  if v_tie and v_max > 0 and not v_game.in_runoff then
    v_runoff := v_leaders;
  end if;

  if v_out is not null then
    update imposter_players set eliminated = true where id = v_out;

    -- The crew wins when all impostors are out. The impostors win when they are as many as the crew.
    select count(*) filter (where not is_impostor), count(*) filter (where is_impostor)
      into v_crew, v_impostors
      from imposter_players where game_code = v_game.code and not eliminated;
    if v_impostors = 0 then
      v_phase := 'over';
      v_winner := 'crew';
    elsif v_impostors >= v_crew then
      v_phase := 'over';
      v_winner := 'impostors';
    end if;
  end if;

  select count(*) into v_cast
    from imposter_votes where game_code = v_game.code and round = v_game.round;

  update imposter_games
     set phase = v_phase,
         winner = v_winner,
         runoff_ids = v_runoff,
         killed_ids = null,
         night_result = null,
         vote_count = v_cast,
         result = jsonb_build_object(
           'round', v_game.round,
           'counts', v_counts,
           'eliminatedId', v_out,
           'tie', v_tie,
           'votesCast', v_cast,
           'runoffIds', to_jsonb(v_runoff)
         ),
         updated_at = now()
   where code = v_game.code;
end;
$$;

-- ---------------------------------------------------------------------------
-- Functions the browser calls
-- ---------------------------------------------------------------------------

-- Host: make a new game. Returns the 4-letter game code.
create or replace function imposter_create_game(p_host_secret text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  c_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  i integer;
begin
  if p_host_secret is null or length(p_host_secret) < 16 then
    raise exception 'Invalid host key. Reload the page.';
  end if;

  -- Old games clean themselves up.
  delete from imposter_games where updated_at < now() - interval '1 day';

  loop
    v_code := '';
    for i in 1..4 loop
      v_code := v_code || substr(c_alphabet, 1 + floor(random() * length(c_alphabet))::integer, 1);
    end loop;
    exit when not exists (select 1 from imposter_games where code = v_code);
  end loop;

  insert into imposter_games (code) values (v_code);
  insert into imposter_secrets (code, host_secret) values (v_code, p_host_secret);
  return v_code;
end;
$$;

-- Player: join the lobby. Joining again with the same key just returns the same player.
create or replace function imposter_join_game(p_code text, p_name text, p_secret text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c_avatars constant text[] := array[
    '🐰', '🦊', '🐻', '🐸', '🐨', '🐯', '🦉', '🐵', '🐼', '🐙', '🦁', '🐧', '🐮', '🐷', '🦄', '🐊'
  ];
  v_game imposter_games;
  v_player imposter_players;
  v_name text;
  v_count integer;
begin
  if p_secret is null or length(p_secret) < 16 then
    raise exception 'Invalid player. Reload the page.';
  end if;

  select * into v_game from imposter_games where code = upper(btrim(p_code)) for update;
  if not found then
    raise exception 'Game not found. Check the code.';
  end if;

  select * into v_player from imposter_players
   where game_code = v_game.code and secret = p_secret;
  if found then
    update imposter_players set last_seen = now() where id = v_player.id;
    return jsonb_build_object('playerId', v_player.id, 'code', v_game.code);
  end if;

  if v_game.phase <> 'lobby' then
    raise exception 'The game has already started.';
  end if;

  select count(*) into v_count from imposter_players where game_code = v_game.code;
  if v_count >= 40 then
    raise exception 'The game is full.';
  end if;

  v_name := imposter_normalize_name(p_name);
  if exists (
    select 1 from imposter_players where game_code = v_game.code and lower(name) = lower(v_name)
  ) then
    raise exception 'That name is taken. Please pick another one.';
  end if;

  insert into imposter_players (game_code, name, avatar, secret)
  values (v_game.code, v_name, c_avatars[1 + (v_count % array_length(c_avatars, 1))], p_secret)
  returning * into v_player;

  update imposter_games set updated_at = now() where code = v_game.code;
  return jsonb_build_object('playerId', v_player.id, 'code', v_game.code);
end;
$$;

-- Host: start the game (needs at least 3 players).
create or replace function imposter_start_game(p_code text, p_host_secret text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game imposter_games := imposter_lock_host_game(p_code, p_host_secret);
begin
  if v_game.phase <> 'lobby' then
    raise exception 'The game has already started.';
  end if;
  if (select count(*) from imposter_players where game_code = v_game.code) < 3 then
    raise exception 'You need at least 3 players to start.';
  end if;
  update imposter_games set phase = 'ready', updated_at = now() where code = v_game.code;
end;
$$;

-- Host: pick the impostors. Only possible before the first vote.
create or replace function imposter_set_impostors(p_code text, p_host_secret text, p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game imposter_games := imposter_lock_host_game(p_code, p_host_secret);
  v_ids uuid[] := coalesce(p_ids, '{}');
begin
  if v_game.phase <> 'ready' then
    raise exception 'You can only pick the impostors before the first vote.';
  end if;
  if exists (
    select 1 from unnest(v_ids) as x(id)
     where not exists (select 1 from imposter_players p where p.id = x.id and p.game_code = v_game.code)
  ) then
    raise exception 'Invalid choice.';
  end if;
  update imposter_players set is_impostor = (id = any(v_ids)) where game_code = v_game.code;
  update imposter_games set updated_at = now() where code = v_game.code;
end;
$$;

-- Host: open the vote for the next round. After a tie it is a runoff between the tied players.
create or replace function imposter_start_vote(p_code text, p_host_secret text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game imposter_games := imposter_lock_host_game(p_code, p_host_secret);
  v_impostors integer;
  v_crew integer;
begin
  if v_game.phase not in ('ready', 'result') then
    raise exception 'You can''t start a vote now.';
  end if;

  if v_game.phase = 'ready' then
    select count(*) filter (where is_impostor), count(*) filter (where not is_impostor)
      into v_impostors, v_crew
      from imposter_players where game_code = v_game.code;
    if v_impostors < 1 then
      raise exception 'Pick at least one impostor first.';
    end if;
    if v_impostors >= v_crew then
      raise exception 'There must be more crew than impostors.';
    end if;
  end if;

  if (select count(*) from imposter_players where game_code = v_game.code and not eliminated) < 2 then
    raise exception 'At least two players must be left to vote.';
  end if;

  update imposter_games
     set phase = 'voting',
         round = round + 1,
         result = null,
         candidate_ids = v_game.runoff_ids,
         in_runoff = v_game.runoff_ids is not null,
         vote_count = 0,
         runoff_ids = null,
         night_result = null,
         updated_at = now()
   where code = v_game.code;
end;
$$;

-- Marks a player as killed. It counts like a player being out, and it can end the game.
-- p_phase is the phase to go back to when the game is not over.
create or replace function imposter_kill_internal(p_code text, p_player uuid, p_phase text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game imposter_games;
  v_crew integer;
  v_impostors integer;
  v_phase text := p_phase;
  v_winner text;
  v_runoff uuid[];
begin
  select * into v_game from imposter_games where code = p_code;
  update imposter_players set eliminated = true where id = p_player;

  select count(*) filter (where not is_impostor), count(*) filter (where is_impostor)
    into v_crew, v_impostors
    from imposter_players where game_code = v_game.code and not eliminated;
  if v_impostors = 0 then
    v_phase := 'over';
    v_winner := 'crew';
  elsif v_impostors >= v_crew then
    v_phase := 'over';
    v_winner := 'impostors';
  end if;

  -- A waiting runoff loses a candidate. With fewer than two left, the next vote is a normal one.
  v_runoff := array_remove(v_game.runoff_ids, p_player);
  if coalesce(array_length(v_runoff, 1), 0) < 2 then
    v_runoff := null;
  end if;

  update imposter_games
     set phase = v_phase,
         winner = v_winner,
         runoff_ids = v_runoff,
         killed_ids = coalesce(killed_ids, '{}') || p_player,
         updated_at = now()
   where code = v_game.code;
end;
$$;

-- Host: mark a player as killed. Used between rounds, before the next vote, for the one the
-- impostors got rid of (when the night is not played on the phones).
create or replace function imposter_kill_player(p_code text, p_host_secret text, p_player uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game imposter_games := imposter_lock_host_game(p_code, p_host_secret);
  v_target imposter_players;
begin
  if v_game.phase not in ('ready', 'result') then
    raise exception 'You can only mark a kill before a vote.';
  end if;
  if not exists (select 1 from imposter_players where game_code = v_game.code and is_impostor) then
    raise exception 'Pick the impostors first.';
  end if;

  select * into v_target from imposter_players where id = p_player and game_code = v_game.code;
  if not found or v_target.eliminated then
    raise exception 'Invalid choice.';
  end if;

  perform imposter_kill_internal(v_game.code, v_target.id, v_game.phase);
end;
$$;

-- Ends the night. The player most impostors picked is killed, but only when more than half of the
-- impostors still in the game picked that same player. Otherwise nobody is killed.
create or replace function imposter_close_night_internal(p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game imposter_games;
  v_alive integer;
  v_target uuid;
  v_back text;
  v_shielded boolean := false;
begin
  select * into v_game from imposter_games where code = p_code;
  select count(*) into v_alive
    from imposter_players where game_code = v_game.code and is_impostor and not eliminated;

  select n.target_id into v_target
    from imposter_night_picks n
    join imposter_players i on i.id = n.impostor_id and not i.eliminated
    join imposter_players t on t.id = n.target_id and not t.eliminated and not t.is_impostor
   where n.game_code = v_game.code
   group by n.target_id
  having count(*) * 2 > v_alive
   limit 1;

  -- A shield from the pot stops the kill, once.
  if v_target is not null and v_game.shield_ready then
    v_target := null;
    v_shielded := true;
  end if;

  v_back := case when v_game.round > 0 then 'result' else 'ready' end;
  delete from imposter_night_picks where game_code = v_game.code;

  update imposter_games
     set phase = v_back,
         night_ends_at = null,
         night_result = jsonb_build_object('night', v_game.night_no, 'killedId', v_target, 'shielded', v_shielded),
         shield_ready = shield_ready and not v_shielded,
         updated_at = now()
   where code = v_game.code;

  if v_target is not null then
    perform imposter_kill_internal(v_game.code, v_target, v_back);
  end if;
end;
$$;

-- Host: start the night. The impostors choose who to kill, in the time given.
create or replace function imposter_start_night(p_code text, p_host_secret text, p_seconds integer default 60)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game imposter_games := imposter_lock_host_game(p_code, p_host_secret);
  v_impostors integer;
  v_crew integer;
begin
  if v_game.phase not in ('ready', 'result') then
    raise exception 'You can''t start the night now.';
  end if;

  select count(*) filter (where is_impostor and not eliminated), count(*) filter (where not is_impostor and not eliminated)
    into v_impostors, v_crew
    from imposter_players where game_code = v_game.code;
  if not exists (select 1 from imposter_players where game_code = v_game.code and is_impostor) then
    raise exception 'Pick the impostors first.';
  end if;
  if v_impostors >= v_crew then
    raise exception 'There must be more crew than impostors.';
  end if;

  delete from imposter_night_picks where game_code = v_game.code;
  update imposter_games
     set phase = 'night',
         night_no = night_no + 1,
         night_ends_at = now() + make_interval(secs => greatest(15, least(coalesce(p_seconds, 60), 300))),
         night_result = null,
         updated_at = now()
   where code = v_game.code;
end;
$$;

-- Impostor: say who you want to kill tonight. You can change it until the night ends.
-- The night ends early when more than half of the impostors have picked the same player.
create or replace function imposter_night_pick(p_code text, p_secret text, p_target uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game imposter_games;
  v_me imposter_players;
  v_target imposter_players;
  v_alive integer;
  v_picked integer;
  v_top integer;
begin
  select * into v_game from imposter_games where code = upper(btrim(p_code)) for update;
  if not found then
    raise exception 'Game not found. Check the code.';
  end if;
  if v_game.phase <> 'night' or v_game.night_ends_at < now() then
    raise exception 'It is not night.';
  end if;

  select * into v_me from imposter_players where game_code = v_game.code and secret = p_secret;
  if not found or not v_me.is_impostor or v_me.eliminated then
    raise exception 'Only the impostors can choose.';
  end if;

  select * into v_target from imposter_players where id = p_target and game_code = v_game.code;
  if not found or v_target.eliminated or v_target.is_impostor then
    raise exception 'Invalid choice.';
  end if;

  insert into imposter_night_picks (game_code, impostor_id, target_id)
  values (v_game.code, v_me.id, v_target.id)
  on conflict (game_code, impostor_id) do update set target_id = excluded.target_id;

  select count(*) into v_alive
    from imposter_players where game_code = v_game.code and is_impostor and not eliminated;
  select count(*), coalesce(max(c), 0) into v_picked, v_top from (
    select count(*) as c from imposter_night_picks where game_code = v_game.code group by target_id
  ) x;

  -- Everyone has chosen and most agree: no reason to wait.
  if (select count(*) from imposter_night_picks where game_code = v_game.code) >= v_alive and v_top * 2 > v_alive then
    perform imposter_close_night_internal(v_game.code);
  else
    update imposter_games set updated_at = now() where code = v_game.code;
  end if;
end;
$$;

-- Host: end the night now.
create or replace function imposter_close_night(p_code text, p_host_secret text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game imposter_games := imposter_lock_host_game(p_code, p_host_secret);
begin
  if v_game.phase <> 'night' then
    raise exception 'It is not night.';
  end if;
  perform imposter_close_night_internal(v_game.code);
end;
$$;

-- Player: vote for someone. The vote closes by itself when everyone still in the game has voted.
create or replace function imposter_cast_vote(p_code text, p_secret text, p_target uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game imposter_games;
  v_voter imposter_players;
  v_target imposter_players;
  v_votes integer;
  v_active integer;
begin
  select * into v_game from imposter_games where code = upper(btrim(p_code)) for update;
  if not found then
    raise exception 'Game not found. Check the code.';
  end if;
  if v_game.phase <> 'voting' then
    raise exception 'There is no open vote.';
  end if;

  select * into v_voter from imposter_players
   where game_code = v_game.code and secret = p_secret;
  if not found or v_voter.eliminated then
    raise exception 'You are not in this vote.';
  end if;

  select * into v_target from imposter_players
   where id = p_target and game_code = v_game.code;
  if not found or v_target.eliminated then
    raise exception 'Invalid choice.';
  end if;
  if v_target.id = v_voter.id then
    raise exception 'You can''t vote for yourself.';
  end if;
  if v_game.candidate_ids is not null and not (v_target.id = any(v_game.candidate_ids)) then
    raise exception 'You can only vote for the players who tied.';
  end if;

  if exists (
    select 1 from imposter_votes
     where game_code = v_game.code and round = v_game.round and voter_id = v_voter.id
  ) then
    raise exception 'You have already voted.';
  end if;

  insert into imposter_votes (game_code, round, voter_id, target_id)
  values (v_game.code, v_game.round, v_voter.id, v_target.id);

  select count(*) into v_votes
    from imposter_votes where game_code = v_game.code and round = v_game.round;
  select count(*) into v_active
    from imposter_players where game_code = v_game.code and not eliminated;

  if v_votes >= v_active then
    perform imposter_close_vote_internal(v_game.code);
  else
    update imposter_games set vote_count = v_votes, updated_at = now() where code = v_game.code;
  end if;
end;
$$;

-- Host: close the vote now (for example when someone lost their connection).
create or replace function imposter_close_vote(p_code text, p_host_secret text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game imposter_games := imposter_lock_host_game(p_code, p_host_secret);
begin
  if v_game.phase <> 'voting' then
    raise exception 'There is no open vote.';
  end if;
  perform imposter_close_vote_internal(v_game.code);
end;
$$;

-- Host: play again with the same players. Everything starts over in the lobby, and the host picks
-- new impostors after pressing Start. Late players can join in the lobby.
create or replace function imposter_new_round(p_code text, p_host_secret text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game imposter_games := imposter_lock_host_game(p_code, p_host_secret);
begin
  if v_game.phase not in ('over', 'ended') then
    raise exception 'The game is not over yet.';
  end if;

  delete from imposter_votes where game_code = v_game.code;
  delete from imposter_night_picks where game_code = v_game.code;
  delete from imposter_task_log where game_code = v_game.code;
  update imposter_players set eliminated = false, is_impostor = false, current_task = null where game_code = v_game.code;
  update imposter_games
     set phase = 'lobby',
         round = 0,
         result = null,
         winner = null,
         runoff_ids = null,
         candidate_ids = null,
         in_runoff = false,
         killed_ids = null,
         vote_count = 0,
         night_ends_at = null,
         night_result = null,
         pot = 0,
         pot_level = 0,
         shield_ready = false,
         clue_ids = null,
         series = series + 1,
         updated_at = now()
   where code = v_game.code;
end;
$$;

-- Host: end the game for everyone.
create or replace function imposter_end_game(p_code text, p_host_secret text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game imposter_games := imposter_lock_host_game(p_code, p_host_secret);
begin
  update imposter_games set phase = 'ended', result = null, updated_at = now()
   where code = v_game.code;
end;
$$;

-- Who may solve tasks: players who are out (any time the game is on), and crew still in during the night.
create or replace function imposter_can_task(p_phase text, p_eliminated boolean, p_impostor boolean)
returns boolean
language sql
immutable
as $$
  select case
    when p_eliminated then p_phase in ('ready', 'night', 'voting', 'result')
    else p_phase = 'night' and not p_impostor
  end;
$$;

-- Points the pot needs for level 1 and level 2, for a given number of players.
create or replace function imposter_pot_goals(p_players integer)
returns integer[]
language sql
immutable
as $$
  select array[ceil(1.5 * p_players)::integer, ceil(3.5 * p_players)::integer];
$$;

-- Player: get the task to solve. You keep the same task until you have answered it.
create or replace function imposter_next_task(p_code text, p_secret text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game imposter_games;
  v_me imposter_players;
  v_task imposter_tasks;
  v_options text[];
  v_try integer := 0;
begin
  select * into v_game from imposter_games where code = upper(btrim(p_code));
  if not found then
    raise exception 'Game not found. Check the code.';
  end if;
  select * into v_me from imposter_players where game_code = v_game.code and secret = p_secret;
  if not found or not imposter_can_task(v_game.phase, v_me.eliminated, v_me.is_impostor) then
    raise exception 'Tasks are open at night, or when you are out.';
  end if;

  if v_me.current_task is not null then
    select * into v_task from imposter_tasks where id = v_me.current_task;
  end if;
  if v_task.id is null then
    select * into v_task from imposter_tasks t
     where not exists (
       select 1 from imposter_task_log l where l.player_id = v_me.id and l.task_id = t.id
     )
     order by random() limit 1;
    if v_task.id is null then
      select * into v_task from imposter_tasks order by random() limit 1;
    end if;
    update imposter_players set current_task = v_task.id where id = v_me.id;
  end if;

  -- Words to put in order are shuffled, and never come in the right order.
  v_options := (select array_agg(o order by random()) from unnest(v_task.options) o);
  if v_task.kind = 'order' then
    while v_options = v_task.options and v_try < 10 loop
      v_options := (select array_agg(o order by random()) from unnest(v_task.options) o);
      v_try := v_try + 1;
    end loop;
  end if;

  return jsonb_build_object('id', v_task.id, 'kind', v_task.kind, 'prompt', v_task.prompt, 'options', to_jsonb(v_options));
end;
$$;

-- Player: answer the task. A right answer adds a point to the team pot, unless you are an impostor
-- or you have reached the limit for this round. Nobody can tell which answers counted.
create or replace function imposter_answer_task(p_code text, p_secret text, p_task integer, p_answer text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c_cap constant integer := 6;
  v_game imposter_games;
  v_me imposter_players;
  v_task imposter_tasks;
  v_correct boolean;
  v_counted boolean;
  v_capped boolean := false;
  v_goals integer[];
  v_pot integer;
  v_level integer;
  v_clue uuid;
begin
  select * into v_game from imposter_games where code = upper(btrim(p_code)) for update;
  if not found then
    raise exception 'Game not found. Check the code.';
  end if;
  select * into v_me from imposter_players where game_code = v_game.code and secret = p_secret;
  if not found or not imposter_can_task(v_game.phase, v_me.eliminated, v_me.is_impostor) then
    raise exception 'Tasks are open at night, or when you are out.';
  end if;
  if v_me.current_task is distinct from p_task then
    raise exception 'That task is not open any more.';
  end if;

  select * into v_task from imposter_tasks where id = p_task;
  v_correct := lower(regexp_replace(btrim(coalesce(p_answer, '')), '\s+', ' ', 'g')) = lower(v_task.answer);
  v_counted := v_correct and not v_me.is_impostor;
  if v_counted and (
    select count(*) from imposter_task_log
     where game_code = v_game.code and player_id = v_me.id and round = v_game.round and counted
  ) >= c_cap then
    v_counted := false;
    v_capped := true;
  end if;

  insert into imposter_task_log (game_code, player_id, task_id, round, correct, counted)
  values (v_game.code, v_me.id, v_task.id, v_game.round, v_correct, v_counted);
  update imposter_players set current_task = null where id = v_me.id;

  if v_counted then
    v_pot := v_game.pot + 1;
    v_level := v_game.pot_level;
    v_goals := imposter_pot_goals((select count(*) from imposter_players where game_code = v_game.code)::integer);
    while v_level < 2 and v_pot >= v_goals[v_level + 1] loop
      v_level := v_level + 1;
      if v_level = 1 then
        -- Clue: one crew member who is still in is shown to everyone as crew.
        select id into v_clue from imposter_players
         where game_code = v_game.code and not eliminated and not is_impostor
           and not (id = any(coalesce(v_game.clue_ids, '{}')))
         order by random() limit 1;
        if v_clue is not null then
          v_game.clue_ids := coalesce(v_game.clue_ids, '{}') || v_clue;
        end if;
      else
        v_game.shield_ready := true;
      end if;
    end loop;
    update imposter_games
       set pot = v_pot, pot_level = v_level, clue_ids = v_game.clue_ids,
           shield_ready = v_game.shield_ready, updated_at = now()
     where code = v_game.code;
  end if;

  return jsonb_build_object('correct', v_correct, 'answer', v_task.answer, 'capped', v_capped and not v_me.is_impostor);
end;
$$;

-- Everyone: what the screen shows. Never says who voted for whom.
-- If p_secret belongs to a player, also returns that player's id and their own vote,
-- and counts them as online. The impostors are only listed for the host, or once the game is over.
drop function if exists imposter_get_state(text, text);
create or replace function imposter_get_state(
  p_code text,
  p_secret text default null,
  p_host_secret text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game imposter_games;
  v_me uuid;
  v_my_vote uuid;
  v_players jsonb;
  v_active integer;
  v_votes integer;
  v_is_host boolean := false;
  v_impostors jsonb;
  v_roles_set boolean;
  v_my_impostor boolean := false;
  v_mates jsonb;
  v_night jsonb;
  v_picks jsonb;
begin
  select * into v_game from imposter_games where code = upper(btrim(p_code));
  if not found then
    raise exception 'Game not found. Check the code.';
  end if;

  -- The night ends by itself when the time is up, whoever looks first.
  if v_game.phase = 'night' and v_game.night_ends_at < now() then
    select * into v_game from imposter_games where code = v_game.code for update;
    if v_game.phase = 'night' and v_game.night_ends_at < now() then
      perform imposter_close_night_internal(v_game.code);
    end if;
    select * into v_game from imposter_games where code = v_game.code;
  end if;

  if p_secret is not null then
    select id into v_me from imposter_players where game_code = v_game.code and secret = p_secret;
    -- Only write now and then, so many quick refreshes do not turn into many writes.
    update imposter_players set last_seen = now() where id = v_me and last_seen < now() - interval '5 seconds';
  end if;

  if p_host_secret is not null then
    v_is_host := exists (
      select 1 from imposter_secrets s where s.code = v_game.code and s.host_secret = p_host_secret
    );
  end if;

  if v_me is not null and v_game.phase = 'voting' then
    select target_id into v_my_vote from imposter_votes
     where game_code = v_game.code and round = v_game.round and voter_id = v_me;
  end if;

  if v_is_host or v_game.phase = 'over' then
    select coalesce(jsonb_agg(id order by joined_at, id), '[]'::jsonb)
      into v_impostors
      from imposter_players where game_code = v_game.code and is_impostor;
  end if;

  -- A player can see their own role once the host has saved the impostors.
  -- An impostor also sees the other impostors. Nobody else gets any of this.
  select exists (select 1 from imposter_players where game_code = v_game.code and is_impostor)
    into v_roles_set;
  if v_me is not null and v_roles_set then
    select is_impostor into v_my_impostor from imposter_players where id = v_me;
    if v_my_impostor then
      select coalesce(jsonb_agg(id order by joined_at, id), '[]'::jsonb)
        into v_mates
        from imposter_players where game_code = v_game.code and is_impostor and id <> v_me;
    end if;
  end if;

  if v_game.phase = 'night' then
    v_night := jsonb_build_object(
      'endsIn', greatest(0, ceil(extract(epoch from (v_game.night_ends_at - now())))::integer),
      'no', v_game.night_no
    );
    -- The picks are only shown to the impostors who are still in the game.
    if v_my_impostor and exists (select 1 from imposter_players where id = v_me and not eliminated) then
      select coalesce(jsonb_object_agg(impostor_id::text, target_id), '{}'::jsonb)
        into v_picks from imposter_night_picks where game_code = v_game.code;
    end if;
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', id,
             'name', name,
             'avatar', avatar,
             'eliminated', eliminated,
             'connected', last_seen > now() - interval '15 seconds'
           ) order by joined_at, id
         ), '[]'::jsonb)
    into v_players
    from imposter_players where game_code = v_game.code;

  select count(*) into v_active
    from imposter_players where game_code = v_game.code and not eliminated;
  select count(*) into v_votes
    from imposter_votes where game_code = v_game.code and round = v_game.round;

  return jsonb_build_object(
    'code', v_game.code,
    'phase', v_game.phase,
    'round', v_game.round,
    'minPlayers', 3,
    'maxPlayers', 40,
    'players', v_players,
    'activeCount', v_active,
    'voteCount', v_votes,
    'result', v_game.result,
    'winner', v_game.winner,
    'inRunoff', v_game.in_runoff,
    'candidateIds', to_jsonb(v_game.candidate_ids),
    'killedIds', to_jsonb(v_game.killed_ids),
    'impostorIds', v_impostors,
    'meId', v_me,
    'myVote', v_my_vote,
    'myRole', case
      when v_me is null or not v_roles_set then null
      when v_my_impostor then 'impostor'
      else 'crew'
    end,
    'series', v_game.series,
    'pot', case when v_game.phase in ('lobby', 'ended') then null else jsonb_build_object(
      'points', v_game.pot,
      'level', v_game.pot_level,
      'goals', to_jsonb(imposter_pot_goals((select count(*) from imposter_players where game_code = v_game.code)::integer)),
      'shield', v_game.shield_ready
    ) end,
    'clueIds', to_jsonb(v_game.clue_ids),
    'canTask', case when v_me is null then false else (
      select imposter_can_task(v_game.phase, p.eliminated, p.is_impostor) from imposter_players p where p.id = v_me
    ) end,
    'mates', v_mates,
    'night', v_night,
    'nightPicks', v_picks,
    'nightResult', case when v_game.phase in ('ready', 'result') then v_game.night_result else null end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------

revoke all on function imposter_normalize_name(text) from public, anon, authenticated;
revoke all on function imposter_lock_host_game(text, text) from public, anon, authenticated;
revoke all on function imposter_close_vote_internal(text) from public, anon, authenticated;
revoke all on function imposter_kill_internal(text, uuid, text) from public, anon, authenticated;
revoke all on function imposter_close_night_internal(text) from public, anon, authenticated;

revoke all on function imposter_create_game(text) from public;
revoke all on function imposter_join_game(text, text, text) from public;
revoke all on function imposter_start_game(text, text) from public;
revoke all on function imposter_start_vote(text, text) from public;
revoke all on function imposter_cast_vote(text, text, uuid) from public;
revoke all on function imposter_close_vote(text, text) from public;
revoke all on function imposter_end_game(text, text) from public;
revoke all on function imposter_set_impostors(text, text, uuid[]) from public;
revoke all on function imposter_kill_player(text, text, uuid) from public;
revoke all on function imposter_start_night(text, text, integer) from public;
revoke all on function imposter_night_pick(text, text, uuid) from public;
revoke all on function imposter_close_night(text, text) from public;
revoke all on function imposter_next_task(text, text) from public;
revoke all on function imposter_answer_task(text, text, integer, text) from public;
revoke all on function imposter_can_task(text, boolean, boolean) from public, anon, authenticated;
revoke all on function imposter_pot_goals(integer) from public, anon, authenticated;
revoke all on function imposter_new_round(text, text) from public;
revoke all on function imposter_get_state(text, text, text) from public;

grant execute on function imposter_create_game(text) to anon, authenticated;
grant execute on function imposter_join_game(text, text, text) to anon, authenticated;
grant execute on function imposter_start_game(text, text) to anon, authenticated;
grant execute on function imposter_start_vote(text, text) to anon, authenticated;
grant execute on function imposter_cast_vote(text, text, uuid) to anon, authenticated;
grant execute on function imposter_close_vote(text, text) to anon, authenticated;
grant execute on function imposter_end_game(text, text) to anon, authenticated;
grant execute on function imposter_set_impostors(text, text, uuid[]) to anon, authenticated;
grant execute on function imposter_kill_player(text, text, uuid) to anon, authenticated;
grant execute on function imposter_get_state(text, text, text) to anon, authenticated;
grant execute on function imposter_start_night(text, text, integer) to anon, authenticated;
grant execute on function imposter_night_pick(text, text, uuid) to anon, authenticated;
grant execute on function imposter_close_night(text, text) to anon, authenticated;
grant execute on function imposter_new_round(text, text) to anon, authenticated;
grant execute on function imposter_next_task(text, text) to anon, authenticated;
grant execute on function imposter_answer_task(text, text, integer, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tasks (A1-A2). Safe to run again: tasks that already exist are skipped.
-- ---------------------------------------------------------------------------

insert into imposter_tasks (kind, prompt, options, answer) values
  ('choice', 'Which word means the opposite of big?', array['small', 'tall', 'long', 'old'], 'small'),
  ('choice', 'Which word means the opposite of hot?', array['cold', 'warm', 'wet', 'dry'], 'cold'),
  ('choice', 'Which word means the opposite of happy?', array['sad', 'glad', 'kind', 'tired'], 'sad'),
  ('choice', 'Which word means the opposite of fast?', array['slow', 'quick', 'late', 'loud'], 'slow'),
  ('choice', 'Which word means the opposite of new?', array['old', 'young', 'good', 'nice'], 'old'),
  ('choice', 'Which word means a place where you buy food?', array['shop', 'school', 'park', 'bank'], 'shop'),
  ('choice', 'Which word means the animal that says ''meow''?', array['cat', 'dog', 'cow', 'pig'], 'cat'),
  ('choice', 'Which word means the color of the sky on a sunny day?', array['blue', 'green', 'red', 'black'], 'blue'),
  ('choice', 'Which word means the day after Monday?', array['Tuesday', 'Sunday', 'Friday', 'Thursday'], 'Tuesday'),
  ('choice', 'Which word means the meal in the morning?', array['breakfast', 'dinner', 'supper', 'lunch'], 'breakfast'),
  ('choice', 'Which word means a person who teaches you?', array['teacher', 'doctor', 'driver', 'farmer'], 'teacher'),
  ('choice', 'Which word means your mother''s sister?', array['aunt', 'uncle', 'cousin', 'niece'], 'aunt'),
  ('choice', 'Which word means 12 months?', array['year', 'week', 'day', 'month'], 'year'),
  ('choice', 'Which word do you use to write? (a tool)', array['pen', 'cup', 'key', 'bag'], 'pen'),
  ('choice', 'Which word means the season after summer?', array['autumn', 'winter', 'spring', 'holiday'], 'autumn'),
  ('choice', 'Which word is a fruit?', array['banana', 'carrot', 'potato', 'onion'], 'banana'),
  ('choice', 'Which word is a vegetable?', array['carrot', 'apple', 'orange', 'grape'], 'carrot'),
  ('choice', 'Which word is a kind of weather?', array['rain', 'road', 'ring', 'rock'], 'rain'),
  ('choice', 'Which word is a part of your body?', array['elbow', 'table', 'window', 'pencil'], 'elbow'),
  ('choice', 'She ___ to school every day.', array['goes', 'go', 'going', 'gone'], 'goes'),
  ('choice', 'I ___ a banana for lunch.', array['eat', 'eats', 'eating', 'eaten'], 'eat'),
  ('choice', 'They ___ football on Saturdays.', array['play', 'plays', 'playing', 'played'], 'play'),
  ('choice', 'He ___ a blue bike.', array['has', 'have', 'having', 'haves'], 'has'),
  ('choice', 'We ___ at home yesterday.', array['were', 'are', 'is', 'be'], 'were'),
  ('choice', 'There ___ three books on the table.', array['are', 'is', 'am', 'be'], 'are'),
  ('choice', 'My brother ___ my best friend.', array['is', 'are', 'am', 'be'], 'is'),
  ('choice', 'I ___ not like fish.', array['do', 'does', 'am', 'is'], 'do'),
  ('choice', '___ you like pizza?', array['Do', 'Does', 'Are', 'Is'], 'Do'),
  ('choice', 'What ___ she doing now?', array['is', 'are', 'do', 'does'], 'is'),
  ('choice', 'This is ___ apple.', array['an', 'a', 'the', 'two'], 'an'),
  ('choice', 'I have two ___.', array['brothers', 'brother', 'brotheres', 'brotheras'], 'brothers'),
  ('choice', 'The cat is ___ the box.', array['in', 'at', 'on the', 'to'], 'in'),
  ('choice', 'The book is ___ the table.', array['on', 'in', 'at', 'to'], 'on'),
  ('choice', 'School starts ___ eight o''clock.', array['at', 'on', 'in', 'to'], 'at'),
  ('choice', 'My birthday is ___ June.', array['in', 'on', 'at', 'to'], 'in'),
  ('choice', 'I was born ___ Monday.', array['on', 'in', 'at', 'to'], 'on'),
  ('choice', 'Yesterday I ___ to the cinema.', array['went', 'go', 'goes', 'gone'], 'went'),
  ('choice', 'Last week we ___ a big cake.', array['made', 'make', 'makes', 'making'], 'made'),
  ('choice', 'Tom is taller ___ Sam.', array['than', 'then', 'that', 'as'], 'than'),
  ('choice', 'This is the ___ book I have ever read.', array['best', 'good', 'better', 'goodest'], 'best'),
  ('choice', 'How ___ apples do you have?', array['many', 'much', 'lot', 'any'], 'many'),
  ('choice', 'How ___ milk do you want?', array['much', 'many', 'lot', 'few'], 'much'),
  ('choice', 'Which is the correct spelling?', array['friend', 'freind', 'frend', 'friand'], 'friend'),
  ('choice', 'Which is the correct spelling?', array['because', 'becuase', 'becouse', 'becaus'], 'because'),
  ('choice', 'Which is the correct spelling?', array['beautiful', 'beutiful', 'beautifull', 'butiful'], 'beautiful'),
  ('choice', 'Which is the correct spelling?', array['school', 'scool', 'shcool', 'skool'], 'school'),
  ('choice', 'Which is the correct spelling?', array['Wednesday', 'Wensday', 'Wendsday', 'Wedensday'], 'Wednesday'),
  ('choice', 'What do you say in the morning?', array['Good morning', 'Good night', 'Goodbye', 'See you'], 'Good morning'),
  ('choice', 'What do you say when you meet someone?', array['Nice to meet you', 'See you later', 'Good night', 'I am fine'], 'Nice to meet you'),
  ('choice', 'What do you say when someone gives you a gift?', array['Thank you', 'You are welcome', 'Excuse me', 'I am sorry'], 'Thank you'),
  ('choice', 'Someone asks ''How are you?''. What do you say?', array['I''m fine, thanks', 'I''m twelve', 'It''s Monday', 'Yes, please'], 'I''m fine, thanks'),
  ('choice', 'Someone asks ''What''s your name?''. What do you say?', array['My name is Anna', 'I am from Oslo', 'I am ten', 'It''s red'], 'My name is Anna'),
  ('choice', 'Someone asks ''Where are you from?''. What do you say?', array['I''m from Norway', 'I''m fine', 'I''m ten', 'I like it'], 'I''m from Norway'),
  ('choice', 'Which word is a verb?', array['run', 'red', 'road', 'rich'], 'run'),
  ('choice', 'Which word is an adjective?', array['happy', 'table', 'walk', 'quickly'], 'happy'),
  ('choice', 'Which word is a noun?', array['window', 'open', 'slowly', 'green'], 'window'),
  ('choice', 'Which sentence is correct?', array['She doesn''t like milk.', 'She don''t like milk.', 'She not like milk.', 'She doesn''t likes milk.'], 'She doesn''t like milk.'),
  ('choice', 'Which sentence is correct?', array['There are many students here.', 'There is many students here.', 'There be many students here.', 'There are much students here.'], 'There are many students here.'),
  ('choice', 'Which sentence is correct?', array['I can swim very well.', 'I can swimming very well.', 'I cans swim very well.', 'I can to swim very well.'], 'I can swim very well.'),
  ('order', 'Put the words in the right order.', array['He', 'plays', 'football', 'after', 'school.'], 'He plays football after school.'),
  ('order', 'Put the words in the right order.', array['I', 'like', 'to', 'read', 'books.'], 'I like to read books.'),
  ('order', 'Put the words in the right order.', array['My', 'sister', 'has', 'a', 'red', 'bag.'], 'My sister has a red bag.'),
  ('order', 'Put the words in the right order.', array['We', 'go', 'to', 'school', 'by', 'bus.'], 'We go to school by bus.'),
  ('order', 'Put the words in the right order.', array['The', 'cat', 'is', 'under', 'the', 'table.'], 'The cat is under the table.'),
  ('order', 'Put the words in the right order.', array['She', 'is', 'eating', 'an', 'apple.'], 'She is eating an apple.'),
  ('order', 'Put the words in the right order.', array['They', 'are', 'playing', 'in', 'the', 'park.'], 'They are playing in the park.'),
  ('order', 'Put the words in the right order.', array['I', 'have', 'two', 'brothers', 'and', 'one', 'sister.'], 'I have two brothers and one sister.'),
  ('order', 'Put the words in the right order.', array['Do', 'you', 'like', 'ice', 'cream?'], 'Do you like ice cream?'),
  ('order', 'Put the words in the right order.', array['What', 'is', 'your', 'name?'], 'What is your name?'),
  ('order', 'Put the words in the right order.', array['Where', 'do', 'you', 'live?'], 'Where do you live?'),
  ('order', 'Put the words in the right order.', array['My', 'birthday', 'is', 'in', 'June.'], 'My birthday is in June.'),
  ('order', 'Put the words in the right order.', array['It', 'is', 'raining', 'today.'], 'It is raining today.'),
  ('order', 'Put the words in the right order.', array['The', 'dog', 'runs', 'very', 'fast.'], 'The dog runs very fast.'),
  ('order', 'Put the words in the right order.', array['We', 'eat', 'dinner', 'at', 'six', 'o''clock.'], 'We eat dinner at six o''clock.'),
  ('order', 'Put the words in the right order.', array['Can', 'you', 'help', 'me,', 'please?'], 'Can you help me, please?'),
  ('order', 'Put the words in the right order.', array['There', 'is', 'a', 'book', 'on', 'the', 'desk.'], 'There is a book on the desk.'),
  ('order', 'Put the words in the right order.', array['He', 'does', 'not', 'like', 'fish.'], 'He does not like fish.'),
  ('order', 'Put the words in the right order.', array['Yesterday', 'we', 'went', 'to', 'the', 'beach.'], 'Yesterday we went to the beach.'),
  ('order', 'Put the words in the right order.', array['I', 'am', 'from', 'Norway.'], 'I am from Norway.')
on conflict (prompt, answer) do nothing;
