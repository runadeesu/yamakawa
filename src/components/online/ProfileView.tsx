import { useCallback, useEffect, useState } from 'react';
import { api } from '../../online/api';
import { describeError } from '../../online/errors';
import { useOnline, useOnlineEvents } from '../../online/OnlineProvider';
import type { Profile } from '../../online/types';
import { Sheet, Spinner, StatusDot, timeAgo, useAction } from './common';
import { ReportSheet } from './ReportSheet';

interface Props {
  /** 省略すると自分のプロフィール */
  playerId?: string;
  onClose?: () => void;
  onChat?: (id: string) => void;
}

const OUTCOME = { win: '勝ち', loss: '負け', draw: '引き分け' } as const;

function ProfileBody({ playerId, onChat, onClose }: Props) {
  const { toast, refresh } = useOnline();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const action = useAction();

  const load = useCallback(async () => {
    try {
      setProfile(await api.profile(playerId));
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, [playerId]);

  useEffect(() => {
    void load();
  }, [load]);
  useOnlineEvents((event) => {
    if (event.type === 'match' || event.type === 'friends_changed') void load();
  });

  if (error) return <p className="form-error">{error}</p>;
  if (!profile) return <Spinner label="読み込み中…" />;

  const act = (task: () => Promise<unknown>, done: string) =>
    action.run(async () => {
      await task();
      toast('success', done);
      await Promise.all([load(), refresh()]);
    });

  const rate = profile.win_rate === null ? '-' : `${profile.win_rate}%`;
  return (
    <div className="profile" data-testid="profile">
      <div className="profile-head">
        <div className="avatar" aria-hidden="true">
          {[...profile.name][0]}
        </div>
        <div>
          <h3 data-testid="profile-name">{profile.name}</h3>
          <p className="muted">
            ID: <b className="mono" data-testid="profile-code">{profile.code}</b>
            {profile.online !== null && (
              <>
                {' '}
                <StatusDot status={profile.online ? 'online' : 'offline'} />
              </>
            )}
          </p>
        </div>
      </div>

      <dl className="stats">
        <div><dt>対戦数</dt><dd data-testid="stat-matches">{profile.matches}</dd></div>
        <div><dt>勝利</dt><dd data-testid="stat-wins">{profile.wins}</dd></div>
        <div><dt>敗北</dt><dd data-testid="stat-losses">{profile.losses}</dd></div>
        <div><dt>引き分け</dt><dd>{profile.draws}</dd></div>
        <div><dt>勝率</dt><dd>{rate}</dd></div>
        <div><dt>フレンド</dt><dd>{profile.friend_count}</dd></div>
      </dl>

      {!profile.self && (
        <div className="profile-actions">
          {profile.relation === 'none' && (
            <button type="button" className="btn btn-primary" disabled={action.busy} onClick={() => void act(() => api.sendRequest(profile.id), 'フレンド申請を送りました')}>
              フレンド申請
            </button>
          )}
          {profile.relation === 'pending_out' && <span className="muted">フレンド申請中</span>}
          {profile.relation === 'pending_in' && (
            <button type="button" className="btn btn-primary" disabled={action.busy} onClick={() => void act(() => api.sendRequest(profile.id), 'フレンドになりました')}>
              申請を承認
            </button>
          )}
          {profile.relation === 'friend' && onChat && (
            <button type="button" className="btn" onClick={() => onChat(profile.id)}>
              💬 チャット
            </button>
          )}
          {profile.relation === 'blocked' ? (
            <button type="button" className="btn" disabled={action.busy} onClick={() => void act(() => api.clearBlock(profile.id), 'ブロックを解除しました')}>
              ブロック解除
            </button>
          ) : (
            <button type="button" className="btn" disabled={action.busy} onClick={() => void act(() => api.setBlock(profile.id, 'block').then(() => onClose?.()), 'ブロックしました')}>
              ブロック
            </button>
          )}
          <button type="button" className="btn btn-danger" onClick={() => setReporting(true)}>
            通報
          </button>
        </div>
      )}

      <h4>最近の対戦</h4>
      {profile.recent.length === 0 ? (
        <p className="muted">まだ対戦記録がありません。</p>
      ) : (
        <ul className="rows" data-testid="recent">
          {profile.recent.map((m) => (
            <li key={m.match_id} className={`row result-${m.outcome}`}>
              <span className="row-main">
                <b className={`outcome outcome-${m.outcome}`}>{OUTCOME[m.outcome]}</b> vs {m.opponent}
                <small className="muted"> ({m.my_score} - {m.opp_score}) {timeAgo(m.finished_at)}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
      {reporting && <ReportSheet target={{ id: profile.id, name: profile.name }} onClose={() => setReporting(false)} />}
    </div>
  );
}

/** 他プレイヤーのプロフィール (シート表示) と、自分のプロフィール (タブ内表示) の両方に使う */
export function ProfileView(props: Props) {
  if (props.playerId && props.onClose) {
    return (
      <Sheet title="プロフィール" onClose={props.onClose}>
        <ProfileBody {...props} />
      </Sheet>
    );
  }
  return <ProfileBody {...props} />;
}
