export type VoiceKind = 'merge' | 'big' | 'final';
export type VoiceVerdict = 'play' | 'interrupt' | 'skip';

export const VOICE_RULES = {
  /** 通常合体: 前のボイスが終わってからこの時間は鳴らさない */
  gapAfterEndMs: 250,
  /** 大型合体: 直前の開始からこの時間たてば再生中でも割り込める */
  bigMinGapMs: 500,
  /** 最終形態: ほぼ常に鳴らす (二重トリガー防止の最小間隔のみ) */
  finalMinGapMs: 200,
} as const;

/**
 * ボイス (ユーザー提供MP3) の再生可否を決める。時刻は呼び出し側から渡す純粋ロジック。
 * ボイスは常に最大1本。連続合体で何本も重なることはない。
 */
export class VoiceScheduler {
  private lastStart = -Infinity;
  private lastDuration = 0;

  decide(now: number, kind: VoiceKind): VoiceVerdict {
    const sinceStart = now - this.lastStart;
    const playing = sinceStart < this.lastDuration;
    switch (kind) {
      case 'merge':
        return sinceStart >= this.lastDuration + VOICE_RULES.gapAfterEndMs ? 'play' : 'skip';
      case 'big':
        if (sinceStart < VOICE_RULES.bigMinGapMs) return 'skip';
        return playing ? 'interrupt' : 'play';
      case 'final':
        if (sinceStart < VOICE_RULES.finalMinGapMs) return 'skip';
        return playing ? 'interrupt' : 'play';
    }
  }

  commit(now: number, durationMs: number): void {
    this.lastStart = now;
    this.lastDuration = durationMs;
  }

  reset(): void {
    this.lastStart = -Infinity;
    this.lastDuration = 0;
  }
}
