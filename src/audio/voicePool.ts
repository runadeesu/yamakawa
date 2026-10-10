/**
 * ボイスをランダムに選ぶ「シャッフルバッグ」。
 *   - 全クリップをシャッフルして順に使い、使い切ったら入れ直す。
 *     → 一巡するまで同じクリップは出ず、かといって毎回ばらばら (連続は絶対にない)
 *   - 先頭の数個を先読みしておけるよう、「次に来る候補」を peek できる
 * 乱数は引数で差し替えられる (テスト用)。DOM にも Web Audio にも依存しない。
 */
export class VoicePool {
  private readonly all: string[];
  private readonly rng: () => number;
  private queue: string[] = [];
  private last: string | null = null;

  constructor(ids: readonly string[], rng: () => number = Math.random) {
    this.all = [...new Set(ids)];
    this.rng = rng;
    this.refill();
  }

  get size(): number {
    return this.all.length;
  }

  /** 次に鳴らす候補 (先頭から n 個)。まだ使っていないものだけ */
  peek(n: number): string[] {
    return this.queue.slice(0, n);
  }

  /** 鳴らした (または使えないと分かった) クリップをバッグから外す。バッグが空になったら入れ直す */
  take(id: string): void {
    const i = this.queue.indexOf(id);
    if (i >= 0) this.queue.splice(i, 1);
    this.last = id;
    if (this.queue.length === 0) this.refill();
  }

  /** 読み込めないなど、二度と使わないクリップを除く */
  remove(id: string): void {
    const i = this.all.indexOf(id);
    if (i >= 0) this.all.splice(i, 1);
    const q = this.queue.indexOf(id);
    if (q >= 0) this.queue.splice(q, 1);
    if (this.queue.length === 0) this.refill();
  }

  private refill(): void {
    const next = [...this.all];
    // Fisher-Yates
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [next[i], next[j]] = [next[j]!, next[i]!];
    }
    // 入れ直した直後に、直前に鳴らしたものが先頭に来ないようにする
    if (next.length > 1 && next[0] === this.last) {
      const swap = 1 + Math.floor(this.rng() * (next.length - 1));
      [next[0], next[swap]] = [next[swap]!, next[0]!];
    }
    this.queue = next;
  }
}
