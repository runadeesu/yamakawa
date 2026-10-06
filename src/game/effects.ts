import { FIELD_H, FIELD_W } from './config';

export const FONT_STACK =
  '"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Noto Sans JP","Meiryo",system-ui,sans-serif';

const MAX_PARTICLES = 260;
const TAU = Math.PI * 2;

type ParticleShape = 'dot' | 'square' | 'star';

interface Particle {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  rot: number;
  spin: number;
  gravity: number;
  color: string;
  shape: ParticleShape;
}

interface Popup {
  text: string;
  x: number;
  y: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}

interface Wave {
  x: number;
  y: number;
  radius: number;
  grow: number;
  life: number;
  maxLife: number;
  color: string;
}

interface Banner {
  key: string;
  text: string;
  sub: string;
  life: number;
  maxLife: number;
  size: number;
  colors: [string, string];
  y: number;
}

export interface BurstOptions {
  count: number;
  speed: number;
  colors: readonly string[];
  size?: number;
  gravity?: number;
  life?: number;
  shapes?: readonly ParticleShape[];
}

const easeOutBack = (t: number): number => {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/** パーティクル・スコアポップアップ・バナー・フラッシュ・画面シェイク。すべて Canvas 上で描く */
export class Effects {
  private readonly particles: Particle[] = Array.from({ length: MAX_PARTICLES }, () => ({
    active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 1, rot: 0, spin: 0, gravity: 0,
    color: '#fff', shape: 'dot' as ParticleShape,
  }));
  private cursor = 0;
  private popups: Popup[] = [];
  private waves: Wave[] = [];
  private banners: Banner[] = [];
  private shakePower = 0;
  private flashAlpha = 0;
  private flashColor = '255,255,255';

  reset(): void {
    for (const p of this.particles) p.active = false;
    this.popups = [];
    this.waves = [];
    this.banners = [];
    this.shakePower = 0;
    this.flashAlpha = 0;
  }

  burst(x: number, y: number, o: BurstOptions): void {
    const shapes = o.shapes ?? ['dot', 'square', 'star'];
    for (let i = 0; i < o.count; i++) {
      const p = this.particles[this.cursor];
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      if (!p) continue;
      const angle = Math.random() * TAU;
      const speed = o.speed * (0.35 + Math.random() * 0.75);
      p.active = true;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed - o.speed * 0.25;
      p.maxLife = (o.life ?? 650) * (0.7 + Math.random() * 0.6);
      p.life = p.maxLife;
      p.size = (o.size ?? 5) * (0.6 + Math.random() * 0.8);
      p.rot = Math.random() * TAU;
      p.spin = (Math.random() - 0.5) * 12;
      p.gravity = o.gravity ?? 900;
      p.color = o.colors[Math.floor(Math.random() * o.colors.length)] ?? '#fff';
      p.shape = shapes[Math.floor(Math.random() * shapes.length)] ?? 'dot';
    }
  }

  wave(x: number, y: number, radius: number, color: string, life = 420): void {
    this.waves.push({ x, y, radius, grow: radius * 2.4, life, maxLife: life, color });
    if (this.waves.length > 12) this.waves.shift();
  }

  popup(text: string, x: number, y: number, color: string, size = 22): void {
    const margin = 40;
    this.popups.push({
      text,
      x: Math.min(FIELD_W - margin, Math.max(margin, x)),
      y,
      life: 900,
      maxLife: 900,
      size,
      color,
    });
    if (this.popups.length > 14) this.popups.shift();
  }

  /** 同じ key のバナーは置き換える (連続コンボで文字が重ならないように) */
  banner(key: string, text: string, colors: [string, string], size: number, y: number, ms: number, sub = ''): void {
    this.banners = this.banners.filter((b) => b.key !== key);
    this.banners.push({ key, text, sub, life: ms, maxLife: ms, size, colors, y });
  }

  shake(power: number): void {
    this.shakePower = Math.min(16, Math.max(this.shakePower, power));
  }

  flash(alpha: number, rgb = '255,255,255'): void {
    this.flashAlpha = Math.max(this.flashAlpha, alpha);
    this.flashColor = rgb;
  }

  /** 画面シェイクのオフセット (CSS px)。Game が DOM に適用する */
  shakeOffset(): { x: number; y: number } {
    if (this.shakePower < 0.15) return { x: 0, y: 0 };
    return { x: (Math.random() - 0.5) * 2 * this.shakePower, y: (Math.random() - 0.5) * 2 * this.shakePower };
  }

  get isShaking(): boolean {
    return this.shakePower >= 0.15;
  }

  update(dtMs: number): void {
    const dt = dtMs / 1000;
    for (const p of this.particles) {
      if (!p.active) continue;
      p.life -= dtMs;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
    }
    for (const w of this.waves) {
      w.life -= dtMs;
      w.radius += w.grow * dt;
    }
    for (const p of this.popups) {
      p.life -= dtMs;
      p.y -= 42 * dt;
    }
    for (const b of this.banners) b.life -= dtMs;
    this.waves = this.waves.filter((w) => w.life > 0);
    this.popups = this.popups.filter((p) => p.life > 0);
    this.banners = this.banners.filter((b) => b.life > 0);
    this.shakePower *= Math.pow(0.88, dtMs / 16.67);
    this.flashAlpha *= Math.pow(0.9, dtMs / 16.67);
    if (this.flashAlpha < 0.01) this.flashAlpha = 0;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    for (const w of this.waves) {
      const t = w.life / w.maxLife;
      ctx.globalAlpha = Math.max(0, t) * 0.8;
      ctx.lineWidth = 2 + 5 * t;
      ctx.strokeStyle = w.color;
      ctx.beginPath();
      ctx.arc(w.x, w.y, w.radius, 0, TAU);
      ctx.stroke();
    }

    for (const p of this.particles) {
      if (!p.active) continue;
      const t = p.life / p.maxLife;
      ctx.globalAlpha = Math.min(1, t * 1.6);
      ctx.fillStyle = p.color;
      const s = p.size * (0.5 + t * 0.5);
      if (p.shape === 'dot') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, s, 0, TAU);
        ctx.fill();
      } else {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        if (p.shape === 'square') {
          ctx.fillRect(-s, -s * 0.6, s * 2, s * 1.2);
        } else {
          drawSparkle(ctx, s * 1.6);
        }
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const p of this.popups) {
      const t = p.life / p.maxLife;
      const age = 1 - t;
      const scale = age < 0.18 ? 0.6 + easeOutBack(age / 0.18) * 0.4 : 1;
      ctx.globalAlpha = Math.min(1, t * 2.2);
      ctx.font = `900 ${p.size * scale}px ${FONT_STACK}`;
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(30,8,60,0.9)';
      ctx.strokeText(p.text, p.x, p.y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;

    for (const b of this.banners) this.drawBanner(ctx, b);

    if (this.flashAlpha > 0) {
      ctx.fillStyle = `rgba(${this.flashColor},${this.flashAlpha})`;
      ctx.fillRect(0, 0, FIELD_W, FIELD_H);
    }
  }

  private drawBanner(ctx: CanvasRenderingContext2D, b: Banner): void {
    const age = b.maxLife - b.life;
    const intro = Math.min(1, age / 260);
    const outro = Math.min(1, b.life / 260);
    ctx.font = `900 ${b.size}px ${FONT_STACK}`;
    const fit = Math.min(1, (FIELD_W - 28) / Math.max(1, ctx.measureText(b.text).width));
    const scale = (0.3 + easeOutBack(intro) * 0.7) * (0.9 + outro * 0.1) * fit;
    ctx.save();
    ctx.globalAlpha = Math.min(1, outro * 1.2);
    ctx.translate(FIELD_W / 2, b.y);
    ctx.rotate(-0.05);
    ctx.scale(scale, scale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = b.size * 0.22;
    ctx.strokeStyle = 'rgba(30,8,60,0.95)';
    ctx.strokeText(b.text, 0, 0);
    const g = ctx.createLinearGradient(0, -b.size / 2, 0, b.size / 2);
    g.addColorStop(0, b.colors[0]);
    g.addColorStop(1, b.colors[1]);
    ctx.fillStyle = g;
    ctx.fillText(b.text, 0, 0);
    if (b.sub) {
      ctx.font = `900 ${b.size * 0.42}px ${FONT_STACK}`;
      ctx.lineWidth = b.size * 0.1;
      ctx.strokeText(b.sub, 0, b.size * 0.78);
      ctx.fillStyle = '#fff';
      ctx.fillText(b.sub, 0, b.size * 0.78);
    }
    ctx.restore();
  }
}

function drawSparkle(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const rad = i % 2 === 0 ? r : r * 0.3;
    const a = (i * Math.PI) / 4;
    ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
  }
  ctx.closePath();
  ctx.fill();
}
