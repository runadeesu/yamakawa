import { useState } from 'react';
import { useOnline } from '../../online/OnlineProvider';
import { ToggleButton } from '../ToggleButton';
import { Confirm, StatusDot, useAction } from './common';

interface Props {
  voiceOn: boolean;
  sfxOn: boolean;
  onToggleVoice: () => void;
  onToggleSfx: () => void;
  onExit: () => void;
}

const NET_TEXT = { ok: '接続中 (リアルタイム)', degraded: '接続中 (自動更新モード)', offline: 'オフライン (通信できません)' } as const;

export function SettingsTab({ voiceOn, sfxOn, onToggleVoice, onToggleSfx, onExit }: Props) {
  const { me, net, logout } = useOnline();
  const [asking, setAsking] = useState<'here' | 'everywhere' | null>(null);
  const action = useAction();

  return (
    <div className="tab-body settings">
      <section className="card">
        <h3>アカウント</h3>
        <dl className="kv">
          <div><dt>表示名</dt><dd data-testid="settings-name">{me?.player.name}</dd></div>
          <div><dt>プレイヤーID</dt><dd className="mono">{me?.player.code}</dd></div>
          <div><dt>通信</dt><dd><StatusDot status={net === 'ok' ? 'online' : 'offline'} /> {NET_TEXT[net]}</dd></div>
        </dl>
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={() => setAsking('here')} data-testid="logout">
            ログアウト
          </button>
          <button type="button" className="btn btn-small" onClick={() => setAsking('everywhere')}>
            すべての端末からログアウト
          </button>
        </div>
        <p className="notice">
          ⚠ メールアドレスを登録していないため、<b>パスワードを忘れた場合の復旧やパスワードの変更はできません</b> (初期バージョンの仕様です)。
        </p>
      </section>

      <section className="card">
        <h3>サウンド</h3>
        <div className="settings-toggles">
          <ToggleButton on={voiceOn} onIcon="🔊" offIcon="🔇" label="音声" onToggle={onToggleVoice} variant="tile" testId="online-voice" />
          <ToggleButton on={sfxOn} onIcon="🔔" offIcon="🔕" label="効果音" onToggle={onToggleSfx} variant="tile" testId="online-sfx" />
        </div>
      </section>

      <section className="card">
        <h3>チャットのルールとデータ</h3>
        <ul className="plain-list">
          <li>メッセージは1〜200文字。短時間に送りすぎると一時的に送れなくなります。</li>
          <li>不適切な言葉は自動で伏せ字になります。嫌な思いをしたら、メッセージをタップして通報・ミュート・ブロックできます。</li>
          <li>ブロックした相手からは、メッセージも招待も届きません。</li>
          <li>チャット履歴は直近30日・1会話あたり最新500件まで保存され、対戦中のチャットは試合の7日後に削除されます。</li>
          <li>保存している個人情報は、表示名・対戦成績・チャットだけです。メールアドレスや電話番号は取得していません。</li>
        </ul>
      </section>

      <section className="card">
        <button type="button" className="btn btn-ghost" onClick={onExit}>
          ← タイトルへ戻る
        </button>
      </section>

      {asking && (
        <Confirm
          title={asking === 'here' ? 'ログアウトしますか？' : 'すべての端末からログアウト'}
          text={
            asking === 'here'
              ? 'この端末からログアウトします。同じ表示名とパスワードで、またログインできます。'
              : 'ログイン中のすべての端末からログアウトします。パスワードが他人に知られたかもしれないときに使ってください。'
          }
          confirmLabel="ログアウト"
          danger
          onCancel={() => setAsking(null)}
          onConfirm={() => void action.run(async () => { await logout(asking === 'everywhere'); setAsking(null); })}
        />
      )}
    </div>
  );
}
