import { useCallback, useEffect, useState } from 'react';
import { audio } from './audio/instance';
import { GameScreen } from './components/GameScreen';
import { HowToPlay } from './components/HowToPlay';
import { TitleScreen } from './components/TitleScreen';
import { STORAGE_KEYS } from './game/config';
import { loadSprites, type SpriteSet } from './game/sprites';
import { loadBest, loadFlag, saveFlag } from './storage';

type Screen = 'title' | 'game';

const UNLOCK_EVENTS = ['pointerup', 'touchend', 'click', 'keydown'] as const;

export default function App() {
  const [screen, setScreen] = useState<Screen>('title');
  const [sprites, setSprites] = useState<SpriteSet | null>(null);
  const [howTo, setHowTo] = useState(false);
  const [voiceOn, setVoiceOn] = useState(() => loadFlag(STORAGE_KEYS.voice));
  const [sfxOn, setSfxOn] = useState(() => loadFlag(STORAGE_KEYS.sfx));
  const [best, setBest] = useState(loadBest);

  useEffect(() => {
    let cancelled = false;
    void loadSprites().then((set) => {
      if (!cancelled) setSprites(set);
    });
    void audio.preload();

    // ブラウザの自動再生制限を越えるため、最初のユーザー操作の中で AudioContext を開始する
    const unlock = () => audio.unlock();
    const onVisibility = () => audio.setPageVisible(!document.hidden);
    for (const type of UNLOCK_EVENTS) window.addEventListener(type, unlock, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      for (const type of UNLOCK_EVENTS) window.removeEventListener(type, unlock, { capture: true });
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    audio.setVoiceEnabled(voiceOn);
    saveFlag(STORAGE_KEYS.voice, voiceOn);
  }, [voiceOn]);

  useEffect(() => {
    audio.setSfxEnabled(sfxOn);
    saveFlag(STORAGE_KEYS.sfx, sfxOn);
  }, [sfxOn]);

  const toggleVoice = useCallback(() => setVoiceOn((on) => !on), []);
  const toggleSfx = useCallback(() => setSfxOn((on) => !on), []);
  const openHowTo = useCallback(() => {
    audio.button();
    setHowTo(true);
  }, []);
  const closeHowTo = useCallback(() => setHowTo(false), []);
  const start = useCallback(() => {
    audio.unlock();
    audio.button();
    setScreen('game');
  }, []);
  const exitToTitle = useCallback(() => {
    setBest(loadBest());
    setScreen('title');
  }, []);

  return (
    <div className="app">
      {screen === 'title' || !sprites ? (
        <TitleScreen
          sprites={sprites}
          best={best}
          voiceOn={voiceOn}
          sfxOn={sfxOn}
          onStart={start}
          onHowTo={openHowTo}
          onToggleVoice={toggleVoice}
          onToggleSfx={toggleSfx}
        />
      ) : (
        <GameScreen
          sprites={sprites}
          audio={audio}
          voiceOn={voiceOn}
          sfxOn={sfxOn}
          onToggleVoice={toggleVoice}
          onToggleSfx={toggleSfx}
          onExit={exitToTitle}
        />
      )}
      {howTo && sprites && <HowToPlay sprites={sprites} onClose={closeHowTo} />}
    </div>
  );
}
