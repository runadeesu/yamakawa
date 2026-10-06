import type { SpriteSet } from '../game/sprites';
import { Evolution } from './Evolution';
import { ToggleButton } from './ToggleButton';

interface Props {
  sprites: SpriteSet | null;
  best: number;
  voiceOn: boolean;
  sfxOn: boolean;
  onStart: () => void;
  onHowTo: () => void;
  onToggleVoice: () => void;
  onToggleSfx: () => void;
}

export function TitleScreen({ sprites, best, voiceOn, sfxOn, onStart, onHowTo, onToggleVoice, onToggleSfx }: Props) {
  return (
    <main className="title">
      <div className="title-bubbles" aria-hidden="true">
        {sprites &&
          [1, 3, 5, 2, 4, 6, 7, 8].map((level, i) => (
            <img key={i} src={sprites.urls[level - 1]} className={`bubble bubble-${i}`} alt="" draggable={false} />
          ))}
      </div>
      <div className="title-main">
        <h1 className="logo">
          <span className="logo-top">やまかわ</span>
          <span className="logo-mid">てるき</span>
          <span className="logo-bottom">ゲーム</span>
        </h1>
        <p className="subtitle">同じてるきを合体させろ！</p>
        {sprites ? <Evolution sprites={sprites} /> : <p className="loading">よみこみ中…</p>}
        <button type="button" className="btn btn-primary btn-start" onClick={onStart} disabled={!sprites} data-testid="start">
          START
        </button>
        <div className="title-options">
          <ToggleButton on={voiceOn} onIcon="🔊" offIcon="🔇" label="音声" onToggle={onToggleVoice} testId="title-voice" />
          <ToggleButton on={sfxOn} onIcon="🔔" offIcon="🔕" label="効果音" onToggle={onToggleSfx} testId="title-sfx" />
          <button type="button" className="btn btn-pill" onClick={onHowTo} data-testid="howto">
            <span className="toggle-icon" aria-hidden="true">
              ❓
            </span>
            <span className="toggle-label">遊び方</span>
          </button>
        </div>
        <p className="title-best">
          BEST <b data-testid="title-best">{best}</b>
        </p>
      </div>
    </main>
  );
}
