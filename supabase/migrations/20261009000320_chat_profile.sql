-- ============================================================================
-- chat / lists / profile / retention
-- ============================================================================

-- --------------------------------------------------------------------- chat ----
create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  player_a        uuid not null references public.players(id) on delete cascade,
  player_b        uuid not null references public.players(id) on delete cascade,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz,
  constraint conversations_ordered check (player_a < player_b),
  unique (player_a, player_b)
);
alter table public.conversations enable row level security;
create policy conversations_select_own on public.conversations for select to authenticated
  using (auth.uid() in (player_a, player_b));

create table public.messages (
  id              bigint generated always as identity primary key,
  conversation_id uuid references public.conversations(id) on delete cascade,
  match_id        uuid references public.matches(id) on delete cascade,
  sender_id       uuid not null references public.players(id) on delete cascade,
  body            text not null check (char_length(body) between 1 and 200),
  created_at      timestamptz not null default now(),
  constraint messages_one_scope check ((conversation_id is null) <> (match_id is null))
);
create index messages_conv_idx on public.messages (conversation_id, id desc) where conversation_id is not null;
create index messages_match_idx on public.messages (match_id, id desc) where match_id is not null;
create index messages_created_idx on public.messages (created_at);
alter table public.messages enable row level security;

create table public.conversation_reads (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  player_id       uuid not null references public.players(id) on delete cascade,
  last_read_id    bigint not null default 0,
  primary key (conversation_id, player_id)
);
alter table public.conversation_reads enable row level security;
create policy conversation_reads_select_own on public.conversation_reads for select to authenticated
  using (player_id = auth.uid());

