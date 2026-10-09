-- ============================================================================
-- friends / blocks / reports / player search
-- ============================================================================

-- ------------------------------------------------------------------ tables ----
create table public.friendships (
  player_a   uuid not null references public.players(id) on delete cascade,
  player_b   uuid not null references public.players(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (player_a, player_b),
  constraint friendships_ordered check (player_a < player_b)
);
create index friendships_b_idx on public.friendships (player_b);
alter table public.friendships enable row level security;
create policy friendships_select_own on public.friendships for select to authenticated
  using (auth.uid() in (player_a, player_b));

create table public.friend_requests (
  id           uuid primary key default gen_random_uuid(),
  from_id      uuid not null references public.players(id) on delete cascade,
  to_id        uuid not null references public.players(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  constraint friend_requests_not_self check (from_id <> to_id)
);
-- 同じ2人の間で pending は1件だけ (重複申請の防止)
create unique index friend_requests_one_pending on public.friend_requests (least(from_id, to_id), greatest(from_id, to_id))
  where status = 'pending';
create index friend_requests_to_idx on public.friend_requests (to_id, status);
create index friend_requests_from_idx on public.friend_requests (from_id, status);
alter table public.friend_requests enable row level security;
create policy friend_requests_select_own on public.friend_requests for select to authenticated
  using (auth.uid() in (from_id, to_id));

create table public.player_blocks (
  blocker_id uuid not null references public.players(id) on delete cascade,
  blocked_id uuid not null references public.players(id) on delete cascade,
  mode       text not null check (mode in ('block', 'mute')),
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint player_blocks_not_self check (blocker_id <> blocked_id)
);
alter table public.player_blocks enable row level security;
create policy player_blocks_select_own on public.player_blocks for select to authenticated
  using (blocker_id = auth.uid());

create table public.reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.players(id) on delete cascade,
  target_id   uuid not null references public.players(id) on delete cascade,
  reason      text not null check (reason in ('abuse', 'harassment', 'spam', 'cheat', 'other')),
  detail      text check (char_length(detail) <= 300),
  message_id  bigint,
  match_id    uuid,
  status      text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at  timestamptz not null default now()
);
create index reports_target_idx on public.reports (target_id, created_at desc);
alter table public.reports enable row level security;
create policy reports_select_own on public.reports for select to authenticated
  using (reporter_id = auth.uid());

-- ------------------------------------------------------------------ helpers ----
create or replace function app_private.is_friend(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.friendships where player_a = least(p_a, p_b) and player_b = greatest(p_a, p_b));
$$;

-- a が b をブロックしているか
create or replace function app_private.has_blocked(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.player_blocks where blocker_id = p_a and blocked_id = p_b and mode = 'block');
$$;

-- どちらかがブロックしているか
create or replace function app_private.is_blocked_between(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app_private.has_blocked(p_a, p_b) or app_private.has_blocked(p_b, p_a);
$$;

-- viewer が sender をブロックまたはミュートしていて、そのメッセージを見ないか
create or replace function app_private.hides_sender(p_viewer uuid, p_sender uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.player_blocks where blocker_id = p_viewer and blocked_id = p_sender);
$$;

create or replace function app_private.make_friends(p_a uuid, p_b uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.friendships (player_a, player_b) values (least(p_a, p_b), greatest(p_a, p_b))
  on conflict do nothing;
$$;

-- -------------------------------------------------------------- player search ----
create or replace function public.search_players(p_query text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  v_raw text := btrim(coalesce(p_query, ''));
  v_q text := lower(normalize(btrim(coalesce(p_query, '')), nfkc));
  v_like text;
begin
  perform app_private.rate_hit('search:' || v_me, 40, 60);
  if char_length(v_q) < 2 or char_length(v_q) > 16 then
    perform app_private.fail('invalid_input');
  end if;
  v_like := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return coalesce((
    select jsonb_agg(row_to_json(s)::jsonb)
    from (
      select p.id, p.name, p.code,
        case
          when app_private.is_friend(v_me, p.id) then 'friend'
          when exists (select 1 from public.friend_requests r where r.status = 'pending' and r.from_id = v_me and r.to_id = p.id) then 'pending_out'
          when exists (select 1 from public.friend_requests r where r.status = 'pending' and r.from_id = p.id and r.to_id = v_me) then 'pending_in'
          when exists (select 1 from public.player_blocks b where b.blocker_id = v_me and b.blocked_id = p.id) then 'blocked'
          else 'none'
        end as relation
      from public.players p
      where p.id <> v_me
        and (p.name_key like v_like escape '\' or p.code = upper(v_raw))
        and not app_private.has_blocked(p.id, v_me)   -- 自分をブロックした相手は検索に出ない
      order by (p.name_key = v_q) desc, p.name_key
      limit 20
    ) s
  ), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------- friend requests ----
create or replace function public.friend_request_send(p_target uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  v_rev uuid;
  v_id uuid;
begin
  perform app_private.rate_hit('freq:' || v_me, 20, 3600);
  if p_target is null or p_target = v_me then perform app_private.fail('invalid_target'); end if;
  if not exists (select 1 from public.players where id = p_target) then perform app_private.fail('not_found'); end if;
  if app_private.has_blocked(p_target, v_me) then perform app_private.fail('not_found'); end if;   -- ブロックされたことは伏せる
  if app_private.has_blocked(v_me, p_target) then perform app_private.fail('you_blocked'); end if;
  if app_private.is_friend(v_me, p_target) then perform app_private.fail('already_friends'); end if;

  -- 相手から先に申請が来ていたら、そのまま承認 (すれ違い防止)
  select id into v_rev from public.friend_requests
   where from_id = p_target and to_id = v_me and status = 'pending' for update;
  if found then
    update public.friend_requests set status = 'accepted', responded_at = now() where id = v_rev;
    perform app_private.make_friends(v_me, p_target);
    return jsonb_build_object('status', 'accepted', 'id', v_rev);
  end if;

  perform app_private.rate_hit('freq2:' || v_me || ':' || p_target, 3, 86400);
  begin
    insert into public.friend_requests (from_id, to_id) values (v_me, p_target) returning id into v_id;
  exception when unique_violation then
    perform app_private.fail('already_requested');
  end;
  return jsonb_build_object('status', 'pending', 'id', v_id);
end $$;

create or replace function public.friend_request_respond(p_request uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  r public.friend_requests%rowtype;
begin
  select * into r from public.friend_requests where id = p_request for update;
  if not found or r.to_id <> v_me then perform app_private.fail('not_found'); end if;
  if r.status <> 'pending' then perform app_private.fail('already_handled'); end if;
  if p_accept and app_private.is_blocked_between(v_me, r.from_id) then
    update public.friend_requests set status = 'cancelled', responded_at = now() where id = r.id;
    perform app_private.fail('not_found');
  end if;
  update public.friend_requests
     set status = case when p_accept then 'accepted' else 'declined' end, responded_at = now()
   where id = r.id;
  if p_accept then perform app_private.make_friends(v_me, r.from_id); end if;
  return jsonb_build_object('status', case when p_accept then 'accepted' else 'declined' end);
end $$;

create or replace function public.friend_request_cancel(p_request uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := app_private.me();
begin
  update public.friend_requests set status = 'cancelled', responded_at = now()
   where id = p_request and from_id = v_me and status = 'pending';
  if not found then perform app_private.fail('not_found'); end if;
end $$;

create or replace function public.friend_requests_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := app_private.me();
begin
  return jsonb_build_object(
    'incoming', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'player_id', p.id, 'name', p.name, 'code', p.code, 'created_at', r.created_at) order by r.created_at desc)
      from public.friend_requests r join public.players p on p.id = r.from_id
      where r.to_id = v_me and r.status = 'pending' and not app_private.hides_sender(v_me, r.from_id)), '[]'::jsonb),
    'outgoing', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'player_id', p.id, 'name', p.name, 'code', p.code, 'created_at', r.created_at) order by r.created_at desc)
      from public.friend_requests r join public.players p on p.id = r.to_id
      where r.from_id = v_me and r.status = 'pending'), '[]'::jsonb));
end $$;

create or replace function public.friend_remove(p_friend uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := app_private.me();
begin
  delete from public.friendships where player_a = least(v_me, p_friend) and player_b = greatest(v_me, p_friend);
  if not found then perform app_private.fail('not_found'); end if;
end $$;

-- --------------------------------------------------------------- block / mute ----
create or replace function public.block_set(p_target uuid, p_mode text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := app_private.me();
begin
  perform app_private.rate_hit('block:' || v_me, 60, 3600);
  if p_mode not in ('block', 'mute') then perform app_private.fail('invalid_input'); end if;
  if p_target is null or p_target = v_me then perform app_private.fail('invalid_target'); end if;
  if not exists (select 1 from public.players where id = p_target) then perform app_private.fail('not_found'); end if;

  insert into public.player_blocks (blocker_id, blocked_id, mode) values (v_me, p_target, p_mode)
  on conflict (blocker_id, blocked_id) do update set mode = excluded.mode, created_at = now();

  if p_mode = 'block' then
    delete from public.friendships where player_a = least(v_me, p_target) and player_b = greatest(v_me, p_target);
    update public.friend_requests set status = 'cancelled', responded_at = now()
     where status = 'pending' and ((from_id = v_me and to_id = p_target) or (from_id = p_target and to_id = v_me));
  end if;
end $$;

create or replace function public.block_clear(p_target uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := app_private.me();
begin
  delete from public.player_blocks where blocker_id = v_me and blocked_id = p_target;
end $$;

create or replace function public.blocks_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := app_private.me();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('player_id', p.id, 'name', p.name, 'code', p.code, 'mode', b.mode) order by b.created_at desc)
    from public.player_blocks b join public.players p on p.id = b.blocked_id
    where b.blocker_id = v_me), '[]'::jsonb);
end $$;

-- ------------------------------------------------------------------- reports ----
create or replace function public.report_player(
  p_target uuid, p_reason text, p_detail text default null, p_message_id bigint default null, p_match_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  v_detail text := nullif(btrim(regexp_replace(coalesce(p_detail, ''), '[[:cntrl:]]', ' ', 'g')), '');
  v_id uuid;
begin
  perform app_private.rate_hit('report:' || v_me, 10, 3600);
  if p_reason not in ('abuse', 'harassment', 'spam', 'cheat', 'other') then perform app_private.fail('invalid_input'); end if;
  if p_target is null or p_target = v_me then perform app_private.fail('invalid_target'); end if;
  if not exists (select 1 from public.players where id = p_target) then perform app_private.fail('not_found'); end if;
  if v_detail is not null and char_length(v_detail) > 300 then perform app_private.fail('too_long'); end if;

  -- 同じ相手・同じ理由の短時間の二重通報は1件にまとめる
  select id into v_id from public.reports
   where reporter_id = v_me and target_id = p_target and reason = p_reason and created_at > now() - interval '10 minutes'
   limit 1;
  if found then return v_id; end if;

  insert into public.reports (reporter_id, target_id, reason, detail, message_id, match_id)
  values (v_me, p_target, p_reason, v_detail, p_message_id, p_match_id) returning id into v_id;
  return v_id;
end $$;
