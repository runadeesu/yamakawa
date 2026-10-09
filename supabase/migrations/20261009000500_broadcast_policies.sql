-- ============================================================================
-- Broadcast 認可 (対戦中の盤面スナップショット用 private チャンネル)
--
-- realtime.messages は Supabase の Realtime サービスが初回接続時に作成する。
-- 新規プロジェクトで「relation realtime.messages does not exist」になる場合は、
-- いちどアプリ(または supabase-js の channel().subscribe())で Realtime に接続してから適用すること。
-- ============================================================================

-- Broadcast (対戦中の盤面スナップショット): 試合の参加者だけが private チャンネル "match:<uuid>" を読み書きできる
create or replace function app_private.can_use_match_topic(p_topic text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when p_topic ~ '^match:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then app_private.is_match_member(substr(p_topic, 7)::uuid, auth.uid())
    else false
  end;
$$;

create policy "teruki match broadcast read" on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast' and app_private.can_use_match_topic((select realtime.topic())));
create policy "teruki match broadcast write" on realtime.messages for insert to authenticated
  with check (realtime.messages.extension = 'broadcast' and app_private.can_use_match_topic((select realtime.topic())));

revoke all on function app_private.can_use_match_topic(text) from public, anon;
grant execute on function app_private.can_use_match_topic(text) to authenticated;
