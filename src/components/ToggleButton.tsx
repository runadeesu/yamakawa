import type { MouseEvent } from 'react';

interface Props {
  on: boolean;
  onIcon: string;
  offIcon: string;
  label: string;
  onToggle: () => void;
  variant?: 'pill' | 'tile';
  testId?: string;
}

/** 音声 / 効果音 の ON・OFF ボタン。押しやすい大きさと aria-pressed を備える */
export function ToggleButton({ on, onIcon, offIcon, label, onToggle, variant = 'pill', testId }: Props) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onToggle();
    // マウス/タッチで押した後はフォーカスを外し、Space キーがゲーム操作に効くようにする
    if (event.detail > 0) event.currentTarget.blur();
  };
  return (
    <button
      type="button"
      className={`btn btn-toggle btn-${variant}${on ? '' : ' is-off'}`}
      aria-pressed={on}
      aria-label={`${label} ${on ? 'ON' : 'OFF'}`}
      data-testid={testId}
      onClick={handleClick}
    >
      <span className="toggle-icon" aria-hidden="true">
        {on ? onIcon : offIcon}
      </span>
      <span className="toggle-label">
        {label}
        <b>{on ? 'ON' : 'OFF'}</b>
      </span>
    </button>
  );
}
