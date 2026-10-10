/** 論理フィールド座標 (px)。実際の描画サイズは Game がスケーリングする。 */
export const FIELD_W = 360;
export const FIELD_H = 580;
/** 落下位置 (保持中のてるきが浮かぶ高さ) */
export const DROP_Y = 54;
/** 危険ライン。この線より上にてるきが居座るとゲームオーバー */
export const DANGER_Y = 122;

export const MAX_LEVEL = 8;
/** 落ちてくるのは Level 1〜4 のみ */
export const DROP_WEIGHTS: readonly number[] = [38, 30, 20, 12];

export const PHYSICS = {
  gravity: 1.5,
  restitution: 0.12,
  friction: 0.12,
  frictionStatic: 0.6,
  frictionAir: 0.004,
  density: 0.0012,
  /** 円近似のポリゴン最大辺数 */
  circleSides: 36,
  positionIterations: 10,
  velocityIterations: 8,
  /** 固定タイムステップ (ms) */
  stepMs: 1000 / 60,
  /** 1フレームで消化する最大ステップ数 (スパイラル防止) */
  maxStepsPerFrame: 4,
  /** 1ステップあたりの最大速度 (px/step)。トンネリング防止 */
  maxSpeed: 20,
  angularDamping: 0.985,
  inertiaScale: 2,
  wallThickness: 120,
  wallFriction: 0.2,
  wallRestitution: 0.05,
  /** 合体後の速度・角速度の継承率 */
  mergeVelocityKeep: 0.5,
  mergeMaxSpeed: 6,
} as const;

export const TIMING = {
  /** 落下後、次のてるきが構えられるまで */
  dropCooldownMs: 480,
  /** 連続合体とみなす間隔 (物理ステップ数。1400ms 相当)。対戦のサーバー検証と同じ整数で数える */
  comboWindowSteps: 84,
  /** 生成直後は危険ライン判定をしない猶予 */
  spawnGraceMs: 1600,
  /** 危険ラインを超え続けて良い時間 */
  dangerLimitMs: 2200,
  /** ゲームオーバー画面を出すまでの間 (盤面を見せる) */
  gameOverDelayMs: 900,
  /** 衝突音の最小間隔 */
  hitSoundGapMs: 70,
} as const;

export const SCORE = {
  drop: 1,
  /** コンボ倍率: 1 + (combo-1) * step、上限 maxMultiplier */
  comboStep: 0.5,
  maxMultiplier: 3,
} as const;

export const INPUT = {
  keyboardSpeed: 260,
  /** 衝突音を鳴らす最小の相対速度 */
  minHitImpact: 1.6,
} as const;

export const STORAGE_KEYS = {
  best: 'teruki_best_score',
  voice: 'teruki_sound_enabled',
  sfx: 'teruki_sfx_enabled',
} as const;
