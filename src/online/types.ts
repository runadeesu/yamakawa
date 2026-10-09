export interface PlayerStats {
  id: string;
  name: string;
  code: string;
  created_at: string;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface Me {
  player: PlayerStats;
  pending_requests: number;
  pending_invites: number;
  unread: number;
  active_match: string | null;
  server_time: string;
}

export type Relation = 'self' | 'friend' | 'pending_out' | 'pending_in' | 'blocked' | 'none';

export interface SearchResult {
  id: string;
  name: string;
  code: string;
  relation: Relation;
}

export type FriendStatus = 'offline' | 'online' | 'queue' | 'in_match';

export interface Friend {
  id: string;
  name: string;
  code: string;
  online: boolean;
  status: FriendStatus;
  unread: number;
  last_body: string | null;
  last_at: string | null;
  friends_since: string;
}

export interface RequestRow {
  id: string;
  player_id: string;
  name: string;
  code: string;
  created_at: string;
}

export interface FriendRequests {
  incoming: RequestRow[];
  outgoing: RequestRow[];
}

export interface BlockRow {
  player_id: string;
  name: string;
  code: string;
  mode: 'block' | 'mute';
}

export interface ChatMessage {
  id: number;
  sender_id: string;
  mine: boolean;
  body: string;
  created_at: string;
}

export interface RecentMatch {
  match_id: string;
  finished_at: string;
  mode: 'quick' | 'friend';
  opponent_id: string;
  opponent: string;
  my_score: number;
  opp_score: number;
  outcome: 'win' | 'loss' | 'draw';
}

export interface Profile extends PlayerStats {
  win_rate: number | null;
  friend_count: number;
  self: boolean;
  relation: Relation;
  online: boolean | null;
  recent: RecentMatch[];
}

export type QueueStatus =
  | { status: 'idle'; reason?: 'timeout' }
  | { status: 'waiting'; waited: number; searching?: number }
  | { status: 'matched'; match_id: string };

export interface InviteIn {
  id: string;
  player_id: string;
  name: string;
  expires_at: string;
}

export interface InviteOut {
  id: string;
  player_id: string;
  name: string;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';
  expires_at: string;
  match_id: string | null;
}

export interface Invites {
  incoming: InviteIn[];
  outgoing: InviteOut[];
}

export interface MatchPlayer {
  id: string;
  name: string;
  code: string;
  slot: 1 | 2;
  ready: boolean;
  finished: boolean;
  eliminated: boolean;
  final_score: number | null;
  progress_score: number;
  finish_reason: 'over' | 'time' | 'lead' | 'forfeit' | null;
  outcome: 'win' | 'loss' | 'draw' | 'void' | null;
  wins: number;
  losses: number;
  matches: number;
  /** 最後の生存報告からの経過 (ms)。サーバー基準の接続状態。対戦中の未終了プレイヤーのみ */
  idle_ms: number | null;
}

export interface MatchState {
  id: string;
  status: 'lobby' | 'playing' | 'finished' | 'cancelled';
  mode: 'quick' | 'friend';
  me: string;
  starts_at: string | null;
  ends_at: string | null;
  ready_deadline: string;
  server_now: string;
  winner_id: string | null;
  result: 'win' | 'draw' | 'void' | null;
  end_reason: string | null;
  duration_ms: number;
  seq: number[] | null;
  players: MatchPlayer[];
}

export type MatchFinishResponse = MatchState | { error: 'invalid_log'; detail: string };

export type LogEvent = [step: number, kind: 0 | 1 | 2, arg: number];

export type ReportReason = 'abuse' | 'harassment' | 'spam' | 'cheat' | 'other';

/** 盤面スナップショット (Broadcast)。n は [level, x, y, level, x, y, ...] */
export interface Snapshot {
  s: number;
  a: 0 | 1;
  n: number[];
  q: number;
}
