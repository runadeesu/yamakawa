import { useEffect, useRef, useState } from 'react';
import { ToggleButton } from './ToggleButton';

interface Props {
  voiceOn: boolean;
  sfxOn: boolean;
  onToggleVoice: () => void;
  onToggleSfx: () => void;
  onRestart: () => void;
}

const CONFIRM_MS = 2500;

export function Controls({ voiceOn, sfxOn, onToggleVoice, onToggleSfx, onRestart }: Props) {
  // 誤タップでの破棄を防ぐため、リスタートは2回タップで実行する
  const [confirming, setConfirming] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const handleRestart = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.detail > 0) event.currentTarget.blur();
    window.clearTimeout(timer.current);
    if (confirming) {
      setConfirming(false);
      onRestart();
      return;
    }
    setConfirming(true);
    timer.current = window.setTimeout(() => setConfirming(false), CONFIRM_MS);
  };

  return (
    <footer className="controls">
      <ToggleButton on={voiceOn} onIcon="🔊" offIcon="🔇" label="音声" onToggle={onToggleVoice} variant="tile" testId="voice-toggle" />
      <ToggleButton on={sfxOn} onIcon="🔔" offIcon="🔕" label="効果音" onToggle={onToggleSfx} variant="tile" testId="sfx-toggle" />
      <button
        type="button"
        className={`btn btn-tile btn-restart${confirming ? ' is-confirm' : ''}`}
        onClick={handleRestart}
        aria-label={confirming ? 'もう一度押すとリスタート' : 'リスタート'}
        data-testid="restart"
      >
        <span className="toggle-icon" aria-hidden="true">
          ↻
        </span>
        <span className="toggle-label">{confirming ? 'もう一度！' : 'リスタート'}</span>
      </button>
    </footer>
  );
}
