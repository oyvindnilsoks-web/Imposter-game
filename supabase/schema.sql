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

-- Keeps the player list in the order people joined, even when two join in the same moment.
alter table imposter_players alter column joined_at set default clock_timestamp();

alter table imposter_games drop constraint if exists imposter_games_phase_check;
alter table imposter_games add constraint imposter_games_phase_check
  check (phase in ('lobby', 'ready', 'voting', 'result', 'over', 'ended'));

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------

alter table imposter_games enable row level security;
alter table imposter_secrets enable row level security;
alter table imposter_players enable row level security;
alter table imposter_votes enable row level security;

revoke all on imposter_games, imposter_secrets, imposter_players, imposter_votes
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
         runoff_ids = null,
         updated_at = now()
   where code = v_game.code;
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
    update imposter_games set updated_at = now() where code = v_game.code;
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
begin
  select * into v_game from imposter_games where code = upper(btrim(p_code));
  if not found then
    raise exception 'Game not found. Check the code.';
  end if;

  if p_secret is not null then
    update imposter_players set last_seen = now()
     where game_code = v_game.code and secret = p_secret
    returning id into v_me;
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
    'impostorIds', v_impostors,
    'meId', v_me,
    'myVote', v_my_vote
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------

revoke all on function imposter_normalize_name(text) from public, anon, authenticated;
revoke all on function imposter_lock_host_game(text, text) from public, anon, authenticated;
revoke all on function imposter_close_vote_internal(text) from public, anon, authenticated;

revoke all on function imposter_create_game(text) from public;
revoke all on function imposter_join_game(text, text, text) from public;
revoke all on function imposter_start_game(text, text) from public;
revoke all on function imposter_start_vote(text, text) from public;
revoke all on function imposter_cast_vote(text, text, uuid) from public;
revoke all on function imposter_close_vote(text, text) from public;
revoke all on function imposter_end_game(text, text) from public;
revoke all on function imposter_set_impostors(text, text, uuid[]) from public;
revoke all on function imposter_get_state(text, text, text) from public;

grant execute on function imposter_create_game(text) to anon, authenticated;
grant execute on function imposter_join_game(text, text, text) to anon, authenticated;
grant execute on function imposter_start_game(text, text) to anon, authenticated;
grant execute on function imposter_start_vote(text, text) to anon, authenticated;
grant execute on function imposter_cast_vote(text, text, uuid) to anon, authenticated;
grant execute on function imposter_close_vote(text, text) to anon, authenticated;
grant execute on function imposter_end_game(text, text) to anon, authenticated;
grant execute on function imposter_set_impostors(text, text, uuid[]) to anon, authenticated;
grant execute on function imposter_get_state(text, text, text) to anon, authenticated;
