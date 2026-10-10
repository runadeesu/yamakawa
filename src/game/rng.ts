import { DROP_WEIGHTS } from './config';

export type Rng = () => number;

/** 再現性のあるテスト用乱数 (?seed=N) */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rollDropLevel(rng: Rng): number {
  const total = DROP_WEIGHTS.reduce((sum, w) => sum + w, 0);
  let r = rng() * total;
  for (let i = 0; i < DROP_WEIGHTS.length; i++) {
    r -= DROP_WEIGHTS[i] ?? 0;
    if (r < 0) return i + 1;
  }
  return 1;
}
