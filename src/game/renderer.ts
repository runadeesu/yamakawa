import { DANGER_Y, DROP_Y, FIELD_H, FIELD_W, MAX_LEVEL, PHYSICS, TIMING } from './config';
import { FONT_STACK, type Effects } from './effects';
import { levelDef } from './levels';
import type { GameSession } from './session';
import type { SpriteSet } from './sprites';

const POP_MS = 300;

const easeOutBack = (t: number): number => {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

export interface SceneState {
  session: GameSession;
  effects: Effects;
  sprites: SpriteSet;
  /** 固定ステップ間の補間率 0..1 */
  alpha: number;
  /** 実時間 (ms) */
  time: number;
}

function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSet,
  level: number,
  x: number,
  y: number,
  angle: number,
  scale: number,
): void {
  const sprite = sprites.canvases[level - 1];
  const extent = sprites.extents[level - 1];
  if (!sprite || extent === undefined) return;
  ctx.save();
  ctx.translate(x, y);
  if (angle !== 0) ctx.rotate(angle);
  if (scale !== 1) ctx.scale(scale, scale);
  ctx.drawImage(sprite, -extent, -extent, extent * 2, extent * 2);
  ctx.restore();
}

function drawDangerLine(ctx: CanvasRenderingContext2D, ratio: number, time: number): void {
  const pulse = 0.5 + 0.5 * Math.sin(time / 90);
  if (ratio > 0) {
    const g = ctx.createLinearGradient(0, DANGER_Y - 60, 0, DANGER_Y);
    g.addColorStop(0, 'rgba(255,60,90,0)');
    g.addColorStop(1, `rgba(255,60,90,${0.12 + 0.28 * ratio * pulse})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, DANGER_Y - 60, FIELD_W, 60);
  }
  ctx.lineWidth = ratio > 0 ? 3 : 2;
  ctx.setLineDash([10, 8]);
  ctx.strokeStyle = ratio > 0 ? `rgba(255,${Math.round(90 - 50 * pulse)},110,${0.7 + 0.3 * pulse})` : 'rgba(255,120,140,0.5)';
  ctx.beginPath();
  ctx.moveTo(0, DANGER_Y);
  ctx.lineTo(FIELD_W, DANGER_Y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `900 11px ${FONT_STACK}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = ratio > 0 ? 'rgba(255,140,150,0.95)' : 'rgba(255,150,165,0.55)';
  ctx.fillText(ratio > 0 ? 'DANGER!' : 'LINE', FIELD_W - 6, DANGER_Y - 3);
}

function drawFinalAura(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, time: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(time / 1800);
  ctx.globalAlpha = 0.28 + 0.08 * Math.sin(time / 260);
  ctx.fillStyle = '#ffe066';
  const rays = 12;
  const outer = radius * 1.7;
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, outer, a, a + Math.PI / rays);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

export function drawScene(ctx: CanvasRenderingContext2D, scene: SceneState): void {
  const { session, effects, sprites, alpha, time } = scene;
  ctx.clearRect(0, 0, FIELD_W, FIELD_H);
  ctx.imageSmoothingQuality = 'high';

  drawDangerLine(ctx, session.dangerRatio, time);

  const pieces = [...session.world.pieces.values()];
  for (const p of pieces) {
    if (p.level === MAX_LEVEL) {
      const radius = levelDef(p.level).radius;
      drawFinalAura(ctx, p.body.position.x, p.body.position.y, radius, time);
    }
  }
  for (const p of pieces) {
    const { body } = p;
    const x = p.prevX + (body.position.x - p.prevX) * alpha;
    const y = p.prevY + (body.position.y - p.prevY) * alpha;
    const angle = p.prevAngle + (body.angle - p.prevAngle) * alpha;
    let scale = 1;
    if (p.merged) {
      const age = session.world.clock - p.bornAt + alpha * PHYSICS.stepMs;
      if (age < POP_MS) scale = 0.55 + 0.45 * easeOutBack(age / POP_MS);
    }
    drawSprite(ctx, sprites, p.level, x, y, angle, scale);
  }

  if (session.phase === 'playing') drawHeld(ctx, scene);
  effects.draw(ctx);
}

function drawHeld(ctx: CanvasRenderingContext2D, scene: SceneState): void {
  const { session, sprites, time } = scene;
  const level = session.currentLevel;
  const radius = levelDef(level).radius;
  const x = session.clampAim(session.aimX);
  const ready = 1 - session.cooldownMs / TIMING.dropCooldownMs;
  if (session.cooldownMs <= 0) {
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 9]);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, DROP_Y + radius + 4);
    ctx.lineTo(x, FIELD_H);
    ctx.stroke();
    ctx.restore();
  }
  const bob = session.cooldownMs <= 0 ? Math.sin(time / 200) * 2 : 0;
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0, ready * 1.6));
  drawSprite(ctx, sprites, level, x, DROP_Y + bob, 0, 0.45 + 0.55 * easeOutBack(Math.min(1, Math.max(0, ready))));
  ctx.restore();
}
