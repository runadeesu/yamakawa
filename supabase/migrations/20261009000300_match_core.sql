-- ============================================================================
-- matches (tables, rules, server-side log validation, lifecycle RPCs)
-- ============================================================================

-- ------------------------------------------------------------------ matches ----
create table public.matches (
  id             uuid primary key default gen_random_uuid(),
  status         text not null default 'lobby' check (status in ('lobby', 'playing', 'finished', 'cancelled')),
  mode           text not null default 'quick' check (mode in ('quick', 'friend')),
  created_at     timestamptz not null default now(),
  ready_deadline timestamptz not null,
  starts_at      timestamptz,
  ends_at        timestamptz,
  finished_at    timestamptz,
  winner_id      uuid references public.players(id) on delete set null,
  result         text check (result in ('win', 'draw', 'void')),
  end_reason     text
);
alter table public.matches enable row level security;

create table public.match_players (
  match_id         uuid not null references public.matches(id) on delete cascade,
  player_id        uuid not null references public.players(id) on delete cascade,
  slot             smallint not null check (slot in (1, 2)),
  ready_at         timestamptz,
  last_progress_at timestamptz,
  progress_score   int not null default 0,
  finished         boolean not null default false,
  eliminated       boolean not null default false,
  final_score      int,
  finish_reason    text check (finish_reason in ('over', 'time', 'lead', 'forfeit')),
  finished_at      timestamptz,
  outcome          text check (outcome in ('win', 'loss', 'draw', 'void')),
  primary key (match_id, player_id),
  unique (match_id, slot)
);
create index match_players_player_idx on public.match_players (player_id, match_id);
alter table public.match_players enable row level security;

-- 両プレイヤー共通の出現順 (サーバーが決める)。参加者は match_get 経由でのみ取得
create table app_private.match_seeds (
  match_id uuid primary key references public.matches(id) on delete cascade,
  piece_seq smallint[] not null
);
alter table app_private.match_seeds enable row level security;

