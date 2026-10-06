import { MAX_LEVEL } from './config';
import { LEVELS, levelDef } from './levels';
import face1 from '../assets/faces/face1.jpg';
import face2 from '../assets/faces/face2.jpg';
import face3 from '../assets/faces/face3.jpg';
import face4 from '../assets/faces/face4.jpg';
import face5 from '../assets/faces/face5.jpg';
import face6 from '../assets/faces/face6.jpg';
import face7 from '../assets/faces/face7.jpg';
import face8 from '../assets/faces/face8.jpg';

/** スプライトは論理サイズの何倍の解像度で作るか (描画時は縮小される) */
export const SPRITE_SCALE = 2.5;

const FACE_URLS = [face1, face2, face3, face4, face5, face6, face7, face8];
const TAU = Math.PI * 2;

export interface SpriteSet {
  /** index = level - 1。物理半径の円の中心がキャンバス中心に来る */
  canvases: HTMLCanvasElement[];
  /** DOM (<img>) で使う用の data URL。index = level - 1 */
  urls: string[];
  /** キャンバス中心から端までの論理px (描画サイズ = 2 * extent[level-1]) */
  extents: number[];
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export async function loadSprites(): Promise<SpriteSet> {
  const faces = await Promise.all(FACE_URLS.map(loadImage));
  const canvases: HTMLCanvasElement[] = [];
  const extents: number[] = [];
  for (const def of LEVELS) {
    const glow = def.level >= 7 ? def.radius * 0.22 : 2;
    const extent = def.radius + glow;
    extents.push(extent);
    canvases.push(drawSprite(def.level, extent, faces[def.level - 1] ?? null));
  }
  return { canvases, urls: canvases.map((c) => c.toDataURL('image/png')), extents };
}

function drawSprite(level: number, extent: number, face: HTMLImageElement | null): HTMLCanvasElement {
  const def = levelDef(level);
  const size = Math.ceil(extent * 2 * SPRITE_SCALE);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const c = size / 2;
  const R = def.radius * SPRITE_SCALE;
  const ringW = Math.max(3 * SPRITE_SCALE, R * 0.09);
  const inner = R - ringW;
  ctx.imageSmoothingQuality = 'high';

  if (level >= 7) drawGlow(ctx, c, R, size / 2, level === MAX_LEVEL ? '255,214,59' : '181,123,255');

  // ring
  ctx.beginPath();
  ctx.arc(c, c, R, 0, TAU);
  ctx.fillStyle = ringFill(ctx, level, c, R);
  ctx.fill();

  // face (cover-fit, square source)
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, inner, 0, TAU);
  ctx.clip();
  if (face) {
    const zoom = 1.06;
    ctx.drawImage(face, c - inner * zoom, c - inner * zoom, inner * 2 * zoom, inner * 2 * zoom);
  } else {
    drawFallbackFace(ctx, c, inner, def.ring);
  }
  // vignette for a rounded, ball-like feel
  const shade = ctx.createRadialGradient(c, c, inner * 0.55, c, c, inner);
  shade.addColorStop(0, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(10,0,30,0.38)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, size, size);
  ctx.restore();

  // inner/outer outline + glossy highlight
  ctx.lineWidth = Math.max(1.5, SPRITE_SCALE * 0.9);
  ctx.strokeStyle = 'rgba(20,6,50,0.55)';
  ctx.beginPath();
  ctx.arc(c, c, inner, 0, TAU);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(c, c, R - ctx.lineWidth / 2, 0, TAU);
  ctx.stroke();
  ctx.lineWidth = Math.max(1.5, ringW * 0.28);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(c, c, R - ringW * 0.5, Math.PI * 1.08, Math.PI * 1.42);
  ctx.stroke();

  drawDecoration(ctx, level, c, R, inner, ringW);
  return canvas;
}

