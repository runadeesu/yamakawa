import { comboMultiplier } from '../../src/game/session';
import { levelDef } from '../../src/game/levels';

export type LogEvent = [step: number, kind: 0 | 1 | 2, arg: number];

/**
 * ルールどおりに落として即合体させる「理想的な」ログを作り、クライアントのルール関数で期待スコアを計算する。
 * (サーバーの SQL とは別実装 = クライアントの src/game のコードで検算する)
 */
export function buildLog(seq: number[], drops: number, gap = 30): { log: LogEvent[]; score: number; lastStep: number } {
  const log: LogEvent[] = [];
  const counts = new Array(9).fill(0) as number[];
  let score = 0;
  let combo = 0;
  let lastMerge = -Infinity;
  let step = 0;
  for (let i = 0; i < drops; i++) {
    const level = seq[i]!;
    log.push([step, 0, level]);
    counts[level]!++;
    score += 1;
    let t = step + 6;
    for (let l = 1; l < 8; l++) {
      while (counts[l]! >= 2) {
        counts[l]! -= 2;
        counts[l + 1]!++;
        combo = t - lastMerge <= 84 ? combo + 1 : 1;
        lastMerge = t;
        score += Math.round(levelDef(l + 1).score * comboMultiplier(combo));
        log.push([t, 1, l + 1]);
        t += 8;
      }
    }
    step = Math.max(step + gap, t);   // 連鎖が長くても時刻の昇順を保つ
  }
  return { log, score, lastStep: step };
}
