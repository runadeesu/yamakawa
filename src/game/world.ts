import Matter from 'matter-js';
import { FIELD_H, FIELD_W, INPUT, MAX_LEVEL, PHYSICS } from './config';
import { levelDef } from './levels';

const { Engine, Bodies, Body, Composite, Events } = Matter;

export interface Piece {
  id: number;
  level: number;
  body: Matter.Body;
  /** 生成された時刻 (world.clock, ms) */
  bornAt: number;
  /** 合体で生まれたか (描画側のポップアニメーション用) */
  merged: boolean;
  /** 危険ラインの上に居続けている時間 (ms) */
  dangerMs: number;
  /** 直前ステップ開始時の姿勢。描画の補間用 */
  prevX: number;
  prevY: number;
  prevAngle: number;
}

export interface MergeResult {
  piece: Piece;
  level: number;
  x: number;
  y: number;
}

export interface HitInfo {
  impact: number;
  level: number;
  x: number;
  y: number;
}

/**
 * Matter.js の世界。物理・衝突検出・合体の実行だけを担当し、
 * スコアや演出などのゲームルールは知らない。
 */
export class TerukiWorld {
  readonly engine: Matter.Engine;
  readonly pieces = new Map<number, Piece>();
  /** シミュレーション時間 (ms)。物理ステップの累積 */
  clock = 0;

  /** 合体待ちのペア。検出した時点で mergingIds に登録して二重実行を防ぐ */
  private pending: Array<[Piece, Piece]> = [];
  private readonly mergingIds = new Set<number>();
  private hits: HitInfo[] = [];

  constructor() {
    this.engine = Engine.create({
      gravity: { x: 0, y: PHYSICS.gravity },
      positionIterations: PHYSICS.positionIterations,
      velocityIterations: PHYSICS.velocityIterations,
      enableSleeping: false,
    });
    this.addWalls();
    const onCollide = (event: Matter.IEventCollision<Matter.Engine>) => this.handleCollisions(event);
    Events.on(this.engine, 'collisionStart', onCollide);
    Events.on(this.engine, 'collisionActive', onCollide);
  }

  private addWalls(): void {
    const t = PHYSICS.wallThickness;
    const opts: Matter.IChamferableBodyDefinition = {
      isStatic: true,
      friction: PHYSICS.wallFriction,
      restitution: PHYSICS.wallRestitution,
      label: 'wall',
    };
    const tall = FIELD_H + 4000;
    Composite.add(this.engine.world, [
      Bodies.rectangle(FIELD_W / 2, FIELD_H + t / 2, FIELD_W + t * 4, t, opts),
      Bodies.rectangle(-t / 2, FIELD_H - tall / 2, t, tall, opts),
      Bodies.rectangle(FIELD_W + t / 2, FIELD_H - tall / 2, t, tall, opts),
    ]);
  }

  spawn(level: number, x: number, y: number, vx = 0, vy = 0, angularVelocity = 0, merged = false): Piece {
    const radius = levelDef(level).radius;
    const body = Bodies.circle(
      x,
      y,
      radius,
      {
        restitution: PHYSICS.restitution,
        friction: PHYSICS.friction,
        frictionStatic: PHYSICS.frictionStatic,
        frictionAir: PHYSICS.frictionAir,
        density: PHYSICS.density,
        label: 'teruki',
      },
      PHYSICS.circleSides,
    );
    Body.setInertia(body, body.inertia * PHYSICS.inertiaScale);
    Body.setVelocity(body, { x: vx, y: vy });
    Body.setAngularVelocity(body, angularVelocity);
    Composite.add(this.engine.world, body);
    const piece: Piece = {
      id: body.id,
      level,
      body,
      bornAt: this.clock,
      merged,
      dangerMs: 0,
      prevX: body.position.x,
      prevY: body.position.y,
      prevAngle: body.angle,
    };
    this.pieces.set(piece.id, piece);
    return piece;
  }

  private remove(piece: Piece): void {
    Composite.remove(this.engine.world, piece.body);
    this.pieces.delete(piece.id);
    this.mergingIds.delete(piece.id);
  }