-- 不正なログの提出記録 (調査用)
create table app_private.match_violations (
  id        bigint generated always as identity primary key,
  match_id  uuid not null references public.matches(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  detail    text not null,
  at        timestamptz not null default now()
);
alter table app_private.match_violations enable row level security;

create table app_private.match_queue (
  player_id uuid primary key references public.players(id) on delete cascade,
  joined_at timestamptz not null default now()
);
alter table app_private.match_queue enable row level security;

create or replace function app_private.is_match_member(p_match uuid, p_player uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.match_players where match_id = p_match and player_id = p_player);
$$;

create policy matches_select_member on public.matches for select to authenticated
  using (app_private.is_match_member(id, auth.uid()));
create policy match_players_select_member on public.match_players for select to authenticated
  using (app_private.is_match_member(match_id, auth.uid()));

create table public.match_invites (
  id         uuid primary key default gen_random_uuid(),
  from_id    uuid not null references public.players(id) on delete cascade,
  to_id      uuid not null references public.players(id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  match_id   uuid references public.matches(id) on delete set null,
  constraint match_invites_not_self check (from_id <> to_id)
);
create unique index match_invites_one_pending on public.match_invites (from_id, to_id) where status = 'pending';
create index match_invites_to_idx on public.match_invites (to_id, status);
alter table public.match_invites enable row level security;
create policy match_invites_select_own on public.match_invites for select to authenticated
  using (auth.uid() in (from_id, to_id));

-- --------------------------------------------------------------- constants ----
-- ルール定数。クライアント (src/game/config.ts, levels.ts) と一致させること。
create or replace function app_private.rule_const() returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'duration_ms', 120000,
    'steps_per_sec', 60,
    'level_scores', jsonb_build_array(1, 3, 6, 10, 20, 40, 80, 200),
    'radii', jsonb_build_array(15, 20, 26, 33, 42, 53, 65, 78),
    'drop_score', 1,
    'combo_window_steps', 84,
    'combo_step', 0.5,
    'max_multiplier', 3,
    'min_drop_gap_steps', 27,
    'field_area', 360 * 580,
    'area_slack', 1.3,
    'max_level', 8
  );
$$;

-- ---------------------------------------------------------- log validation ----
-- クライアントが送る対戦ログをサーバー側でルールに照らして検証し、スコアを再計算する。
-- ログ: [[step, kind, arg], ...]   kind 0 = 落下(arg=level), 1 = 合体(arg=生まれたlevel), 2 = ゲームオーバー
-- 物理そのものは再現しない (論理的な整合性・タイミング・出現順・面積の上限を検証する)。
create or replace function app_private.validate_log(p_seq smallint[], p_log jsonb, p_duration_ms int)
returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  k            constant jsonb := app_private.rule_const();
  v_scores     int[];
  v_radii      int[];
  v_counts     int[] := array[0, 0, 0, 0, 0, 0, 0, 0];
  v_area       numeric := 0;
  v_area_max   numeric := (k ->> 'field_area')::numeric * (k ->> 'area_slack')::numeric;
  v_max_steps  int := ceil(p_duration_ms / 1000.0 * (k ->> 'steps_per_sec')::int)::int + 12;
  v_score      int := 0;
  v_drops      int := 0;
  v_combo      int := 0;
  v_last_merge int := -1000000;
  v_last_drop  int := -1000000;
  v_prev       int := 0;
  v_over       boolean := false;
  v_max_level  int := 1;
  v_n          int;
  v_kind       int;
  v_arg        int;
  e            jsonb;
  v_points     numeric;
  v_seq_len    int := coalesce(array_length(p_seq, 1), 0);
begin
  select array_agg(x::int) into v_scores from jsonb_array_elements_text(k -> 'level_scores') x;
  select array_agg(x::int) into v_radii from jsonb_array_elements_text(k -> 'radii') x;

  if p_log is null or jsonb_typeof(p_log) <> 'array' then
    return jsonb_build_object('ok', false, 'reason', 'malformed');
  end if;
  if jsonb_array_length(p_log) > 4000 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_events');
  end if;

  for e in select value from jsonb_array_elements(p_log) loop
    if v_over then
      return jsonb_build_object('ok', false, 'reason', 'event_after_gameover');
    end if;
    if jsonb_typeof(e) <> 'array' or jsonb_array_length(e) <> 3
       or jsonb_typeof(e -> 0) <> 'number' or jsonb_typeof(e -> 1) <> 'number' or jsonb_typeof(e -> 2) <> 'number' then
      return jsonb_build_object('ok', false, 'reason', 'malformed');
    end if;
    v_n := (e ->> 0)::numeric::int;
    v_kind := (e ->> 1)::numeric::int;
    v_arg := (e ->> 2)::numeric::int;
    if (e ->> 0)::numeric <> v_n or v_n < v_prev or v_n > v_max_steps then
      return jsonb_build_object('ok', false, 'reason', 'bad_time');
    end if;
    v_prev := v_n;

    if v_kind = 0 then                                   -- drop
      if v_drops >= v_seq_len or v_arg <> p_seq[v_drops + 1] then
        return jsonb_build_object('ok', false, 'reason', 'bad_piece_order');
      end if;
      if v_n - v_last_drop < (k ->> 'min_drop_gap_steps')::int then
        return jsonb_build_object('ok', false, 'reason', 'drop_too_fast');
      end if;
      v_drops := v_drops + 1;
      v_last_drop := v_n;
      v_counts[v_arg] := v_counts[v_arg] + 1;
      v_area := v_area + pi() * v_radii[v_arg] * v_radii[v_arg];
      v_score := v_score + (k ->> 'drop_score')::int;
    elsif v_kind = 1 then                                -- merge -> level v_arg
      if v_arg < 2 or v_arg > (k ->> 'max_level')::int then
        return jsonb_build_object('ok', false, 'reason', 'bad_level');
      end if;
      if v_counts[v_arg - 1] < 2 then
        return jsonb_build_object('ok', false, 'reason', 'impossible_merge');
      end if;
      v_counts[v_arg - 1] := v_counts[v_arg - 1] - 2;
      v_counts[v_arg] := v_counts[v_arg] + 1;
      v_area := v_area - 2 * pi() * v_radii[v_arg - 1] * v_radii[v_arg - 1] + pi() * v_radii[v_arg] * v_radii[v_arg];
      v_combo := case when v_n - v_last_merge <= (k ->> 'combo_window_steps')::int then v_combo + 1 else 1 end;
      v_last_merge := v_n;
      v_points := v_scores[v_arg] * least((k ->> 'max_multiplier')::numeric, 1 + (k ->> 'combo_step')::numeric * (v_combo - 1));
      v_score := v_score + round(v_points)::int;
      v_max_level := greatest(v_max_level, v_arg);
    elsif v_kind = 2 then                                -- game over
      v_over := true;
    else
      return jsonb_build_object('ok', false, 'reason', 'bad_kind');
    end if;

    if v_area > v_area_max then
      return jsonb_build_object('ok', false, 'reason', 'impossible_state');
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'score', v_score, 'drops', v_drops, 'last_step', v_prev,
                            'over', v_over, 'max_level', v_max_level);
