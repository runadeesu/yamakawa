import { DANGER_Y, DROP_Y, FIELD_W, MAX_LEVEL, SCORE, TIMING } from './config';
import { levelDef } from './levels';
import { rollDropLevel, type Rng } from './rng';
import { TerukiWorld } from './world';

export type SessionEvent =
  | { type: 'drop'; level: number; x: number; y: number }
  | { type: 'merge'; level: number; x: number; y: number; points: number; combo: number; final: boolean }
  | { type: 'hit'; impact: number; level: number; x: number; y: number }
  | { type: 'hud' }
  | { type: 'danger'; active: boolean }
  | { type: 'gameover'; score: number; best: number; newBest: boolean; finalCount: number };

export type SessionPhase = 'playing' | 'over';

export function comboMultiplier(combo: number): number {
  return Math.min(SCORE.maxMultiplier, 1 + Math.max(0, combo - 1) * SCORE.comboStep);
}

/** 物理ワールドの上に載るゲームルール: 落下・スコア・コンボ・危険ライン・ゲームオーバー */
export class GameSession {
  readonly world = new TerukiWorld();
  phase: SessionPhase = 'playing';
  /** 経過した物理ステップ数。対戦ログ・コンボ判定の時間軸 (整数なのでサーバーと誤差なく一致する) */
  stepCount = 0;
  score = 0;
  best: number;
  combo = 0;
  finalCount = 0;
  currentLevel = 1;
  nextLevel = 1;
  aimX = FIELD_W / 2;
  /** 次のてるきが構えられるまでの残り時間 (ms) */
  cooldownMs = 0;
  /** 0〜1。危険ラインを超えている時間 / 許容時間 */
  dangerRatio = 0;

  private locked = false;
  private readonly rng: Rng;
  private readonly sequence: readonly number[] | undefined;
  private sequenceIndex = 0;
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private lastMergeStep = -Infinity;
  private lastHitAt = -Infinity;
  private dangerActive = false;
  private bestAtStart: number;

  /** sequence を渡すと、落ちてくるレベルをその順番どおりにする (オンライン対戦: 両者共通の出現順) */
  constructor(rng: Rng, best: number, sequence?: readonly number[]) {
    this.rng = rng;
    this.best = best;
    this.bestAtStart = best;
    this.sequence = sequence;
    this.rollQueue();
  }

  on(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private nextPiece(): number {
    if (this.sequence) {
      const level = this.sequence[this.sequenceIndex++];
      if (level !== undefined) return level;
    }
    return rollDropLevel(this.rng);
  }

  private rollQueue(): void {
    this.sequenceIndex = 0;
    this.currentLevel = this.nextPiece();
    this.nextLevel = this.nextPiece();
  }

  restart(): void {
    this.world.clear();
    this.phase = 'playing';
    this.score = 0;
    this.combo = 0;
    this.finalCount = 0;
    this.stepCount = 0;
    this.cooldownMs = 0;
    this.dangerRatio = 0;
    this.dangerActive = false;
    this.lastMergeStep = -Infinity;
    this.lastHitAt = -Infinity;
    this.aimX = FIELD_W / 2;
    this.bestAtStart = this.best;
    this.rollQueue();
    this.emit({ type: 'danger', active: false });
    this.emit({ type: 'hud' });
  }

  clampAim(x: number, level = this.currentLevel): number {
    const r = levelDef(level).radius;
    return Math.min(FIELD_W - r - 1, Math.max(r + 1, x));
  }

  setAim(x: number): void {
    this.aimX = this.clampAim(x);
  }

  /** 対戦のカウントダウン中・終了後は落とせないようにする */
  lock(): void {
    this.locked = true;
  }

  unlock(): void {
    this.locked = false;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  canDrop(): boolean {
    return this.phase === 'playing' && this.cooldownMs <= 0 && !this.locked;
  }

  /** 現在のてるきを aimX から落とす。クールダウン中・ゲームオーバー中は無視 */
  drop(): boolean {
    if (!this.canDrop()) return false;
    const level = this.currentLevel;
    const x = this.clampAim(this.aimX, level);
    this.world.spawn(level, x, DROP_Y);
    this.currentLevel = this.nextLevel;
    this.nextLevel = this.nextPiece();
    this.cooldownMs = TIMING.dropCooldownMs;
    this.addScore(SCORE.drop);
    this.aimX = this.clampAim(x);
    this.emit({ type: 'drop', level, x, y: DROP_Y });
    this.emit({ type: 'hud' });
    return true;
  }

  /** dt ms 分、ゲームを1ステップ進める */
  step(dt: number): void {
    if (this.phase !== 'playing') return;
    this.stepCount++;
    this.cooldownMs = Math.max(0, this.cooldownMs - dt);
    this.world.step(dt);
    this.processMerges();
    this.processHits();
    this.updateDanger(dt);
  }

  private addScore(points: number): void {
    this.score += points;
    if (this.score > this.best) this.best = this.score;
  }

  private processMerges(): void {
    for (const merge of this.world.resolveMerges()) {
      this.combo = this.stepCount - this.lastMergeStep <= TIMING.comboWindowSteps ? this.combo + 1 : 1;
      this.lastMergeStep = this.stepCount;
      const points = Math.round(levelDef(merge.level).score * comboMultiplier(this.combo));
      const final = merge.level === MAX_LEVEL;
      if (final) this.finalCount++;
      this.addScore(points);
      this.emit({ type: 'merge', level: merge.level, x: merge.x, y: merge.y, points, combo: this.combo, final });
      this.emit({ type: 'hud' });
    }
  }

  private processHits(): void {
    const hits = this.world.takeHits();
    if (hits.length === 0) return;
    const now = this.world.clock;
    if (now - this.lastHitAt < TIMING.hitSoundGapMs) return;
    const strongest = hits.reduce((a, b) => (b.impact > a.impact ? b : a));
    this.lastHitAt = now;
    this.emit({ type: 'hit', ...strongest });
  }

  private updateDanger(dt: number): void {
    const now = this.world.clock;
    let worst = 0;
    for (const piece of this.world.pieces.values()) {
      const top = piece.body.position.y - levelDef(piece.level).radius;
      if (now - piece.bornAt > TIMING.spawnGraceMs && top < DANGER_Y) {
        piece.dangerMs += dt;
        worst = Math.max(worst, piece.dangerMs);
      } else {
        piece.dangerMs = 0;
      }
    }
    this.dangerRatio = Math.min(1, worst / TIMING.dangerLimitMs);
    const active = worst > 0;
    if (active !== this.dangerActive) {
      this.dangerActive = active;
      this.emit({ type: 'danger', active });
    }
    if (worst >= TIMING.dangerLimitMs) this.endGame();
  }

  private endGame(): void {
    const newBest = this.score > this.bestAtStart;
    this.phase = 'over';
    this.emit({ type: 'gameover', score: this.score, best: this.best, newBest, finalCount: this.finalCount });
  }
}
