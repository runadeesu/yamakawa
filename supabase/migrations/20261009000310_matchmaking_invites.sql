-- ============================================================================
-- matchmaking (quick match queue) and friend invites
-- ============================================================================

-- -------------------------------------------------------------- matchmaking ----
create or replace function app_private.try_pair(p_me uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_opp uuid;
begin
  -- 自分の行を先にロックし、相手の行は skip locked。2人が同時に互いを掴んで二重に試合を作るのを防ぐ
  perform 1 from app_private.match_queue where player_id = p_me for update;
  select q.player_id into v_opp
    from app_private.match_queue q
   where q.player_id <> p_me
     and not app_private.is_blocked_between(p_me, q.player_id)
     and app_private.is_online(q.player_id)
   order by q.joined_at
   limit 1
   for update skip locked;
  if v_opp is null then return null; end if;
  return app_private.create_match(v_opp, p_me, 'quick');
end $$;

create or replace function public.queue_join() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  v_match uuid;
begin
  perform app_private.rate_hit('queue:' || v_me, 30, 60);
  insert into app_private.presence as p (player_id, last_seen) values (v_me, clock_timestamp())
    on conflict (player_id) do update set last_seen = clock_timestamp();

  v_match := app_private.active_match_of(v_me);
  if v_match is not null then
    perform app_private.match_sweep(v_match);
    v_match := app_private.active_match_of(v_me);
    if v_match is not null then return jsonb_build_object('status', 'matched', 'match_id', v_match); end if;
  end if;

  perform app_private.queue_cleanup();
  insert into app_private.match_queue (player_id) values (v_me)
    on conflict (player_id) do update set joined_at = clock_timestamp();

  v_match := app_private.try_pair(v_me);
  if v_match is not null then return jsonb_build_object('status', 'matched', 'match_id', v_match); end if;
  return jsonb_build_object('status', 'waiting', 'waited', 0);
end $$;

create or replace function public.queue_status() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  v_match uuid;
  v_joined timestamptz;
begin
  insert into app_private.presence as p (player_id, last_seen) values (v_me, clock_timestamp())
    on conflict (player_id) do update set last_seen = clock_timestamp();
  v_match := app_private.active_match_of(v_me);
  if v_match is not null then
    perform app_private.match_sweep(v_match);
    v_match := app_private.active_match_of(v_me);
    if v_match is not null then return jsonb_build_object('status', 'matched', 'match_id', v_match); end if;
  end if;
  select joined_at into v_joined from app_private.match_queue where player_id = v_me;
  if v_joined is null then return jsonb_build_object('status', 'idle'); end if;
  if v_joined < clock_timestamp() - interval '2 minutes' then
    perform app_private.dequeue_player(v_me);
    return jsonb_build_object('status', 'idle', 'reason', 'timeout');
  end if;
  v_match := app_private.try_pair(v_me);
  if v_match is not null then return jsonb_build_object('status', 'matched', 'match_id', v_match); end if;
  return jsonb_build_object('status', 'waiting', 'waited', floor(extract(epoch from (clock_timestamp() - v_joined)))::int,
                            'searching', (select count(*) from app_private.match_queue));
end $$;

create or replace function public.queue_leave() returns void
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := app_private.me();
begin
  perform app_private.dequeue_player(v_me);
end $$;

-- ------------------------------------------------------------------- invites ----
create or replace function public.invite_send(p_friend uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  v_id uuid;
  v_exp timestamptz;
begin
  perform app_private.rate_hit('invite:' || v_me, 20, 300);
  if p_friend is null or p_friend = v_me then perform app_private.fail('invalid_target'); end if;
  if not app_private.is_friend(v_me, p_friend) or app_private.is_blocked_between(v_me, p_friend) then
    perform app_private.fail('not_friends');
  end if;
  if not app_private.is_online(p_friend) then perform app_private.fail('offline'); end if;
  if app_private.active_match_of(v_me) is not null then perform app_private.fail('busy'); end if;
  if app_private.active_match_of(p_friend) is not null then perform app_private.fail('busy_target'); end if;

  update public.match_invites set status = 'expired'
   where from_id = v_me and to_id = p_friend and status = 'pending' and expires_at < clock_timestamp();
  v_exp := clock_timestamp() + interval '60 seconds';
  begin
    insert into public.match_invites (from_id, to_id, expires_at) values (v_me, p_friend, v_exp) returning id into v_id;
  exception when unique_violation then
    perform app_private.fail('already_invited');
  end;
  perform app_private.dequeue_player(v_me);
  return jsonb_build_object('id', v_id, 'expires_at', v_exp);
end $$;

-- 期限切れ・競合は例外にせず状態として返す (更新を確定させるため)
create or replace function public.invite_respond(p_invite uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := app_private.me();
  i public.match_invites%rowtype;
  v_match uuid;
begin
  select * into i from public.match_invites where id = p_invite for update;
  if not found or i.to_id <> v_me then perform app_private.fail('not_found'); end if;
  if i.status <> 'pending' then return jsonb_build_object('status', i.status, 'match_id', i.match_id); end if;
  if i.expires_at < clock_timestamp() then
    update public.match_invites set status = 'expired' where id = i.id;
    return jsonb_build_object('status', 'expired');
  end if;
  if not p_accept then
    update public.match_invites set status = 'declined' where id = i.id;
    return jsonb_build_object('status', 'declined');
  end if;
  if app_private.is_blocked_between(v_me, i.from_id) or not app_private.is_friend(v_me, i.from_id) then
    update public.match_invites set status = 'cancelled' where id = i.id;
    return jsonb_build_object('status', 'cancelled');
  end if;
  if app_private.active_match_of(v_me) is not null or app_private.active_match_of(i.from_id) is not null then
    update public.match_invites set status = 'cancelled' where id = i.id;
    return jsonb_build_object('status', 'busy');
  end if;
  v_match := app_private.create_match(i.from_id, v_me, 'friend');
  update public.match_invites set status = 'accepted', match_id = v_match where id = i.id;
  return jsonb_build_object('status', 'accepted', 'match_id', v_match);
end $$;

create or replace function public.invite_cancel(p_invite uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := app_private.me();
begin
  update public.match_invites set status = 'cancelled' where id = p_invite and from_id = v_me and status = 'pending';
  if not found then perform app_private.fail('not_found'); end if;
end $$;

create or replace function public.invites_list() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := app_private.me();
begin
  update public.match_invites set status = 'expired' where status = 'pending' and expires_at < clock_timestamp()
    and (from_id = v_me or to_id = v_me);
  return jsonb_build_object(
    'incoming', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'player_id', p.id, 'name', p.name, 'expires_at', i.expires_at) order by i.created_at)
      from public.match_invites i join public.players p on p.id = i.from_id
      where i.to_id = v_me and i.status = 'pending' and not app_private.is_blocked_between(v_me, i.from_id)), '[]'::jsonb),
    'outgoing', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'player_id', p.id, 'name', p.name, 'status', i.status,
                                          'expires_at', i.expires_at, 'match_id', i.match_id) order by i.created_at)
      from public.match_invites i join public.players p on p.id = i.to_id
      where i.from_id = v_me and (i.status = 'pending' or i.created_at > clock_timestamp() - interval '3 minutes')), '[]'::jsonb));
end $$;
