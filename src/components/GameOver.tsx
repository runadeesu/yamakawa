import { useEffect, useRef } from 'react';
import shockFace from '../assets/faces/shock.jpg';
import type { GameResult } from '../game/Game';

interface Props {
  result: GameResult;
  onRetry: () => void;
  onTitle: () => void;
}

export function GameOver({ result, onRetry, onTitle }: Props) {
  const retryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => retryRef.current?.focus(), []);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="gameover-title" data-testid="gameover">
      <div className="panel gameover">
        <div className="gameover-face">
          <img src={shockFace} alt="" draggable={false} />
        </div>
        <h2 id="gameover-title" className="gameover-title">
          GAME OVER
        </h2>
        {result.newBest && <p className="new-best">NEW BEST!</p>}
        <dl className="result">
          <div>
            <dt>SCORE</dt>
            <dd data-testid="final-score">{result.score}</dd>
          </div>
          <div>
            <dt>BEST</dt>
            <dd data-testid="final-best">{result.best}</dd>
          </div>
        </dl>
        {result.finalCount > 0 && <p className="final-badge">👑 FINAL TERUKI × {result.finalCount}</p>}
        <button ref={retryRef} type="button" className="btn btn-primary" onClick={onRetry} data-testid="retry">
          もう一回！
        </button>
        <button type="button" className="btn btn-ghost" onClick={onTitle}>
          タイトルへ
        </button>
      </div>
    </div>
  );
}
