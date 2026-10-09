import { memo, useEffect, useRef } from 'react';
import type { AudioManager } from '../audio/AudioManager';
import { installDebugHook } from '../debug';
import { Game, type GameResult, type HudState } from '../game/Game';
import type { SpriteSet } from '../game/sprites';

interface Props {
  sprites: SpriteSet;
  audio: AudioManager;
  /** オンライン対戦のときだけ指定 */
  sequence?: readonly number[];
  onReady: (game: Game | null) => void;
  onHud: (hud: HudState) => void;
  onGameOver: (result: GameResult) => void;
}

/**
 * ゲームの Canvas。Game インスタンスは effect 内で一度だけ作り、
 * 以降の描画・物理は React の再レンダリングとは無関係に rAF で回る。
 */
export const GameCanvas = memo(function GameCanvas({ sprites, audio, sequence, onReady, onHud, onGameOver }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const callbacks = useRef({ onReady, onHud, onGameOver });
  callbacks.current = { onReady, onHud, onGameOver };

  useEffect(() => {
    const stage = stageRef.current;
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!stage || !frame || !canvas) return;
    const game = new Game({
      canvas,
      stage,
      frame,
      sprites,
      audio,
      sequence,
      onHud: (hud) => callbacks.current.onHud(hud),
      onGameOver: (result) => callbacks.current.onGameOver(result),
    });
    const removeHook = installDebugHook(game, audio);
    game.start();
    callbacks.current.onReady(game);
    return () => {
      removeHook();
      game.dispose();
      callbacks.current.onReady(null);
    };
  }, [sprites, audio, sequence]);

  return (
    <div className="stage" ref={stageRef}>
      <div className="frame" ref={frameRef}>
        <canvas
          ref={canvasRef}
          className="field"
          role="img"
          aria-label="ゲームフィールド。クリック・タップ・Spaceキーでてるきを落とす"
          data-testid="field"
        />
      </div>
    </div>
  );
});
