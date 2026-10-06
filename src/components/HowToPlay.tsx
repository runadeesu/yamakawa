import { useEffect, useRef } from 'react';
import type { SpriteSet } from '../game/sprites';
import { Evolution } from './Evolution';

interface Props {
  sprites: SpriteSet;
  onClose: () => void;
}

export function HowToPlay({ sprites, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [onClose]);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="howto-title" onClick={onClose}>
      <div className="panel howto" onClick={(event) => event.stopPropagation()}>
        <h2 id="howto-title">遊び方</h2>
        <ol className="howto-steps">
          <li>
            <b>落とす位置を決める</b>
            <span>PC: マウスを動かす / ← → キー　スマホ: 指をスライド</span>
          </li>
          <li>
            <b>落とす</b>
            <span>PC: クリック / Space キー　スマホ: 指を離す(タップ)</span>
          </li>
          <li>
            <b>同じてるきをぶつけて合体！</b>
            <span>1つ大きなてるきに進化してスコアUP。続けて合体するとコンボ！</span>
          </li>
          <li>
            <b>最終形態「FINAL TERUKI」を目指せ</b>
            <span>赤い線より上に積み上がったままだと GAME OVER</span>
          </li>
        </ol>
        <Evolution sprites={sprites} size={0.78} showNames />
        <p className="howto-note">🔊 音声 と 🔔 効果音 は個別に ON / OFF できます。音を消しても遊べます。</p>
        <button ref={closeRef} type="button" className="btn btn-primary" onClick={onClose}>
          とじる
        </button>
      </div>
    </div>
  );
}
