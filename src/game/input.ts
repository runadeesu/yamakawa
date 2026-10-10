import { FIELD_W } from './config';

export interface InputHandlers {
  /** フィールド座標 (0..FIELD_W) での狙い位置 */
  aim(x: number): void;
  drop(): void;
}

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('button, a, input, select, textarea, [role="dialog"]') !== null;
}

/**
 * マウス・タッチ・キーボードの入力。
 * - ポインタ: 動かして狙い、離す(クリック/タップ)と落下。スマホは指を動かして狙い、離して落とす。
 * - キーボード: ← → で移動 (direction をゲームループが読む)、Space / ↓ で落下。
 */
export class InputController {
  /** -1 (左) / 0 / 1 (右) */
  direction = 0;

  private readonly canvas: HTMLCanvasElement;
  private readonly handlers: InputHandlers;
  private left = false;
  private right = false;

  constructor(canvas: HTMLCanvasElement, handlers: InputHandlers) {
    this.canvas = canvas;
    this.handlers = handlers;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.releaseKeys);
  }

  dispose(): void {
    const { canvas } = this;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.releaseKeys);
  }

  private fieldX(event: PointerEvent): number | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || !Number.isFinite(event.clientX)) return null;
    return ((event.clientX - rect.left) / rect.width) * FIELD_W;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary) return;
    const x = this.fieldX(event);
    if (x !== null) this.handlers.aim(x);
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      /* キャプチャできなくても操作は続けられる */
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!event.isPrimary) return;
    const x = this.fieldX(event);
    if (x !== null) this.handlers.aim(x);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const x = this.fieldX(event);
    if (x !== null) this.handlers.aim(x);
    this.handlers.drop();
  };

  private readonly onContextMenu = (event: Event): void => event.preventDefault();

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (isInteractive(event.target)) return;
    switch (event.code) {
      case 'ArrowLeft':
      case 'KeyA':
        this.left = true;
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.right = true;
        break;
      case 'Space':
      case 'ArrowDown':
        if (!event.repeat) this.handlers.drop();
        break;
      default:
        return;
    }
    event.preventDefault();
    this.direction = (this.right ? 1 : 0) - (this.left ? 1 : 0);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === 'ArrowLeft' || event.code === 'KeyA') this.left = false;
    if (event.code === 'ArrowRight' || event.code === 'KeyD') this.right = false;
    this.direction = (this.right ? 1 : 0) - (this.left ? 1 : 0);
  };

  private readonly releaseKeys = (): void => {
    this.left = false;
    this.right = false;
    this.direction = 0;
  };
}
