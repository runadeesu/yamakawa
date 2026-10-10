import type { AudioManager } from '../audio/AudioManager';
import { loadBest, saveBest } from '../storage';
import { FIELD_H, FIELD_W, INPUT, PHYSICS, TIMING } from './config';
import { Effects } from './effects';
import { InputController } from './input';
import { levelDef } from './levels';
import { drawScene } from './renderer';
import { mulberry32 } from './rng';
import { GameSession, type SessionEvent } from './session';
import type { SpriteSet } from './sprites';

export interface HudState {
  score: number;
  best: number;
  nextLevel: number;
}

export interface GameResult {
  score: number;
  best: number;
  newBest: boolean;
  finalCount: number;
}

export interface GameOptions {
  canvas: HTMLCanvasElement;
  /** キャンバスを収める領域。この中に収まる最大サイズにフィールドを合わせる */
  stage: HTMLElement;
  /** キャンバスを包む要素。サイズ指定と画面シェイクの対象 */
  frame: HTMLElement;
  sprites: SpriteSet;
  audio: AudioManager;
  /** オンライン対戦: 落ちてくる順番をサーバー指定にし、開始までは落とせないようにする */
  sequence?: readonly number[];
  onHud(hud: HudState): void;
  onGameOver(result: GameResult): void;
}

const RAINBOW = ['#ff4d4d', '#ffd43b', '#4dff88', '#4dc3ff', '#b57bff', '#ff4dc4'] as const;

/**
 * ブラウザ側の司令塔。固定ステップの物理ループ・描画・入力・音・演出をつなぐ。
 * React の state には依存せず、HUD への通知だけをコールバックで行う。
 */
export class Game {
  readonly session: GameSession;
  readonly effects = new Effects();

  private readonly o: GameOptions;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly input: InputController;
  private readonly resizeObserver: ResizeObserver;
  private readonly offSession: () => void;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private scale = 1;
  private savedBest: number;
  private gameOverTimer = 0;
  private shaking = false;
  private running = false;
  private frozen = false;
  private readonly reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  constructor(options: GameOptions) {
    this.o = options;
    const ctx = options.canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;

    const seed = new URLSearchParams(window.location.search).get('seed');
    const rng = seed !== null && Number.isFinite(Number(seed)) ? mulberry32(Number(seed)) : Math.random;
    this.savedBest = loadBest();
    this.session = new GameSession(rng, this.savedBest, options.sequence);
    if (options.sequence) this.session.lock();
    this.offSession = this.session.on((event) => this.onSessionEvent(event));

    this.input = new InputController(options.canvas, {
      aim: (x) => this.session.setAim(x),
      drop: () => this.session.drop(),
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(options.stage);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.resize();
    this.emitHud();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.gameOverTimer);
    this.input.dispose();
    this.resizeObserver.disconnect();
    this.offSession();
    this.o.frame.style.transform = '';
  }

  /** 物理の更新を止める (対戦終了後。描画と演出は続く) */
  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
  }

  restart(): void {
    window.clearTimeout(this.gameOverTimer);
    this.effects.reset();
    this.acc = 0;
    this.session.restart();
  }

  private resize(): void {
    const { stage, frame, canvas } = this.o;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    if (sw <= 0 || sh <= 0) return;
    const cssW = Math.floor(Math.min(sw, (sh * FIELD_W) / FIELD_H));
    const cssH = Math.floor((cssW * FIELD_H) / FIELD_W);
    frame.style.width = `${cssW}px`;
    frame.style.height = `${cssH}px`;
    // HUD とボタン列をフィールド幅に揃える (PC・タブレットで横に間延びしないように)
    stage.parentElement?.style.setProperty('--field-w', `${cssW + 8}px`);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    this.scale = canvas.width / FIELD_W;
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(50, Math.max(0, now - this.last));
    this.last = now;

    const { session } = this;
    if (this.input.direction !== 0 && session.phase === 'playing') {
      session.setAim(session.aimX + (this.input.direction * INPUT.keyboardSpeed * dt) / 1000);
    }

    this.acc += this.frozen ? 0 : dt;
    let steps = 0;
    while (this.acc >= PHYSICS.stepMs && steps < PHYSICS.maxStepsPerFrame) {
      session.step(PHYSICS.stepMs);
      this.acc -= PHYSICS.stepMs;
      steps++;
    }
    if (steps === PHYSICS.maxStepsPerFrame) this.acc = 0;

    this.effects.update(dt);
    this.applyShake();

    const { ctx } = this;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    drawScene(ctx, {
      session,
      effects: this.effects,
      sprites: this.o.sprites,
      alpha: session.phase === 'playing' ? this.acc / PHYSICS.stepMs : 1,
      time: now,
    });
  };

