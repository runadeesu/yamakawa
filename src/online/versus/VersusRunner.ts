import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Game } from '../../game/Game';
import { api } from '../api';
import { getClient } from '../client';
import { ApiError } from '../errors';
import type { LogEvent, MatchState, Snapshot } from '../types';

export type VersusPhase = 'joining' | 'lobby' | 'countdown' | 'playing' | 'finishing' | 'done' | 'cancelled' | 'error';
export type LinkQuality = 'good' | 'weak' | 'lost';

const POLL_MS = 1000;
const PROGRESS_MS = 3000;
const SNAPSHOT_MS = 250;
const RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000];

/**
 * オンライン対戦 1 試合の進行役 (React 非依存)。
 *  - サーバーと時刻を合わせてカウントダウン・時間切れを決める
 *  - 自分のゲームのイベントをログに記録し、終了時にサーバーへ提出する (勝敗はサーバーが確定)
 *  - 盤面スナップショットを Realtime Broadcast で相手に送る / 相手のを受け取る
 *  - 通信が途切れても、結果提出をリトライする
 */
export class VersusRunner {
  readonly matchId: string;
  phase: VersusPhase = 'joining';
  match: MatchState | null = null;
  message: string | null = null;
  /** 相手の最新の盤面 (描画側が rAF で読む) */
  opponentBoard: Snapshot | null = null;

  private readonly onChange: () => void;
  private game: Game | null = null;
  private offGame: (() => void) | null = null;
  private channel: RealtimeChannel | null = null;
  private timers: number[] = [];
  private log: LogEvent[] = [];
  private offset = 0;
  private bestRtt = Infinity;
  private startAt = 0;
  private endsAt = 0;
  private seq = 0;
  private lastSnapAt = 0;
  private lastProgressAt = 0;
  private finishing = false;
  private leadRetryAt = 0;
  private disposed = false;
  private channelReady = false;

  constructor(matchId: string, onChange: () => void) {
    this.matchId = matchId;
    this.onChange = onChange;
  }

  /* ------------------------------------------------------------------ time */

  /** サーバー時刻 (ms) の推定値 */
  now(): number {
    return Date.now() + this.offset;
  }

  private async timed<T extends MatchState | null>(call: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    const result = await call();
    const t1 = Date.now();
    if (result && 'server_now' in result) {
      const rtt = t1 - t0;
      if (rtt <= this.bestRtt + 30) {
        this.bestRtt = Math.min(this.bestRtt, rtt);
        this.offset = Date.parse(result.server_now) - (t0 + t1) / 2;
      }
    }
    return result;
  }

  get remainingMs(): number {
    if (this.phase !== 'playing' && this.phase !== 'finishing') return this.match?.duration_ms ?? 120_000;
    return Math.max(0, this.endsAt - this.now());
  }

  get countdown(): number | null {
    if (this.phase !== 'countdown') return null;
    return Math.max(0, Math.ceil((this.startAt - this.now()) / 1000));
  }

  get myScore(): number {
    return this.game?.session.score ?? 0;
  }

  get opponent() {
    const players = this.match?.players ?? [];
    return players.find((p) => p.id !== this.match?.me) ?? null;
  }

  get opponentScore(): number {
    const opp = this.opponent;
    if (!opp) return 0;
    return Math.max(opp.final_score ?? 0, opp.progress_score, this.opponentBoard?.s ?? 0);
  }

  get link(): LinkQuality {
    const opp = this.opponent;
    if (!opp || opp.finished || this.phase !== 'playing') return 'good';
    const age = performance.now() - this.lastSnapAt;
    if (!this.lastSnapAt) return performance.now() - this.lastProgressAt < 8000 ? 'weak' : 'lost';
    return age < 1500 ? 'good' : age < 5000 ? 'weak' : 'lost';
  }

  /* ------------------------------------------------------------- lifecycle */

  async start(): Promise<void> {
    try {
      this.match = await this.timed(() => api.matchGet(this.matchId));
      this.apply(this.match);
      await this.openChannel();
      if (this.disposed) return;
      if (this.match.status === 'lobby') {
        this.match = await this.timed(() => api.matchReady(this.matchId));
        this.apply(this.match);
      }
    } catch (error) {
      this.setError(error);
      return;
    }
    this.every(POLL_MS, () => void this.poll());
    this.every(100, () => this.tick());
    this.every(SNAPSHOT_MS, () => this.sendSnapshot());
    this.changed();
  }