function ringFill(ctx: CanvasRenderingContext2D, level: number, c: number, R: number): CanvasGradient | string {
  const def = levelDef(level);
  const g = ctx.createLinearGradient(c - R, c - R, c + R, c + R);
  if (level === MAX_LEVEL) {
    const stops = ['#ff4d4d', '#ffd43b', '#4dff88', '#4dc3ff', '#b57bff', '#ff4dc4'];
    stops.forEach((color, i) => g.addColorStop(i / (stops.length - 1), color));
    return g;
  }
  g.addColorStop(0, def.ring);
  g.addColorStop(1, def.accent);
  return g;
}

function drawGlow(ctx: CanvasRenderingContext2D, c: number, R: number, outer: number, rgb: string): void {
  const g = ctx.createRadialGradient(c, c, R * 0.85, c, c, outer);
  g.addColorStop(0, `rgba(${rgb},0.75)`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, outer, 0, TAU);
  ctx.fill();
}

function drawFallbackFace(ctx: CanvasRenderingContext2D, c: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(c - r, c - r, r * 2, r * 2);
  ctx.fillStyle = '#2a1650';
  for (const dx of [-0.32, 0.32]) {
    ctx.beginPath();
    ctx.arc(c + r * dx, c - r * 0.15, r * 0.12, 0, TAU);
    ctx.fill();
  }
  ctx.lineWidth = r * 0.1;
  ctx.strokeStyle = '#2a1650';
  ctx.beginPath();
  ctx.arc(c, c + r * 0.1, r * 0.4, 0.2, Math.PI - 0.2);
  ctx.stroke();
}

/* ---------------------------------------------------------------- decorations */

function drawDecoration(
  ctx: CanvasRenderingContext2D,
  level: number,
  c: number,
  R: number,
  inner: number,
  ringW: number,
): void {
  switch (level) {
    case 1:
      drawSprout(ctx, c, c - inner * 0.92, R * 0.36);
      break;
    case 2:
      drawStar(ctx, c + R * 0.62, c - R * 0.62, R * 0.2, '#fff6a8', '#e0a800', 5);
      break;
    case 3:
      drawHeadband(ctx, c, inner);
      break;
    case 4:
      drawCrown(ctx, c, R, { fill: '#e0903a', edge: '#7a4210', gem: '#ffe08a', spikes: 3, width: 0.62, height: 0.3 });
      break;
    case 5:
      drawCrown(ctx, c, R, { fill: '#e8eef7', edge: '#5b6b82', gem: '#4dc3ff', spikes: 5, width: 0.72, height: 0.34 });
      drawBolt(ctx, c - R * 0.86, c + R * 0.1, R * 0.28, '#ffe14d');
      drawBolt(ctx, c + R * 0.86, c + R * 0.1, R * 0.28, '#ffe14d');
      break;
    case 6:
      drawCrown(ctx, c, R, { fill: '#ffd43b', edge: '#8a5a00', gem: '#ff3d71', spikes: 5, width: 0.78, height: 0.38 });
      drawStar(ctx, c - R * 0.7, c - R * 0.55, R * 0.12, '#ffffff', '#ffd43b', 4);
      drawStar(ctx, c + R * 0.74, c + R * 0.5, R * 0.1, '#ffffff', '#ffd43b', 4);
      break;
    case 7:
      drawDoubleRing(ctx, c, R, ringW, 'rgba(255,255,255,0.85)');
      drawCrown(ctx, c, R, { fill: '#ffd43b', edge: '#7a4a00', gem: '#8b3dff', spikes: 5, width: 0.84, height: 0.42 });
      drawStar(ctx, c - R * 0.85, c - R * 0.2, R * 0.12, '#ffffff', '#b57bff', 4);
      drawStar(ctx, c + R * 0.84, c + R * 0.35, R * 0.14, '#ffffff', '#b57bff', 4);
      break;
    default:
      drawDoubleRing(ctx, c, R, ringW, 'rgba(255,255,255,0.9)');
      drawCrown(ctx, c, R, { fill: '#ffe066', edge: '#7a4a00', gem: '#ff3d71', spikes: 7, width: 0.95, height: 0.5 });
      drawStar(ctx, c - R * 0.88, c - R * 0.12, R * 0.13, '#ffffff', '#ffd43b', 4);
      drawStar(ctx, c + R * 0.86, c + R * 0.3, R * 0.15, '#ffffff', '#ffd43b', 4);
      drawStar(ctx, c + R * 0.5, c - R * 0.82, R * 0.1, '#ffffff', '#ff7ad9', 4);
  }
}