  private applyShake(): void {
    const { frame } = this.o;
    if (this.effects.isShaking && !this.reducedMotion) {
      const { x, y } = this.effects.shakeOffset();
      frame.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      this.shaking = true;
    } else if (this.shaking) {
      frame.style.transform = '';
      this.shaking = false;
    }
  }

  private emitHud(): void {
    const { session } = this;
    this.o.onHud({ score: session.score, best: session.best, nextLevel: session.nextLevel });
  }

  private onSessionEvent(event: SessionEvent): void {
    const { audio } = this.o;
    switch (event.type) {
      case 'drop':
        audio.drop();
        break;
      case 'hit':
        audio.hit(event.impact, event.level);
        break;
      case 'merge':
        this.onMerge(event);
        break;
      case 'hud':
        if (!this.o.sequence && this.session.best > this.savedBest) {
          this.savedBest = this.session.best;
          saveBest(this.savedBest);
        }
        this.emitHud();
        break;
      case 'danger':
        break;
      case 'gameover':
        this.onGameOver(event);
        break;
    }
  }

  private onMerge(e: Extract<SessionEvent, { type: 'merge' }>): void {
    const { effects } = this;
    const { audio } = this.o;
    const def = levelDef(e.level);
    const comboBoost = Math.min(e.combo - 1, 5);

    effects.burst(e.x, e.y, {
      count: 8 + e.level * 3 + comboBoost * 5,
      speed: 160 + e.level * 22,
      colors: [def.ring, def.accent, '#ffffff', '#ffe066'],
      size: 4 + e.level * 0.35,
    });
    effects.wave(e.x, e.y, def.radius * 0.8, def.ring);
    effects.popup(`+${e.points}`, e.x, e.y - def.radius - 4, e.combo >= 2 ? '#ffe066' : '#ffffff', 20 + Math.min(e.level, 8) * 1.5);
    effects.shake(1.5 + e.level * 0.5 + comboBoost * 1.2);

    if (e.combo >= 2) {
      effects.banner(
        'combo',
        `${e.combo} COMBO${'!'.repeat(Math.min(e.combo - 1, 3))}`,
        ['#fff7a8', '#ff9f1c'],
        28 + Math.min(e.combo, 6) * 3,
        FIELD_H * 0.3,
        900,
      );
    }

    audio.merge(e.level, e.combo);
    if (e.final) {
      this.onFinalForm(e);
      audio.final();
      audio.playVoice('final');
    } else {
      audio.playVoice(e.level >= 6 ? 'big' : 'merge');
      if (e.level >= 6) effects.flash(0.22, '255,255,255');
    }
  }

  private onFinalForm(e: Extract<SessionEvent, { type: 'merge' }>): void {
    const { effects } = this;
    effects.flash(0.95, '255,244,200');
    effects.shake(16);
    effects.burst(e.x, e.y, { count: 110, speed: 560, colors: RAINBOW, size: 7, life: 1200 });
    effects.burst(FIELD_W / 2, FIELD_H / 2, { count: 60, speed: 420, colors: ['#ffe066', '#ffffff'], size: 6, life: 1400, gravity: 500 });
    effects.wave(e.x, e.y, levelDef(e.level).radius, '#ffe066', 700);
    effects.wave(e.x, e.y, levelDef(e.level).radius * 0.6, '#ffffff', 900);
    effects.banner('final', 'FINAL TERUKI', ['#fff7a8', '#ffb300'], 46, FIELD_H * 0.4, 2400, `+${e.points}`);
  }

  private onGameOver(e: Extract<SessionEvent, { type: 'gameover' }>): void {
    this.effects.shake(12);
    this.effects.flash(0.45, '255,60,90');
    this.o.audio.gameOver();
    window.clearTimeout(this.gameOverTimer);
    this.gameOverTimer = window.setTimeout(
      () => this.o.onGameOver({ score: e.score, best: e.best, newBest: e.newBest, finalCount: e.finalCount }),
      TIMING.gameOverDelayMs,
    );
  }
}
