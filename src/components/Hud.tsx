import { memo } from 'react';
import { levelDef } from '../game/levels';
import type { SpriteSet } from '../game/sprites';

interface Props {
  score: number;
  best: number;
  nextLevel: number;
  sprites: SpriteSet;
}

export const Hud = memo(function Hud({ score, best, nextLevel, sprites }: Props) {
  const size = Math.round(levelDef(nextLevel).radius * 1.6 + 4);
  return (
    <header className="hud">
      <h1 className="hud-title">やまかわてるきゲーム</h1>
      <div className="hud-row">
        <div className="hud-stat">
          <span className="hud-label">SCORE</span>
          <span className="hud-value" data-testid="score" aria-live="off">
            {score}
          </span>
        </div>
        <div className="hud-next" aria-label={`NEXT ${levelDef(nextLevel).name}`}>
          <span className="hud-label">NEXT</span>
          <div className="hud-next-box">
            <img src={sprites.urls[nextLevel - 1]} width={size} height={size} alt="" draggable={false} data-testid="next" />
          </div>
        </div>
        <div className="hud-stat hud-best">
          <span className="hud-label">BEST</span>
          <span className="hud-value" data-testid="best">
            {best}
          </span>
        </div>
      </div>
    </header>
  );
});