exception when others then
  return jsonb_build_object('ok', false, 'reason', 'malformed');
end $$;

-- ----------------------------------------------------------- match lifecycle ----
-- 待機列の操作 (app_private への DELETE は小さな SQL 関数にまとめる)
create or replace function app_private.dequeue_players(p_a uuid, p_b uuid) returns void
language sql security definer set search_path = '' as $$
  delete from app_private.match_queue where player_id in (p_a, p_b);
$$;

create or replace function app_private.dequeue_player(p_player uuid) returns void
language sql security definer set search_path = '' as $$
  delete from app_private.match_queue where player_id = p_player;
$$;

-- 2分以上待っている古い待機を捨てる
create or replace function app_private.queue_cleanup() returns void
language sql security definer set search_path = '' as $$
  delete from app_private.match_queue where joined_at < clock_timestamp() - interval '2 minutes';
$$;

create or replace function app_private.create_match(p_a uuid, p_b uuid, p_mode text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := gen_random_uuid();
  v_seq smallint[];
begin
  -- piece sequence: 400 levels, same weights as the client (38/30/20/12 percent for levels 1-4)
  select array_agg(case when r < 0.38 then 1 when r < 0.68 then 2 when r < 0.88 then 3 else 4 end)::smallint[]
    into v_seq from (select random() as r from generate_series(1, 400)) t;
  insert into public.matches (id, mode, ready_deadline) values (v_id, p_mode, clock_timestamp() + interval '25 seconds');
  insert into public.match_players (match_id, player_id, slot) values (v_id, p_a, 1), (v_id, p_b, 2);
  insert into app_private.match_seeds (match_id, piece_seq) values (v_id, v_seq);
  perform app_private.dequeue_players(p_a, p_b);
  return v_id;
end $$;

create or replace function app_private.active_match_of(p_player uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select m.id from public.matches m join public.match_players mp on mp.match_id = m.id
   where mp.player_id = p_player and m.status in ('lobby', 'playing')
   order by m.created_at desc limit 1;
$$;

-- 勝敗を決める。決められない状態なら何もしない。結果は1回だけ確定する。
create or replace function app_private.match_resolve(p_match uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches%rowtype;
  a public.match_players%rowtype;
  b public.match_players%rowtype;
  v_result text;
  v_winner uuid;
  v_reason text;
begin
  select * into m from public.matches where id = p_match for update;
  if not found or m.status <> 'playing' then return; end if;
  select * into a from public.match_players where match_id = p_match and slot = 1;
  select * into b from public.match_players where match_id = p_match and slot = 2;

  if a.finish_reason = 'forfeit' and b.finish_reason = 'forfeit' then
    v_result := 'void'; v_reason := 'both_forfeit';
  elsif a.finish_reason = 'forfeit' then
    v_result := 'win'; v_winner := b.player_id; v_reason := 'opponent_forfeit';
  elsif b.finish_reason = 'forfeit' then
    v_result := 'win'; v_winner := a.player_id; v_reason := 'opponent_forfeit';
  elsif a.finished and b.finished then
    if a.final_score > b.final_score then v_result := 'win'; v_winner := a.player_id;
    elsif b.final_score > a.final_score then v_result := 'win'; v_winner := b.player_id;
    else v_result := 'draw';
    end if;
    v_reason := case when a.eliminated or b.eliminated then 'elimination' else 'time_up' end;
  else
    return;   -- まだ決着していない
  end if;

  update public.matches
     set status = 'finished', finished_at = now(), winner_id = v_winner, result = v_result, end_reason = v_reason
   where id = p_match;

  if v_result = 'void' then
    update public.match_players set outcome = 'void' where match_id = p_match;
  else
    update public.match_players mp set outcome =
      case when v_result = 'draw' then 'draw' when mp.player_id = v_winner then 'win' else 'loss' end
    where mp.match_id = p_match;
    update public.players p set
      matches = matches + 1,
      wins    = wins   + case when v_result = 'win' and p.id = v_winner then 1 else 0 end,
      losses  = losses + case when v_result = 'win' and p.id <> v_winner then 1 else 0 end,
      draws   = draws  + case when v_result = 'draw' then 1 else 0 end
    where p.id in (a.player_id, b.player_id);
  end if;
end $$;

-- 時間切れ・切断・準備未完了の整理。match_get などから随時呼ばれる (cron でも定期実行)
create or replace function app_private.match_sweep(p_match uuid, p_alive uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select * into m from public.matches where id = p_match for update;
  if not found then return; end if;

  if m.status = 'lobby' then
    if v_now > m.ready_deadline then
      update public.matches set status = 'cancelled', finished_at = now(), result = 'void', end_reason = 'ready_timeout'
       where id = p_match;
    end if;
    return;
  end if;
  if m.status <> 'playing' then return; end if;

  -- 進捗の送信が25秒途絶えた(切断・離脱)プレイヤーは棄権扱い。試合終了後20秒以内に報告がない場合も同様。
  -- 今まさにこの試合へ通信してきた p_alive の人は、切断扱いにしない (期限切れだけが対象)
  update public.match_players mp
     set finished = true, finish_reason = 'forfeit', finished_at = now()
   where mp.match_id = p_match and not mp.finished
     and (
       (mp.player_id is distinct from p_alive and v_now > m.starts_at
          and v_now > coalesce(mp.last_progress_at, m.starts_at) + interval '25 seconds')
       or v_now > m.ends_at + interval '20 seconds'
     );
  perform app_private.match_resolve(p_match);
end $$;

create or replace function app_private.match_state(p_match uuid, p_me uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches%rowtype;
  v_seq smallint[];
begin
  select * into m from public.matches where id = p_match;
  if not found or not app_private.is_match_member(p_match, p_me) then return null; end if;
  if m.status in ('lobby', 'playing') then
    select piece_seq into v_seq from app_private.match_seeds where match_id = p_match;
  end if;
  return jsonb_build_object(
    'id', m.id, 'status', m.status, 'mode', m.mode, 'me', p_me,
    'starts_at', m.starts_at, 'ends_at', m.ends_at, 'ready_deadline', m.ready_deadline,
    'server_now', clock_timestamp(),
    'winner_id', m.winner_id, 'result', m.result, 'end_reason', m.end_reason,
    'duration_ms', (app_private.rule_const() ->> 'duration_ms')::int,
    'seq', to_jsonb(v_seq),
    'players', (
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'code', p.code, 'slot', mp.slot,
        'ready', mp.ready_at is not null, 'finished', mp.finished, 'eliminated', mp.eliminated,
        'final_score', mp.final_score, 'progress_score', mp.progress_score,
        'finish_reason', mp.finish_reason, 'outcome', mp.outcome,
        'wins', p.wins, 'losses', p.losses, 'matches', p.matches
      ) order by mp.slot)
      from public.match_players mp join public.players p on p.id = mp.player_id
      where mp.match_id = p_match));
end $$;

-- ------------------------------------------------------------- match RPCs ----
create or replace function public.match_get(p_match uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := app_private.me();
begin
  if not app_private.is_match_member(p_match, v_me) then perform app_private.fail('not_found'); end if;
  perform app_private.match_sweep(p_match);
  return app_private.match_state(p_match, v_me);
end $$;

create or replace function public.match_current() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  v_id uuid;
begin
  v_id := app_private.active_match_of(v_me);
  if v_id is null then return null; end if;
  perform app_private.match_sweep(v_id);
  v_id := app_private.active_match_of(v_me);
  if v_id is null then return null; end if;
  return app_private.match_state(v_id, v_me);
end $$;

create or replace function public.match_ready(p_match uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  m public.matches%rowtype;
begin
  if not app_private.is_match_member(p_match, v_me) then perform app_private.fail('not_found'); end if;
  perform app_private.match_sweep(p_match);
  select * into m from public.matches where id = p_match for update;
  if m.status = 'lobby' then
    update public.match_players set ready_at = coalesce(ready_at, clock_timestamp())
     where match_id = p_match and player_id = v_me;
    if not exists (select 1 from public.match_players where match_id = p_match and ready_at is null) then
      update public.matches
         set status = 'playing',
             starts_at = clock_timestamp() + interval '4 seconds',
             ends_at = clock_timestamp() + interval '4 seconds' + make_interval(secs => (app_private.rule_const() ->> 'duration_ms')::int / 1000.0)
       where id = p_match;
    end if;
  end if;
  return app_private.match_state(p_match, v_me);
end $$;

-- 進捗の送信 (生存確認も兼ねる)。相手の進捗も返すので Realtime が使えなくても観戦表示が維持できる
create or replace function public.match_progress(p_match uuid, p_score int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  m public.matches%rowtype;
begin
  if not app_private.is_match_member(p_match, v_me) then perform app_private.fail('not_found'); end if;
  perform app_private.rate_hit('prog:' || v_me, 60, 60);
  select * into m from public.matches where id = p_match;
  if m.status = 'playing' and p_score between 0 and 200000 and clock_timestamp() <= m.ends_at + interval '20 seconds' then
    update public.match_players
       set last_progress_at = clock_timestamp(), progress_score = greatest(progress_score, p_score)
     where match_id = p_match and player_id = v_me and not finished;
  end if;
  perform app_private.match_sweep(p_match, v_me);
  return app_private.match_state(p_match, v_me);
end $$;

create or replace function public.match_finish(p_match uuid, p_log jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  m public.matches%rowtype;
  mine public.match_players%rowtype;
  opp public.match_players%rowtype;
  v_seq smallint[];
  v_check jsonb;
  v_elapsed_ms numeric;
  v_dur int := (app_private.rule_const() ->> 'duration_ms')::int;
  v_fail text;
begin
  if not app_private.is_match_member(p_match, v_me) then perform app_private.fail('not_found'); end if;
  perform app_private.rate_hit('finish:' || v_me, 30, 60);
  perform app_private.match_sweep(p_match, v_me);
  select * into m from public.matches where id = p_match for update;

  select * into mine from public.match_players where match_id = p_match and player_id = v_me for update;
  if mine.finished or m.status in ('finished', 'cancelled') then
    return app_private.match_state(p_match, v_me);        -- 二重送信・遅延送信は結果を変えない
  end if;
  if m.status <> 'playing' then perform app_private.fail('match_not_active'); end if;
  if p_reason not in ('over', 'time', 'lead') then perform app_private.fail('invalid_input'); end if;

  select * into opp from public.match_players where match_id = p_match and player_id <> v_me;
  select piece_seq into v_seq from app_private.match_seeds where match_id = p_match;
  v_elapsed_ms := extract(epoch from (clock_timestamp() - m.starts_at)) * 1000;

  v_check := app_private.validate_log(v_seq, p_log, v_dur);
  v_fail := null;
  if not (v_check ->> 'ok')::boolean then
    v_fail := v_check ->> 'reason';
  elsif v_elapsed_ms < -500 then
    v_fail := 'not_started';
  -- 申告したシミュレーション時間は、実際に経過した時間 (+1.5秒) を超えられない
  elsif (v_check ->> 'last_step')::numeric * 1000 / (app_private.rule_const() ->> 'steps_per_sec')::numeric > v_elapsed_ms + 1500 then
    v_fail := 'time_travel';
  elsif p_reason = 'over' and not (v_check ->> 'over')::boolean then
    v_fail := 'no_gameover_event';
  elsif p_reason = 'time' and v_elapsed_ms < v_dur - 2000 then
    v_fail := 'too_early';
  elsif p_reason = 'lead' and not (opp.finished and opp.eliminated and (v_check ->> 'score')::int > coalesce(opp.final_score, 0)) then
    v_fail := 'not_leading';
  end if;

  if v_fail is not null then
    insert into app_private.match_violations (match_id, player_id, detail) values (p_match, v_me, v_fail);
    return jsonb_build_object('error', 'invalid_log', 'detail', v_fail);
  end if;

  update public.match_players
     set finished = true, finish_reason = p_reason, finished_at = now(),
         final_score = (v_check ->> 'score')::int,
         eliminated = (p_reason = 'over' or (v_check ->> 'over')::boolean),
         progress_score = greatest(progress_score, (v_check ->> 'score')::int)
   where match_id = p_match and player_id = v_me;
  perform app_private.match_resolve(p_match);
  return app_private.match_state(p_match, v_me);
end $$;

create or replace function public.match_leave(p_match uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  m public.matches%rowtype;
begin
  if not app_private.is_match_member(p_match, v_me) then perform app_private.fail('not_found'); end if;
  select * into m from public.matches where id = p_match for update;
  if m.status = 'lobby' then
    update public.matches set status = 'cancelled', finished_at = now(), result = 'void', end_reason = 'left_lobby'
     where id = p_match;
  elsif m.status = 'playing' then
    update public.match_players set finished = true, finish_reason = 'forfeit', finished_at = now()
     where match_id = p_match and player_id = v_me and not finished;
    perform app_private.match_resolve(p_match);
  end if;
  return app_private.match_state(p_match, v_me);
end $$;
