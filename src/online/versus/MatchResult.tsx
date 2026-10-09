import { useEffect, useRef } from 'react';
import type { MatchState } from '../types';

const END_TEXT: Record<string, string> = {
  time_up: '時間切れ — スコアで決着',
  elimination: 'ゲームオーバーになった人がいたので決着',
  opponent_forfeit: '相手が退出・切断したため、不戦勝です',
  both_forfeit: '両者とも退出・切断したため、無効試合です (成績には入りません)',
  ready_timeout: '相手が準備できなかったため、対戦は始まりませんでした',
  left_lobby: '対戦は始まる前に取り消されました',
};

interface Props {
  match: MatchState;
  onBack: () => void;
  onAgain: () => void;
  againLabel: string;
}

/** サーバーが確定した結果の画面 */
export function MatchResult({ match, onBack, onAgain, againLabel }: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const me = match.players.find((p) => p.id === match.me);
  const opp = match.players.find((p) => p.id !== match.me);
  const cancelled = match.status === 'cancelled';
  const outcome = cancelled ? 'void' : (me?.outcome ?? 'void');
  const title = { win: 'YOU WIN!', loss: 'YOU LOSE', draw: 'DRAW', void: cancelled ? 'CANCELED' : 'NO CONTEST' }[outcome];
  const forfeitedMe = me?.finish_reason === 'forfeit';

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="mr-title" data-testid="match-result">
      <div className={`panel result-panel result-${outcome}`}>
        <h2 id="mr-title" className={`mr-title mr-${outcome}`} data-testid="result-title">
          {title}
        </h2>
        <p className="muted" data-testid="result-reason">
          {forfeitedMe && outcome === 'loss' ? 'あなたが退出・切断したため、負けになりました' : (END_TEXT[match.end_reason ?? ''] ?? '')}
        </p>
        {!cancelled && me && opp && (
          <dl className="vs-scores">
            <div className={outcome === 'win' ? 'is-winner' : ''}>
              <dt>{me.name}</dt>
              <dd data-testid="result-my-score">{me.final_score ?? me.progress_score}</dd>
            </div>
            <div className={outcome === 'loss' ? 'is-winner' : ''}>
              <dt>{opp.name}</dt>
              <dd data-testid="result-opp-score">{opp.final_score ?? opp.progress_score}</dd>
            </div>
          </dl>
        )}
        {outcome !== 'void' && me && (
          <p className="muted">
            通算 {me.matches} 戦 {me.wins} 勝 {me.losses} 敗 <small>(サーバー集計)</small>
          </p>
        )}
        <button ref={ref} type="button" className="btn btn-primary" onClick={onAgain} data-testid="result-again">
          {againLabel}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onBack} data-testid="result-back">
          ロビーへ戻る
        </button>
      </div>
    </div>
  );
}
