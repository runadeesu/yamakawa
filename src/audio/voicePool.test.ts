import { describe, expect, it } from 'vitest';
import { VoicePool } from './voicePool';
import { mulberry32 } from '../game/rng';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);

/** プールから n 回続けて「鳴らす」(いつも先頭を使う) */
function draw(pool: VoicePool, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const [id] = pool.peek(1);
    out.push(id!);
    pool.take(id!);
  }
  return out;
}

describe('VoicePool (シャッフルバッグ)', () => {
  it('一巡するあいだ、すべてのクリップがちょうど 1 回ずつ出る', () => {
    const pool = new VoicePool(ids(65), mulberry32(1));
    const round = draw(pool, 65);
    expect(new Set(round).size).toBe(65);
  });

  it('何巡しても、同じクリップが連続して出ない (巡の境目も含む)', () => {
    for (const seed of [1, 2, 3, 42, 777]) {
      const pool = new VoicePool(ids(8), mulberry32(seed));
      const seq = draw(pool, 8 * 50);
      for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
    }
  });

  it('毎回同じ順番にならない (ランダムである)', () => {
    const a = draw(new VoicePool(ids(20), mulberry32(1)), 20);
    const b = draw(new VoicePool(ids(20), mulberry32(2)), 20);
    expect(a).not.toEqual(b);
    // 二巡目も一巡目と別の並びになる
    const pool = new VoicePool(ids(20), mulberry32(5));
    const first = draw(pool, 20);
    const second = draw(pool, 20);
    expect(second).not.toEqual(first);
  });

  it('長い目で見て、ほぼ均等に使われる', () => {
    const pool = new VoicePool(ids(10), mulberry32(9));
    const counts = new Map<string, number>();
    for (const id of draw(pool, 1000)) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const n of counts.values()) expect(n).toBe(100);
  });

  it('peek は先頭の n 個を返し、take するまで減らない', () => {
    const pool = new VoicePool(ids(5), mulberry32(3));
    const head = pool.peek(3);
    expect(head).toHaveLength(3);
    expect(pool.peek(3)).toEqual(head);
    pool.take(head[1]!);                       // 先頭でないものを鳴らしても外れる (先読み未完了のものを飛ばす場合)
    expect(pool.peek(3)).toEqual([head[0], head[2], pool.peek(3)[2]]);
    expect(pool.peek(10)).not.toContain(head[1]);
  });

  it('remove した (読み込めない) クリップは二度と出ない', () => {
    const pool = new VoicePool(ids(6), mulberry32(4));
    pool.remove('c2');
    const seq = draw(pool, 5 * 4);
    expect(seq).not.toContain('c2');
    expect(new Set(seq).size).toBe(5);
  });

  it('1 個だけでも動く (連続になるのは避けようがない)', () => {
    const pool = new VoicePool(['only'], mulberry32(1));
    expect(draw(pool, 3)).toEqual(['only', 'only', 'only']);
  });

  it('空でも落ちない', () => {
    const pool = new VoicePool([], mulberry32(1));
    expect(pool.peek(3)).toEqual([]);
    pool.take('x');
    pool.remove('x');
    expect(pool.size).toBe(0);
  });

  it('重複した id は 1 つにまとめる', () => {
    expect(new VoicePool(['a', 'a', 'b'], mulberry32(1)).size).toBe(2);
  });
});
