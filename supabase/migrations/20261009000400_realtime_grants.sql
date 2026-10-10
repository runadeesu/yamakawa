-- ============================================================================
-- Realtime (publication / Broadcast 認可) / cron / 権限の最終整理
-- ============================================================================

-- Postgres Changes: 配信対象のテーブル。RLS が購読者ごとに適用される
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['friend_requests', 'friendships', 'match_invites', 'matches', 'match_players', 'messages'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- pg_cron があれば定期実行 (無い環境でも RPC 呼び出し時に同じ整理が走る)
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron is not available: %', sqlerrm;
  end;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('teruki-sweep-matches', '* * * * *', 'select app_private.sweep_matches()');
    perform cron.schedule('teruki-purge-old-data', '17 3 * * *', 'select app_private.purge_old_data()');
  end if;
exception when others then
  raise notice 'pg_cron schedule skipped: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------- privileges ----
-- クライアント(anon/authenticated)にはテーブルの SELECT (RLS 付き) だけ許可。書き込みは RPC のみ。
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

grant select on
  public.players, public.friendships, public.friend_requests, public.player_blocks, public.reports,
  public.matches, public.match_players, public.match_invites,
  public.conversations, public.messages, public.conversation_reads
to authenticated;

revoke all on all tables in schema app_private from public, anon, authenticated;

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig, p.proname, n.nspname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'app_private') and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
    if r.nspname = 'public' and r.proname like 'svc\_%' then
      execute format('grant execute on function %s to service_role', r.sig);          -- Edge Function 専用
    elsif r.nspname = 'public' then
      execute format('grant execute on function %s to authenticated', r.sig);          -- ログイン済みユーザーの RPC
    end if;
  end loop;
end $$;

-- RLS ポリシーが呼ぶ補助関数だけ authenticated に許可
grant execute on function app_private.can_read_message(uuid, uuid, uuid) to authenticated;
grant execute on function app_private.is_match_member(uuid, uuid) to authenticated;
