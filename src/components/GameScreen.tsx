import { useCallback, useRef, useState } from 'react';
import type { AudioManager } from '../audio/AudioManager';
import type { Game, GameResult, HudState } from '../game/Game';
import type { SpriteSet } from '../game/sprites';
import { loadBest } from '../storage';
import { Controls } from './Controls';
import { GameCanvas } from './GameCanvas';
import { GameOver } from './GameOver';
import { Hud } from './Hud';

interface Props {
  sprites: SpriteSet;
  audio: AudioManager;
  voiceOn: boolean;
  sfxOn: boolean;
  onToggleVoice: () => void;
  onToggleSfx: () => void;
  onExit: () => void;
}

export function GameScreen({ sprites, audio, voiceOn, sfxOn, onToggleVoice, onToggleSfx, onExit }: Props) {
  const [hud, setHud] = useState<HudState>(() => ({ score: 0, best: loadBest(), nextLevel: 1 }));
  const [result, setResult] = useState<GameResult | null>(null);
  const gameRef = useRef<Game | null>(null);

  const onReady = useCallback((game: Game | null) => {
    gameRef.current = game;
  }, []);

  const restart = useCallback(() => {
    audio.button();
    setResult(null);
    gameRef.current?.restart();
  }, [audio]);

  return (
    <div className="game">
      <Hud score={hud.score} best={hud.best} nextLevel={hud.nextLevel} sprites={sprites} />
      <GameCanvas sprites={sprites} audio={audio} onReady={onReady} onHud={setHud} onGameOver={setResult} />
      <Controls voiceOn={voiceOn} sfxOn={sfxOn} onToggleVoice={onToggleVoice} onToggleSfx={onToggleSfx} onRestart={restart} />
      {result && <GameOver result={result} onRetry={restart} onTitle={onExit} />}
    </div>
  );
}
