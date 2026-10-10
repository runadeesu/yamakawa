import type { RealtimeChannel } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, currentSession, logIn, signOut, signUp } from './api';
import { getClient } from './client';
import { DEGRADED_POLL_MS, HEARTBEAT_MS, ONLINE_ENABLED } from './config';
import { ApiError, describeError } from './errors';
import type { Me } from './types';

export type Phase = 'disabled' | 'booting' | 'signed_out' | 'signed_in';
/** ok: すべて正常 / degraded: リアルタイム通信だけ使えない (定期的な自動更新で動作) / offline: サーバーと通信できない */
export type NetState = 'ok' | 'degraded' | 'offline';
type RealtimeState = 'connecting' | 'ok' | 'down';

/** この時間内に Realtime へつながらなければ、使えないものとして扱う */
const REALTIME_GRACE_MS = 8000;

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export type OnlineEvent =
  | { type: 'friend_request' }
  | { type: 'friends_changed' }
  | { type: 'invite' }
  | { type: 'message'; conversationId: string | null; matchId: string | null; senderId: string; id: number; body: string; createdAt: string }
  | { type: 'match' };

interface OnlineContextValue {
  phase: Phase;
  me: Me | null;
  net: NetState;
  toasts: Toast[];
  signup(name: string, password: string): Promise<void>;
  login(name: string, password: string): Promise<void>;
  logout(everywhere: boolean): Promise<void>;
  refresh(): Promise<void>;
  toast(kind: Toast['kind'], text: string): void;
  dismissToast(id: number): void;
  subscribe(listener: (event: OnlineEvent) => void): () => void;
  /** 通信エラーを画面に出す (ログイン切れなら自動でサインアウト) */
  fail(error: unknown): void;
}

const OnlineContext = createContext<OnlineContextValue | null>(null);

export function useOnline(): OnlineContextValue {
  const ctx = useContext(OnlineContext);
  if (!ctx) throw new Error('useOnline must be used inside <OnlineProvider>');
  return ctx;
}

/** イベントを購読する便利フック (listener は最新のものが呼ばれる) */
export function useOnlineEvents(listener: (event: OnlineEvent) => void): void {
  const { subscribe } = useOnline();
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => subscribe((event) => ref.current(event)), [subscribe]);
}

let toastSeq = 0;

