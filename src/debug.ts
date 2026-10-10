import type { AudioManager } from './audio/AudioManager';
import type { Game } from './game/Game';

declare global {
  interface Window {
    /** ?debug を付けて開いたときだけ公開される E2E テスト用フック */
    __TERUKI__?: {
      game: Game;
      audio: AudioManager;
      spawn(level: number, x: number, y: number): void;
    };
  }
}

export function installDebugHook(game: Game, audio: AudioManager): () => void {
  if (!new URLSearchParams(window.location.search).has('debug')) return () => undefined;
  window.__TERUKI__ = { game, audio, spawn: (level, x, y) => void game.session.world.spawn(level, x, y) };
  return () => {
    delete window.__TERUKI__;
  };
}
