import { LEVELS } from '../game/levels';
import type { SpriteSet } from '../game/sprites';

interface Props {
  sprites: SpriteSet;
  /** 表示サイズの係数 (1 = 物理半径 × 1.15) */
  size?: number;
  showNames?: boolean;
}

/** 進化チェーン (Level 1 → 8)。タイトルと遊び方で使う */
export function Evolution({ sprites, size = 1, showNames = false }: Props) {
  return (
    <ol className={`evolution${showNames ? ' with-names' : ''}`} aria-label="進化の順番">
      {LEVELS.map((def, i) => {
        const px = Math.round((12 + def.radius * 0.72) * size);
        return (
          <li key={def.level} className="evolution-item">
            <img src={sprites.urls[i]} width={px} height={px} alt={def.name} draggable={false} />
            {showNames && <span>{def.name.replace(' Teruki', '')}</span>}
          </li>
        );
      })}
    </ol>
  );
}