function drawSprout(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.fillStyle = '#35c46b';
  ctx.strokeStyle = '#146c3a';
  ctx.lineWidth = Math.max(1.2, s * 0.09);
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.45);
    ctx.quadraticCurveTo(x + dir * s * 0.9, y + s * 0.35, x + dir * s * 0.8, y - s * 0.3);
    ctx.quadraticCurveTo(x + dir * s * 0.1, y - s * 0.1, x, y + s * 0.45);
    ctx.fill();
    ctx.stroke();
  }
}

function drawStar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  fill: string,
  edge: string,
  points: number,
): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? r : r * (points === 4 ? 0.32 : 0.45);
    const a = (i * Math.PI) / points - Math.PI / 2;
    ctx.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.14);
  ctx.strokeStyle = edge;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function drawHeadband(ctx: CanvasRenderingContext2D, c: number, inner: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, inner, 0, TAU);
  ctx.clip();
  const y = c - inner * 0.5;
  const h = inner * 0.2;
  ctx.fillStyle = '#e5322d';
  ctx.fillRect(c - inner, y - h / 2, inner * 2, h);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(c, y, h * 0.34, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(c - inner, y + h / 2 - h * 0.18, inner * 2, h * 0.18);
  ctx.restore();
}

function drawBolt(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string): void {
  ctx.beginPath();
  ctx.moveTo(x + s * 0.2, y - s);
  ctx.lineTo(x - s * 0.55, y + s * 0.1);
  ctx.lineTo(x - s * 0.05, y + s * 0.1);
  ctx.lineTo(x - s * 0.25, y + s);
  ctx.lineTo(x + s * 0.6, y - s * 0.25);
  ctx.lineTo(x + s * 0.08, y - s * 0.25);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = Math.max(1, s * 0.12);
  ctx.strokeStyle = '#a15c00';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function drawDoubleRing(ctx: CanvasRenderingContext2D, c: number, R: number, ringW: number, color: string): void {
  ctx.lineWidth = Math.max(1, ringW * 0.16);
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(c, c, R - ringW * 0.5, 0, TAU);
  ctx.stroke();
}

interface CrownStyle {
  fill: string;
  edge: string;
  gem: string;
  spikes: number;
  /** R に対する幅 / 高さの比 */
  width: number;
  height: number;
}

/** リングの上端に重なる王冠。ボディ(円)からはみ出さない範囲に収める */
function drawCrown(ctx: CanvasRenderingContext2D, c: number, R: number, s: CrownStyle): void {
  const w = R * s.width;
  const h = R * s.height;
  const baseY = c - R * 0.66;
  const topY = baseY - h;
  const left = c - w / 2;
  const step = w / (s.spikes * 2 - 1);

  ctx.beginPath();
  ctx.moveTo(left, baseY);
  for (let i = 0; i < s.spikes; i++) {
    const px = left + step * (i * 2);
    ctx.lineTo(px, topY);
    ctx.lineTo(px + step, baseY - h * 0.45);
  }
  ctx.lineTo(left + w, baseY);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, topY, 0, baseY);
  g.addColorStop(0, s.fill);
  g.addColorStop(1, s.edge);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = Math.max(1.4, R * 0.035);
  ctx.strokeStyle = s.edge;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // gem on the centre spike + base band
  ctx.fillStyle = s.fill;
  ctx.fillRect(left, baseY - h * 0.16, w, h * 0.2);
  ctx.strokeRect(left, baseY - h * 0.16, w, h * 0.2);
  ctx.beginPath();
  ctx.arc(c, baseY - h * 0.06, h * 0.12, 0, TAU);
  ctx.fillStyle = s.gem;
  ctx.fill();
}