  clear(): void {
    for (const piece of this.pieces.values()) Composite.remove(this.engine.world, piece.body);
    this.pieces.clear();
    this.pending = [];
    this.mergingIds.clear();
    this.hits = [];
    this.clock = 0;
  }

  step(dt: number): void {
    for (const piece of this.pieces.values()) {
      piece.prevX = piece.body.position.x;
      piece.prevY = piece.body.position.y;
      piece.prevAngle = piece.body.angle;
    }
    Engine.update(this.engine, dt);
    this.clock += dt;
    for (const piece of this.pieces.values()) this.stabilize(piece);
  }

  /** 速度制限・回転減衰・フィールド外への脱出防止 */
  private stabilize(piece: Piece): void {
    const { body } = piece;
    const radius = levelDef(piece.level).radius;
    const { x, y } = body.position;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      Body.setPosition(body, { x: FIELD_W / 2, y: radius });
      Body.setVelocity(body, { x: 0, y: 0 });
      return;
    }
    if (x < radius - 2 || x > FIELD_W - radius + 2 || y > FIELD_H - radius + 2) {
      Body.setPosition(body, {
        x: Math.min(FIELD_W - radius, Math.max(radius, x)),
        y: Math.min(FIELD_H - radius, y),
      });
    }
    const speed = Math.hypot(body.velocity.x, body.velocity.y);
    if (speed > PHYSICS.maxSpeed) {
      const k = PHYSICS.maxSpeed / speed;
      Body.setVelocity(body, { x: body.velocity.x * k, y: body.velocity.y * k });
    }
    Body.setAngularVelocity(body, body.angularVelocity * PHYSICS.angularDamping);
  }

  private handleCollisions(event: Matter.IEventCollision<Matter.Engine>): void {
    try {
      for (const pair of event.pairs) {
        const a = this.pieces.get(pair.bodyA.id);
        const b = this.pieces.get(pair.bodyB.id);
        const piece = a ?? b;
        if (!piece) continue;

        if (a && b && a.level === b.level && a.level < MAX_LEVEL && !this.mergingIds.has(a.id) && !this.mergingIds.has(b.id)) {
          this.mergingIds.add(a.id);
          this.mergingIds.add(b.id);
          this.pending.push([a, b]);
          continue;
        }

        const { normal } = pair.collision;
        const rvx = pair.bodyA.velocity.x - pair.bodyB.velocity.x;
        const rvy = pair.bodyA.velocity.y - pair.bodyB.velocity.y;
        const impact = Math.abs(rvx * normal.x + rvy * normal.y);
        if (impact >= INPUT.minHitImpact) {
          this.hits.push({ impact, level: piece.level, x: piece.body.position.x, y: piece.body.position.y });
        }
      }
    } catch (error) {
      console.warn('collision handler failed', error);
    }
  }

  /** 検出済みの合体を実行する。A, B を消して level+1 を平均位置に生成する */
  resolveMerges(): MergeResult[] {
    const results: MergeResult[] = [];
    const queue = this.pending;
    this.pending = [];
    for (const [a, b] of queue) {
      if (!this.pieces.has(a.id) || !this.pieces.has(b.id)) {
        this.mergingIds.delete(a.id);
        this.mergingIds.delete(b.id);
        continue;
      }
      const newLevel = a.level + 1;
      const radius = levelDef(newLevel).radius;
      const x = Math.min(FIELD_W - radius, Math.max(radius, (a.body.position.x + b.body.position.x) / 2));
      const y = Math.min(FIELD_H - radius, (a.body.position.y + b.body.position.y) / 2);
      const keep = PHYSICS.mergeVelocityKeep;
      const limit = PHYSICS.mergeMaxSpeed;
      const vx = clamp(((a.body.velocity.x + b.body.velocity.x) / 2) * keep, limit);
      const vy = clamp(((a.body.velocity.y + b.body.velocity.y) / 2) * keep, limit);
      const spin = ((a.body.angularVelocity + b.body.angularVelocity) / 2) * keep;

      this.remove(a);
      this.remove(b);
      const piece = this.spawn(newLevel, x, y, vx, vy, spin, true);
      results.push({ piece, level: newLevel, x, y });
    }
    return results;
  }

  takeHits(): HitInfo[] {
    const hits = this.hits;
    this.hits = [];
    return hits;
  }
}

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}