export function OnlineProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>(ONLINE_ENABLED ? 'booting' : 'disabled');
  const [me, setMe] = useState<Me | null>(null);
  const [rt, setRt] = useState<RealtimeState>('connecting');
  const [rpcOffline, setRpcOffline] = useState(false);
  const net: NetState = rpcOffline ? 'offline' : rt === 'down' ? 'degraded' : 'ok';
  const rtTimer = useRef(0);
  const counts = useRef<{ requests: number; invites: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const listeners = useRef(new Set<(event: OnlineEvent) => void>());
  const channel = useRef<RealtimeChannel | null>(null);
  const mounted = useRef(true);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const emit = useCallback((event: OnlineEvent) => {
    for (const listener of listeners.current) listener(event);
  }, []);

  const subscribe = useCallback((listener: (event: OnlineEvent) => void) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const toast = useCallback(
    (kind: Toast['kind'], text: string) => {
      const id = ++toastSeq;
      setToasts((list) => [...list.slice(-3), { id, kind, text }]);
      window.setTimeout(() => dismissToast(id), kind === 'error' ? 6000 : 4500);
    },
    [dismissToast],
  );

  const disconnect = useCallback(() => {
    const client = getClient();
    window.clearTimeout(rtTimer.current);
    if (channel.current && client) void client.removeChannel(channel.current);
    channel.current = null;
  }, []);

  const resetSignedOut = useCallback(() => {
    disconnect();
    setMe(null);
    counts.current = null;
    setRpcOffline(false);
    setRt('connecting');
    setPhase('signed_out');
  }, [disconnect]);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getMe();
      if (!mounted.current) return;
      // 新しい申請・招待は、Realtime でも定期更新でも同じここで気づいて知らせる
      const before = counts.current;
      if (before && next.pending_requests > before.requests) toast('info', '新しいフレンド申請が届きました');
      if (before && next.pending_invites > before.invites) toast('info', '対戦の招待が届きました');
      counts.current = { requests: next.pending_requests, invites: next.pending_invites };
      setMe(next);
      setRpcOffline(false);
    } catch (error) {
      if (!(error instanceof ApiError)) return;
      if (error.code === 'unauthenticated' || error.code === 'no_player') {
        await signOut(false);
        resetSignedOut();
      } else if (error.code === 'network') {
        setRpcOffline(true);
      }
    }
  }, [resetSignedOut, toast]);

  const fail = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && (error.code === 'unauthenticated' || error.code === 'no_player')) {
        void signOut(false).then(resetSignedOut);
      }
      if (error instanceof ApiError && error.code === 'network') setRpcOffline(true);
      toast('error', describeError(error));
    },
    [resetSignedOut, toast],
  );

  /** Realtime: 自分宛ての申請・招待・メッセージ・対戦の更新を受け取る */
  const connect = useCallback(
    (userId: string) => {
      const client = getClient();
      if (!client) return;
      disconnect();
      setRt('connecting');
      rtTimer.current = window.setTimeout(() => setRt((state) => (state === 'connecting' ? 'down' : state)), REALTIME_GRACE_MS);
      const changed = (event: OnlineEvent) => () => {
        emit(event);
        void refresh();
      };
      const ch = client
        .channel(`user-${userId}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'friend_requests', filter: `to_id=eq.${userId}` }, changed({ type: 'friend_request' }))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'friend_requests', filter: `from_id=eq.${userId}` }, changed({ type: 'friends_changed' }))
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'friendships', filter: `player_a=eq.${userId}` }, changed({ type: 'friends_changed' }))
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'friendships', filter: `player_b=eq.${userId}` }, changed({ type: 'friends_changed' }))
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'match_invites', filter: `to_id=eq.${userId}` }, changed({ type: 'invite' }))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'match_invites', filter: `from_id=eq.${userId}` }, changed({ type: 'invite' }))
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
          const row = payload.new as { id: number; body: string; created_at: string; conversation_id: string | null; match_id: string | null; sender_id: string };
          emit({
            type: 'message',
            conversationId: row.conversation_id,
            matchId: row.match_id,
            senderId: row.sender_id,
            id: row.id,
            body: row.body,
            createdAt: row.created_at,
          });
          if (row.sender_id !== userId) void refresh();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'match_players', filter: `player_id=eq.${userId}` }, changed({ type: 'match' }))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'matches' }, () => emit({ type: 'match' }))
        .subscribe((status) => {
          if (!mounted.current || channel.current !== ch) return;
          if (status === 'SUBSCRIBED') {
            window.clearTimeout(rtTimer.current);
            setRt('ok');
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            window.clearTimeout(rtTimer.current);
            setRt('down');
          }
        });
      channel.current = ch;
    },
    [disconnect, emit, refresh],
  );

  const afterSignIn = useCallback(async () => {
    const next = await api.getMe();
    counts.current = { requests: next.pending_requests, invites: next.pending_invites };
    setMe(next);
    setPhase('signed_in');
    connect(next.player.id);
  }, [connect]);

  // 起動時: 保存されたセッションを復元する
  useEffect(() => {
    mounted.current = true;
    if (!ONLINE_ENABLED) return () => undefined;
    let cancelled = false;
    void (async () => {
      const session = await currentSession();
      if (cancelled) return;
      if (!session) {
        setPhase('signed_out');
        return;
      }
      try {
        await afterSignIn();
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === 'network') {
          setPhase('signed_out');
          setRpcOffline(true);
        } else {
          await signOut(false);
          setPhase('signed_out');
        }
      }
    })();
    const client = getClient();
    const { data } = client?.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' && phaseRef.current === 'signed_in') resetSignedOut();
    }) ?? { data: null };
    return () => {
      cancelled = true;
      mounted.current = false;
      data?.subscription.unsubscribe();
      disconnect();
    };
  }, [afterSignIn, disconnect, resetSignedOut]);

  // 生存確認 (オンライン表示) と未読数などの更新
  useEffect(() => {
    if (phase !== 'signed_in') return () => undefined;
    // リアルタイム通信が使えないときは、通知に早く気づけるよう間隔を詰める
    const timer = window.setInterval(() => void refresh(), net === 'degraded' ? DEGRADED_POLL_MS : HEARTBEAT_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    const onOnline = () => void refresh();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [phase, net, refresh]);

  const signup = useCallback(
    async (name: string, password: string) => {
      await signUp(name, password);
      await afterSignIn();
    },
    [afterSignIn],
  );

  const login = useCallback(
    async (name: string, password: string) => {
      await logIn(name, password);
      await afterSignIn();
    },
    [afterSignIn],
  );

  const logout = useCallback(
    async (everywhere: boolean) => {
      await signOut(everywhere);
      resetSignedOut();
    },
    [resetSignedOut],
  );

  const value = useMemo<OnlineContextValue>(
    () => ({ phase, me, net, toasts, signup, login, logout, refresh, toast, dismissToast, subscribe, fail }),
    [phase, me, net, toasts, signup, login, logout, refresh, toast, dismissToast, subscribe, fail],
  );

  return <OnlineContext.Provider value={value}>{children}</OnlineContext.Provider>;
}
