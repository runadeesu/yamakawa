import { describe, expect, it, vi } from 'vitest';
import type { Game } from '../../game/Game';
import type { MatchState } from '../types';

vi.mock('../api', () => ({ api: {} }));
vi.mock('../client', () => ({ getClient: () => null }));

const { VersusRunner } = await import('./VersusRunner');

type SessionEventListener = (event: { type: string; level?: number }) => void;

function fakeGame(startStep: number) {
  let listener: SessionEventListener | null = null;
  const session = {
    stepCount: startStep,
    score: 0,
    phase: 'playing',
    locked: true,
    on(fn: SessionEventListener) {
      listener = fn;
      return () => undefined;
    },
    lock() {
      this.locked = true;
    },
    unlock() {
      this.locked = false;
    },
  };
  return { session, game: { session, setFrozen: () => undefined } as unknown as Game, emit: (e: { type: string; level?: number }) => listener?.(e) };
}

const playing: MatchState = {
  id: 'm', status: 'playing', mode: 'quick', me: 'a', starts_at: null, ends_at: null, ready_deadline: '', server_now: '',
  winner_id: null, result: null, end_reason: null, duration_ms: 120000, seq: [1, 2, 3], players: [],
};

describe('VersusRunner battle log', () => {
  it('counts steps from the moment the match starts, not from when the Game was created', () => {
    const runner = new VersusRunner('m', () => undefined);
    const { session, game, emit } = fakeGame(0);
    runner.attachGame(game);

    // ロビー〜カウントダウンの間に物理が 600 ステップ (10 秒) 先に進んでいる
    session.stepCount = 600;
    expect(session.locked).toBe(true);
    (runner as unknown as { setPhase(p: string): void }).setPhase('playing');
    expect(session.locked).toBe(false);

    session.stepCount = 630;
    emit({ type: 'drop', level: 1 });
    session.stepCount = 700;
    emit({ type: 'merge', level: 2 });

    const log = (runner as unknown as { log: Array<[number, number, number]> }).log;
    expect(log).toEqual([
      [30, 0, 1],
      [100, 1, 2],
    ]);
  });

  it('ignores game events outside the playing phase', () => {
    const runner = new VersusRunner('m', () => undefined);
    const { session, game, emit } = fakeGame(0);
    runner.attachGame(game);
    session.stepCount = 50;
    emit({ type: 'drop', level: 1 });
    expect((runner as unknown as { log: unknown[] }).log).toEqual([]);
    void playing;
  });
});
