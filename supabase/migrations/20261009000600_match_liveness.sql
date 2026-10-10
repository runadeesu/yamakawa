-- ============================================================================
-- 対戦中の「相手の接続状態」をサーバー基準で返す
--
-- match_state の players[].idle_ms = 最後に進捗報告(生存確認)を受けてからの経過ミリ秒。
-- Realtime (WebSocket) が使えない環境でも、クライアントは相手が切断しているかを判断できる。
-- 25秒以上途絶えると棄権扱いになる (match_sweep)。終了済み・開始前は null。
-- ============================================================================

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
        'wins', p.wins, 'losses', p.losses, 'matches', p.matches,
        'idle_ms', case
          when m.status <> 'playing' or mp.finished or m.starts_at is null then null
          else greatest(0, floor(extract(epoch from (clock_timestamp() - coalesce(mp.last_progress_at, m.starts_at))) * 1000))::bigint
        end
      ) order by mp.slot)
      from public.match_players mp join public.players p on p.id = mp.player_id
      where mp.match_id = p_match));
end $$;
