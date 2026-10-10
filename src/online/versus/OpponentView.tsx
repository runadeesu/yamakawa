import { useEffect, useRef } from 'react';
import { FIELD_H, FIELD_W } from '../../game/config';
import type { SpriteSet } from '../../game/sprites';
import type { VersusRunner } from './VersusRunner';

/** 相手の盤面 (Broadcast で届いたスナップショット) を小さく描く。表示専用で、勝敗には関係しない */
export function OpponentView({ runner, sprites, width = 48 }: { runner: VersusRunner; sprites: SpriteSet; width?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const height = Math.round((width * FIELD_H) / FIELD_W);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const scale = (width * dpr) / FIELD_W;
    let raf = 0;
    let lastQ = -1;
    let lastActive = -1;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const board = runner.opponentBoard;
      const key = board?.q ?? 0;
      const active = board?.a ?? -1;
      if (key === lastQ && active === lastActive) return;
      lastQ = key;
      lastActive = active;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      if (!board) return;
      ctx.globalAlpha = board.a === 1 ? 1 : 0.45;
      for (let i = 0; i + 2 < board.n.length; i += 3) {
        const level = board.n[i] ?? 0;
        const sprite = sprites.canvases[level - 1];
        const extent = sprites.extents[level - 1];
        if (!sprite || extent === undefined) continue;
        const x = board.n[i + 1] ?? 0;
        const y = board.n[i + 2] ?? 0;
        ctx.drawImage(sprite, x - extent, y - extent, extent * 2, extent * 2);
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [runner, sprites, width, height]);

  return (
    <canvas
      ref={ref}
      className="opp-board"
      style={{ width, height }}
      role="img"
      aria-label="相手の盤面"
      data-testid="opp-board"
    />
  );
}