  attachGame(game: Game): void {
    this.offGame?.();
    this.game = game;
    this.offGame = game.session.on((event) => {
      if (this.phase !== 'playing') return;
      const step = game.session.stepCount;
      if (event.type === 'drop') this.log.push([step, 0, event.level]);
      else if (event.type === 'merge') this.log.push([step, 1, event.level]);
      else if (event.type === 'gameover') {
        this.log.push([step, 2, 0]);
        void this.finish('over');
      }
    });
    this.syncLock();
  }

  detachGame(): void {
    this.offGame?.();
    this.offGame = null;
    this.game = null;
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.timers) window.clearInterval(id);
    this.timers = [];
    this.detachGame();
    const client = getClient();
    if (this.channel && client) void client.removeChannel(this.channel);
    this.channel = null;
  }

  /** 対戦を棄権する (進行中は負け、準備中は無効) */
  async leave(): Promise<void> {
    try {
      const state = await api.matchLeave(this.matchId);
      this.apply(state);
    } catch (error) {
      this.setError(error);
    }
  }

  /* --------------------------------------------------------------- internals */

  private every(ms: number, fn: () => void): void {
    this.timers.push(window.setInterval(fn, ms));
  }

  private changed(): void {
    if (!this.disposed) this.onChange();
  }

  private setError(error: unknown): void {
    this.message = error instanceof ApiError && error.code === 'network' ? '通信できません。接続を確認しています…' : '対戦の情報を取得できませんでした';
    if (!(error instanceof ApiError && error.code === 'network')) this.phase = 'error';
    this.changed();
  }

  private syncLock(): void {
    if (!this.game) return;
    if (this.phase === 'playing') this.game.session.unlock();
    else this.game.session.lock();
  }

  /** サーバーの状態を取り込み、フェーズを進める */
  private apply(state: MatchState): void {
    this.match = state;
    if (state.status === 'cancelled') {
      this.setPhase('cancelled');
      return;
    }
    if (state.status === 'finished') {
      this.game?.setFrozen(true);
      this.game?.session.lock();
      this.setPhase('done');
      return;
    }
    if (state.status === 'playing' && state.starts_at && state.ends_at) {
      this.startAt = Date.parse(state.starts_at);
      this.endsAt = Date.parse(state.ends_at);
      if (this.phase === 'joining' || this.phase === 'lobby') this.setPhase('countdown');
    } else if (this.phase === 'joining') {
      this.setPhase('lobby');
    }
  }

  private setPhase(phase: VersusPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.message = null;
    this.syncLock();
    this.changed();
  }

  private async poll(): Promise<void> {
    if (this.disposed || this.phase === 'done' || this.phase === 'cancelled' || this.phase === 'error') return;
    // 進行中の進捗報告は PROGRESS_MS ごと。それ以外は 1 秒ごとの状態確認
    const reportProgress = this.phase === 'playing' && performance.now() - this.lastProgressAt >= PROGRESS_MS;
    try {
      const next = await this.timed(() => (reportProgress ? api.matchProgress(this.matchId, this.myScore) : api.matchGet(this.matchId)));
      if (this.disposed) return;
      if (reportProgress) this.lastProgressAt = performance.now();
      this.apply(next);
      this.message = null;
      this.changed();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'network') {
        this.message = '通信が不安定です。再接続しています…';
        this.changed();
      } else if (error instanceof ApiError && error.code === 'not_found') {
        this.setError(error);
      }
    }
  }

  private tick(): void {
    if (this.disposed) return;
    const now = this.now();
    if (this.phase === 'countdown' && now >= this.startAt) {
      this.setPhase('playing');
      this.lastProgressAt = 0;
      void this.poll();
    }
    if (this.phase === 'playing') {
      if (now >= this.endsAt) void this.finish('time');
      else this.checkLead();
    }
    this.changed();
  }

  /** 相手が先に脱落していて、こちらが上回ったら、その場で決着をつける */
  private checkLead(): void {
    const opp = this.opponent;
    if (!opp || !opp.finished || !opp.eliminated || opp.final_score === null) return;
    if (performance.now() < this.leadRetryAt) return;
    if (this.game && this.game.session.phase === 'playing' && this.myScore > opp.final_score) void this.finish('lead');
  }

  /* -------------------------------------------------------------- snapshots */

  private async openChannel(): Promise<void> {
    const client = getClient();
    if (!client) return;
    try {
      await client.realtime.setAuth();
    } catch {
      /* 認証トークンはセッションから自動で渡される */
    }
    const ch = client.channel(`match:${this.matchId}`, { config: { private: true, broadcast: { self: false, ack: false } } });
    ch.on('broadcast', { event: 'snap' }, ({ payload }) => this.receive(payload));
    await new Promise<void>((resolve) => {
      const timeout = window.setTimeout(resolve, 4000);
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') this.channelReady = true;
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') this.channelReady = false;
        if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          window.clearTimeout(timeout);
          resolve();
        }
      });
    });
    this.channel = ch;
  }

  private receive(payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) return;
    const { s, a, n, q } = payload as Partial<Snapshot>;
    if (typeof s !== 'number' || typeof q !== 'number' || !Array.isArray(n) || n.length > 3 * 160 || n.length % 3 !== 0) return;
    if (!n.every((v) => typeof v === 'number' && Number.isFinite(v))) return;
    if (this.opponentBoard && q <= this.opponentBoard.q) return;     // 古い/重複した更新は捨てる
    this.opponentBoard = { s: Math.max(0, Math.floor(s)), a: a === 0 ? 0 : 1, n, q };
    this.lastSnapAt = performance.now();
  }

  private sendSnapshot(): void {
    if (this.disposed || !this.channel || !this.channelReady || !this.game) return;
    if (this.phase !== 'playing' && this.phase !== 'finishing') return;
    const { session } = this.game;
    const n: number[] = [];
    for (const piece of session.world.pieces.values()) {
      n.push(piece.level, Math.round(piece.body.position.x), Math.round(piece.body.position.y));
    }
    const snapshot: Snapshot = { s: session.score, a: session.phase === 'playing' && !this.finishing ? 1 : 0, n, q: ++this.seq };
    void this.channel.send({ type: 'broadcast', event: 'snap', payload: snapshot }).catch(() => undefined);
  }

  /* ----------------------------------------------------------------- finish */

  /** 'lead' が成立しなかったときに、対戦を再開する */
  private resume(retryDelayMs: number): void {
    this.leadRetryAt = performance.now() + retryDelayMs;
    this.finishing = false;
    this.game?.setFrozen(false);
    this.setPhase('playing');
  }

  /** 自分の対戦ログをサーバーへ提出する。通信が切れていても成功するまで繰り返す */
  private async finish(reason: 'over' | 'time' | 'lead'): Promise<void> {
    if (this.finishing || this.disposed) return;
    this.finishing = true;
    this.game?.setFrozen(true);
    this.game?.session.lock();
    this.setPhase('finishing');
    const log = [...this.log];
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length && !this.disposed; attempt++) {
      try {
        const res = await this.timed(() => api.matchFinish(this.matchId, log, reason) as Promise<MatchState>);
        if (this.disposed) return;
        if ('error' in res) {
          if (reason === 'lead') {
            this.resume(3000);               // まだ上回っていなかった: そのまま対戦を続ける
            return;
          }
          // サーバーがログを拒否した (通常は起きない)。結果はサーバーが確定するので状態確認だけ続ける
          this.message = '対戦結果を確認できませんでした。サーバーの判定を待っています…';
          this.changed();
          return;
        }
        this.apply(res);
        this.changed();
        return;
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'network') {
          // 'lead' が成立しなかった等。試合は続行できる場合だけ戻す
          if (reason === 'lead') this.resume(3000);
          return;
        }
        this.message = '通信が切れました。再接続して結果を送信します…';
        this.changed();
        await new Promise((resolve) => window.setTimeout(resolve, RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]));
      }
    }
  }
}