-- 参加者だけが読める。ブロック/ミュートした相手のメッセージは自分には見えない (Realtime にも適用される)
create or replace function app_private.can_read_message(p_conv uuid, p_match uuid, p_sender uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
     and not app_private.hides_sender(auth.uid(), p_sender)
     and (
       (p_conv is not null and exists (select 1 from public.conversations c
                                        where c.id = p_conv and auth.uid() in (c.player_a, c.player_b)))
       or (p_match is not null and app_private.is_match_member(p_match, auth.uid()))
     );
$$;
create policy messages_select_participant on public.messages for select to authenticated
  using (app_private.can_read_message(conversation_id, match_id, sender_id));

create table app_private.ng_words (word text primary key);
alter table app_private.ng_words enable row level security;
-- 簡易フィルタ。運用で追加・削除する (insert into app_private.ng_words ...)
insert into app_private.ng_words (word) values
  ('死ね'), ('しね'), ('殺す'), ('ころす'), ('きもい'), ('キモい'), ('消えろ'), ('fuck'), ('shit'), ('bitch'), ('kill yourself')
on conflict do nothing;

create or replace function app_private.clean_message(p_body text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v text := coalesce(p_body, '');
  w text;
begin
  v := normalize(v, nfc);
  v := regexp_replace(v, '[\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]', '', 'g');   -- 不可視文字・方向制御
  v := regexp_replace(v, '[[:cntrl:]]', ' ', 'g');
  v := btrim(regexp_replace(v, '\s{2,}', ' ', 'g'));
  v := translate(v, '<>', '＜＞');                                                       -- HTML として解釈されないように無害化
  if char_length(v) < 1 then perform app_private.fail('empty'); end if;
  if char_length(v) > 200 then perform app_private.fail('too_long'); end if;
  for w in select word from app_private.ng_words loop
    v := regexp_replace(v, regexp_replace(w, '([.\\+*?\[\](){}|^$-])', '\\\1', 'g'), repeat('＊', char_length(w)), 'gi');
  end loop;
  return v;
end $$;

create or replace function app_private.chat_rate(p_me uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.rate_hit('chat:' || p_me, 20, 30);     -- 30秒に20件まで
  if exists (select 1 from public.messages where sender_id = p_me and created_at > clock_timestamp() - interval '500 milliseconds') then
    perform app_private.fail('too_fast');                     -- 連投 (0.5秒未満)
  end if;
end $$;

create or replace function public.chat_send(p_friend uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  v_body text;
  v_conv uuid;
  v_id bigint;
  v_at timestamptz;
begin
  if p_friend is null or p_friend = v_me
     or not app_private.is_friend(v_me, p_friend) or app_private.is_blocked_between(v_me, p_friend) then
    perform app_private.fail('forbidden');
  end if;
  perform app_private.chat_rate(v_me);
  v_body := app_private.clean_message(p_body);

  insert into public.conversations (player_a, player_b) values (least(v_me, p_friend), greatest(v_me, p_friend))
    on conflict (player_a, player_b) do nothing;
  select id into v_conv from public.conversations where player_a = least(v_me, p_friend) and player_b = greatest(v_me, p_friend);

  if exists (select 1 from public.messages where conversation_id = v_conv and sender_id = v_me and body = v_body
                and created_at > clock_timestamp() - interval '10 seconds') then
    perform app_private.fail('duplicate');
  end if;

  insert into public.messages (conversation_id, sender_id, body) values (v_conv, v_me, v_body)
    returning id, created_at into v_id, v_at;
  update public.conversations set last_message_at = v_at where id = v_conv;
  insert into public.conversation_reads (conversation_id, player_id, last_read_id) values (v_conv, v_me, v_id)
    on conflict (conversation_id, player_id) do update set last_read_id = greatest(public.conversation_reads.last_read_id, v_id);
  return jsonb_build_object('id', v_id, 'created_at', v_at, 'body', v_body);
end $$;

create or replace function public.chat_history(p_friend uuid, p_before bigint default null, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  v_conv uuid;
begin
  select id into v_conv from public.conversations where player_a = least(v_me, p_friend) and player_b = greatest(v_me, p_friend);
  if v_conv is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(rec order by (rec ->> 'id')::bigint)
    from (
      select jsonb_build_object('id', m.id, 'sender_id', m.sender_id, 'mine', m.sender_id = v_me,
                                'body', m.body, 'created_at', m.created_at) as rec
      from public.messages m
      where m.conversation_id = v_conv and not app_private.hides_sender(v_me, m.sender_id)
        and (p_before is null or m.id < p_before)
      order by m.id desc
      limit least(greatest(coalesce(p_limit, 50), 1), 100)
    ) t), '[]'::jsonb);
end $$;

create or replace function public.chat_mark_read(p_friend uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  v_conv uuid;
  v_max bigint;
begin
  select id into v_conv from public.conversations where player_a = least(v_me, p_friend) and player_b = greatest(v_me, p_friend);
  if v_conv is null then return; end if;
  select coalesce(max(id), 0) into v_max from public.messages where conversation_id = v_conv;
  insert into public.conversation_reads (conversation_id, player_id, last_read_id) values (v_conv, v_me, v_max)
    on conflict (conversation_id, player_id) do update set last_read_id = greatest(public.conversation_reads.last_read_id, v_max);
end $$;

-- 対戦中チャット
create or replace function public.match_chat_send(p_match uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  m public.matches%rowtype;
  v_body text;
  v_id bigint;
  v_at timestamptz;
begin
  if not app_private.is_match_member(p_match, v_me) then perform app_private.fail('forbidden'); end if;
  select * into m from public.matches where id = p_match;
  if m.status = 'cancelled' or (m.status = 'finished' and m.finished_at < now() - interval '10 minutes') then
    perform app_private.fail('forbidden');
  end if;
  perform app_private.chat_rate(v_me);
  v_body := app_private.clean_message(p_body);
  insert into public.messages (match_id, sender_id, body) values (p_match, v_me, v_body)
    returning id, created_at into v_id, v_at;
  return jsonb_build_object('id', v_id, 'created_at', v_at, 'body', v_body);
end $$;

create or replace function public.match_chat_history(p_match uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := app_private.me();
begin
  if not app_private.is_match_member(p_match, v_me) then perform app_private.fail('not_found'); end if;
  return coalesce((
    select jsonb_agg(rec order by (rec ->> 'id')::bigint)
    from (
      select jsonb_build_object('id', m.id, 'sender_id', m.sender_id, 'mine', m.sender_id = v_me,
                                'body', m.body, 'created_at', m.created_at) as rec
      from public.messages m
      where m.match_id = p_match and not app_private.hides_sender(v_me, m.sender_id)
      order by m.id desc limit 100
    ) t), '[]'::jsonb);
end $$;

-- ------------------------------------------------------- lists / profile / me ----
create or replace function public.friends_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := app_private.me();
begin
  return coalesce((
    select jsonb_agg(rec order by (rec ->> 'online')::boolean desc, rec ->> 'name')
    from (
      select jsonb_build_object(
        'id', p.id, 'name', p.name, 'code', p.code,
        'online', app_private.is_online(p.id),
        'status', case
            when app_private.active_match_of(p.id) is not null then 'in_match'
            when exists (select 1 from app_private.match_queue q where q.player_id = p.id) and app_private.is_online(p.id) then 'queue'
            when app_private.is_online(p.id) then 'online'
            else 'offline' end,
        'unread', (select count(*) from public.messages m
                    where m.conversation_id = c.id and m.sender_id = p.id
                      and m.id > coalesce(r.last_read_id, 0) and not app_private.hides_sender(v_me, m.sender_id)),
        'last_body', (select m.body from public.messages m where m.conversation_id = c.id
                       and not app_private.hides_sender(v_me, m.sender_id) order by m.id desc limit 1),
        'last_at', c.last_message_at,
        'friends_since', f.created_at) as rec
      from public.friendships f
      join public.players p on p.id = case when f.player_a = v_me then f.player_b else f.player_a end
      left join public.conversations c on c.player_a = f.player_a and c.player_b = f.player_b
      left join public.conversation_reads r on r.conversation_id = c.id and r.player_id = v_me
      where v_me in (f.player_a, f.player_b)
    ) t), '[]'::jsonb);
end $$;

create or replace function public.get_me() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  v_match uuid;
begin
  insert into app_private.presence as pr (player_id, last_seen) values (v_me, clock_timestamp())
    on conflict (player_id) do update set last_seen = clock_timestamp();
  v_match := app_private.active_match_of(v_me);
  return jsonb_build_object(
    'player', (select jsonb_build_object('id', p.id, 'name', p.name, 'code', p.code, 'created_at', p.created_at,
                                         'matches', p.matches, 'wins', p.wins, 'losses', p.losses, 'draws', p.draws)
               from public.players p where p.id = v_me),
    'pending_requests', (select count(*) from public.friend_requests r
                          where r.to_id = v_me and r.status = 'pending' and not app_private.hides_sender(v_me, r.from_id)),
    'pending_invites', (select count(*) from public.match_invites i
                         where i.to_id = v_me and i.status = 'pending' and i.expires_at > clock_timestamp()
                           and not app_private.is_blocked_between(v_me, i.from_id)),
    'unread', (select count(*) from public.messages m
                 join public.conversations c on c.id = m.conversation_id
                 left join public.conversation_reads r on r.conversation_id = c.id and r.player_id = v_me
                where v_me in (c.player_a, c.player_b) and m.sender_id <> v_me
                  and m.id > coalesce(r.last_read_id, 0) and not app_private.hides_sender(v_me, m.sender_id)),
    'active_match', v_match,
    'server_time', clock_timestamp());
end $$;

create or replace function public.get_profile(p_player uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  v_id uuid := coalesce(p_player, v_me);
  p public.players%rowtype;
  v_friend boolean;
begin
  select * into p from public.players where id = v_id;
  if not found or (v_id <> v_me and app_private.has_blocked(v_id, v_me)) then perform app_private.fail('not_found'); end if;
  v_friend := app_private.is_friend(v_me, v_id);
  return jsonb_build_object(
    'id', p.id, 'name', p.name, 'code', p.code, 'created_at', p.created_at,
    'matches', p.matches, 'wins', p.wins, 'losses', p.losses, 'draws', p.draws,
    'win_rate', case when p.matches > 0 then round(p.wins * 100.0 / p.matches, 1) else null end,
    'friend_count', (select count(*) from public.friendships f where v_id in (f.player_a, f.player_b)),
    'self', v_id = v_me,
    'relation', case
        when v_id = v_me then 'self'
        when v_friend then 'friend'
        when exists (select 1 from public.friend_requests r where r.status = 'pending' and r.from_id = v_me and r.to_id = v_id) then 'pending_out'
        when exists (select 1 from public.friend_requests r where r.status = 'pending' and r.from_id = v_id and r.to_id = v_me) then 'pending_in'
        when exists (select 1 from public.player_blocks b where b.blocker_id = v_me and b.blocked_id = v_id) then 'blocked'
        else 'none' end,
    -- オンライン状態は本人とフレンドにだけ見せる
    'online', case when v_id = v_me or v_friend then app_private.is_online(v_id) else null end,
    'recent', coalesce((
      select jsonb_agg(rec order by (rec ->> 'finished_at') desc)
      from (
        select jsonb_build_object(
          'match_id', m.id, 'finished_at', m.finished_at, 'mode', m.mode,
          'opponent_id', op.id, 'opponent', op.name,
          'my_score', mine.final_score, 'opp_score', theirs.final_score, 'outcome', mine.outcome) as rec
        from public.match_players mine
        join public.matches m on m.id = mine.match_id and m.status = 'finished' and m.result <> 'void'
        join public.match_players theirs on theirs.match_id = m.id and theirs.player_id <> mine.player_id
        join public.players op on op.id = theirs.player_id
        where mine.player_id = v_id
        order by m.finished_at desc limit 10
      ) t), '[]'::jsonb));
end $$;

-- ----------------------------------------------------------------- retention ----
-- 保存ルール: 友達チャットは 30日 かつ 会話ごとに最新 500件まで / 対戦チャットは試合後 7日
-- 古い招待・申請・レート制限カウンタも掃除する。pg_cron があれば毎日実行 (次の migration)
-- 掃除は1関数1DELETEの小さな関数に分けておく (まとめて Supabase MCP 経由で流すと途中で止まる事象を避けるため)
create or replace function app_private.purge_rate_limits() returns void
language sql security definer set search_path = '' as $$
  delete from app_private.rate_limits where window_start < now() - interval '2 days';
$$;

create or replace function app_private.purge_stale_queue() returns void
language sql security definer set search_path = '' as $$
  delete from app_private.match_queue where joined_at < now() - interval '10 minutes';
$$;

create or replace function app_private.purge_violations() returns void
language sql security definer set search_path = '' as $$
  delete from app_private.match_violations where at < now() - interval '90 days';
$$;

create or replace function app_private.purge_old_messages() returns void
language sql security definer set search_path = '' as $$
  delete from public.messages where created_at < now() - interval '30 days';
$$;

create or replace function app_private.purge_excess_messages() returns void
language sql security definer set search_path = '' as $$
  delete from public.messages m
   where m.conversation_id is not null
     and m.id in (select id from (select id, row_number() over (partition by conversation_id order by id desc) rn
                                    from public.messages where conversation_id is not null) t where rn > 500);
$$;

create or replace function app_private.purge_match_chats() returns void
language sql security definer set search_path = '' as $$
  delete from public.messages m using public.matches x
   where m.match_id = x.id and coalesce(x.finished_at, x.created_at) < now() - interval '7 days';
$$;

create or replace function app_private.purge_invites() returns void
language sql security definer set search_path = '' as $$
  delete from public.match_invites where created_at < now() - interval '1 day';
$$;

create or replace function app_private.purge_friend_requests() returns void
language sql security definer set search_path = '' as $$
  delete from public.friend_requests where status <> 'pending' and coalesce(responded_at, created_at) < now() - interval '30 days';
$$;

create or replace function app_private.purge_old_data() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.purge_old_messages();
  perform app_private.purge_excess_messages();
  perform app_private.purge_match_chats();
  perform app_private.purge_invites();
  perform app_private.purge_friend_requests();
  perform app_private.purge_rate_limits();
  perform app_private.purge_stale_queue();
  perform app_private.purge_violations();
end $$;

-- 放置された試合の整理 (cron 用)
create or replace function app_private.sweep_matches() returns void
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select id from public.matches where status in ('lobby', 'playing') loop
    perform app_private.match_sweep(r.id);
  end loop;
end $$;
