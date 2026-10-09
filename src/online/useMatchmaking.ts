import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { MATCH_SEARCH_HINT_S } from './config';
import { useOnline, useOnlineEvents } from './OnlineProvider';

export interface MatchmakingState {
  phase: 'idle' | 'searching';
  waited: number;
  searching: number;
  /** 一定時間見つからない */
  slow: boolean;
  timedOut: boolean;
}

const POLL_MS = 1500;

/** クイックマッチの待機。タブを切り替えても検索は続く (OnlineApp で保持する) */
export function useMatchmaking(onMatched: (matchId: string) => void) {
  const { fail } = useOnline();
  const [state, setState] = useState<MatchmakingState>({ phase: 'idle', waited: 0, searching: 0, slow: false, timedOut: false });
  const startedAt = useRef(0);
  const polling = useRef(false);
  const active = useRef(false);
  const matched = useRef(onMatched);
  matched.current = onMatched;

  const finish = useCallback((id: string) => {
    active.current = false;
    setState({ phase: 'idle', waited: 0, searching: 0, slow: false, timedOut: false });
    matched.current(id);
  }, []);

  const poll = useCallback(async () => {
    if (!active.current || polling.current) return;
    polling.current = true;
    try {
      const status = await api.queueStatus();
      if (!active.current) return;
      if (status.status === 'matched') finish(status.match_id);
      else if (status.status === 'idle') {
        active.current = false;
        setState({ phase: 'idle', waited: 0, searching: 0, slow: false, timedOut: true });
      } else {
        const waited = Math.floor((Date.now() - startedAt.current) / 1000);
        setState({ phase: 'searching', waited, searching: status.searching ?? 0, slow: waited >= MATCH_SEARCH_HINT_S, timedOut: false });
      }
    } catch (error) {
      if (!(error instanceof Error && error.message === 'network')) {
        active.current = false;
        setState({ phase: 'idle', waited: 0, searching: 0, slow: false, timedOut: false });
      }
      fail(error);
    } finally {
      polling.current = false;
    }
  }, [fail, finish]);

  const join = useCallback(async () => {
    if (active.current) return;
    active.current = true;
    startedAt.current = Date.now();
    setState({ phase: 'searching', waited: 0, searching: 0, slow: false, timedOut: false });
    try {
      const status = await api.queueJoin();
      if (!active.current) return;
      if (status.status === 'matched') finish(status.match_id);
    } catch (error) {
      active.current = false;
      setState({ phase: 'idle', waited: 0, searching: 0, slow: false, timedOut: false });
      fail(error);
    }
  }, [fail, finish]);

  const cancel = useCallback(async () => {
    active.current = false;
    setState({ phase: 'idle', waited: 0, searching: 0, slow: false, timedOut: false });
    try {
      await api.queueLeave();
    } catch (error) {
      fail(error);
    }
  }, [fail]);

  useEffect(() => {
    if (state.phase !== 'searching') return () => undefined;
    const id = window.setInterval(() => void poll(), POLL_MS);
    return () => window.clearInterval(id);
  }, [state.phase, poll]);

  // Realtime で試合成立を即座に知る
  useOnlineEvents((event) => {
    if (event.type === 'match') void poll();
  });

  // 画面を閉じたときは待機を取り消す
  useEffect(
    () => () => {
      if (active.current) void api.queueLeave().catch(() => undefined);
    },
    [],
  );

  return { state, join, cancel };
}
