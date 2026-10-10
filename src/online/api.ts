import type { PostgrestError } from '@supabase/supabase-js';
import { getClient } from './client';
import { SUPABASE_KEY, SUPABASE_URL } from './config';
import { ApiError } from './errors';
import type {
  BlockRow,
  ChatMessage,
  Friend,
  FriendRequests,
  Invites,
  LogEvent,
  MatchFinishResponse,
  MatchState,
  Me,
  Profile,
  QueueStatus,
  ReportReason,
  SearchResult,
} from './types';

function requireClient() {
  const client = getClient();
  if (!client) throw new ApiError('network');
  return client;
}

function fromPostgrest(error: PostgrestError, status: number): ApiError {
  const message = error.message ?? '';
  if (status === 0 || /failed to fetch|networkerror|load failed|network request failed/i.test(message)) return new ApiError('network');
  if (error.code === 'PGRST301' || /jwt/i.test(message)) return new ApiError('unauthenticated');
  if (error.code === 'P0001') return new ApiError(message);          // サーバーが返すエラーコード (rate_limited など)
  if (error.code === '42501') return new ApiError('forbidden');
  return new ApiError('server_error');
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const client = requireClient();
  try {
    const { data, error, status } = await client.rpc(fn, args);
    if (error) throw fromPostgrest(error, status);
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('network');
  }
}

/* ---------------------------------------------------------------- account */

interface AccountReply {
  ok: boolean;
  error?: string;
  detail?: string;
  retry_after?: number;
  session?: { access_token: string; refresh_token: string };
}

async function callAccount(body: Record<string, unknown>): Promise<void> {
  const client = requireClient();
  let reply: AccountReply | null = null;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SUPABASE_KEY ?? '' },
      body: JSON.stringify(body),
    });
    reply = (await res.json().catch(() => null)) as AccountReply | null;
  } catch {
    throw new ApiError('network');
  }
  if (!reply) throw new ApiError('server_error');
  if (!reply.ok || !reply.session) throw new ApiError(reply.error ?? 'server_error', reply.detail, reply.retry_after);
  const { error } = await client.auth.setSession({
    access_token: reply.session.access_token,
    refresh_token: reply.session.refresh_token,
  });
  if (error) throw new ApiError('server_error');
}

export const signUp = (name: string, password: string) => callAccount({ action: 'signup', name, password });
export const logIn = (name: string, password: string) => callAccount({ action: 'login', name, password });

export async function signOut(everywhere: boolean): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    await client.auth.signOut({ scope: everywhere ? 'global' : 'local' });
  } catch {
    await client.auth.signOut({ scope: 'local' }).catch(() => undefined);   // ネットワーク不通でも端末側のセッションは必ず消す
  }
}

export async function currentSession() {
  const client = getClient();
  if (!client) return null;
  try {
    const { data } = await client.auth.getSession();
    return data.session;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- rpc map */

export const api = {
  getMe: () => rpc<Me>('get_me'),
  profile: (id?: string) => rpc<Profile>('get_profile', id ? { p_player: id } : {}),
  search: (query: string) => rpc<SearchResult[]>('search_players', { p_query: query }),

  friends: () => rpc<Friend[]>('friends_list'),
  requests: () => rpc<FriendRequests>('friend_requests_list'),
  sendRequest: (target: string) => rpc<{ status: 'pending' | 'accepted'; id: string }>('friend_request_send', { p_target: target }),
  respondRequest: (id: string, accept: boolean) => rpc<{ status: string }>('friend_request_respond', { p_request: id, p_accept: accept }),
  cancelRequest: (id: string) => rpc<null>('friend_request_cancel', { p_request: id }),
  removeFriend: (id: string) => rpc<null>('friend_remove', { p_friend: id }),
  blocks: () => rpc<BlockRow[]>('blocks_list'),
  setBlock: (target: string, mode: 'block' | 'mute') => rpc<null>('block_set', { p_target: target, p_mode: mode }),
  clearBlock: (target: string) => rpc<null>('block_clear', { p_target: target }),
  report: (target: string, reason: ReportReason, detail?: string, messageId?: number, matchId?: string) =>
    rpc<string>('report_player', { p_target: target, p_reason: reason, p_detail: detail ?? null, p_message_id: messageId ?? null, p_match_id: matchId ?? null }),

  chatHistory: (friend: string, before?: number) => rpc<ChatMessage[]>('chat_history', { p_friend: friend, p_before: before ?? null, p_limit: 50 }),
  chatSend: (friend: string, body: string) => rpc<{ id: number; created_at: string; body: string }>('chat_send', { p_friend: friend, p_body: body }),
  chatRead: (friend: string) => rpc<null>('chat_mark_read', { p_friend: friend }),

  queueJoin: () => rpc<QueueStatus>('queue_join'),
  queueStatus: () => rpc<QueueStatus>('queue_status'),
  queueLeave: () => rpc<null>('queue_leave'),

  invites: () => rpc<Invites>('invites_list'),
  sendInvite: (friend: string) => rpc<{ id: string; expires_at: string }>('invite_send', { p_friend: friend }),
  respondInvite: (id: string, accept: boolean) => rpc<{ status: string; match_id?: string }>('invite_respond', { p_invite: id, p_accept: accept }),
  cancelInvite: (id: string) => rpc<null>('invite_cancel', { p_invite: id }),

  matchCurrent: () => rpc<MatchState | null>('match_current'),
  matchGet: (id: string) => rpc<MatchState>('match_get', { p_match: id }),
  matchReady: (id: string) => rpc<MatchState>('match_ready', { p_match: id }),
  matchProgress: (id: string, score: number) => rpc<MatchState>('match_progress', { p_match: id, p_score: score }),
  matchFinish: (id: string, log: LogEvent[], reason: 'over' | 'time' | 'lead') =>
    rpc<MatchFinishResponse>('match_finish', { p_match: id, p_log: log, p_reason: reason }),
  matchLeave: (id: string) => rpc<MatchState>('match_leave', { p_match: id }),
  matchChatSend: (id: string, body: string) => rpc<{ id: number }>('match_chat_send', { p_match: id, p_body: body }),
  matchChatHistory: (id: string) => rpc<ChatMessage[]>('match_chat_history', { p_match: id }),
};
