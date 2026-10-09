import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../online/api';
import type { useMatchmaking } from '../../online/useMatchmaking';
import { useOnline, useOnlineEvents } from '../../online/OnlineProvider';
import type { Friend, Invites, MatchState } from '../../online/types';
import { Spinner, StatusDot, useAction } from './common';

interface Props {
  matchmaking: ReturnType<typeof useMatchmaking>;
  onMatch: (matchId: string) => void;
  onOpenFriends: () => void;
}

export function LobbyTab({ matchmaking, onMatch, onOpenFriends }: Props) {
  const { me, toast, refresh } = useOnline();
  const { state, join, cancel } = matchmaking;
  const [invites, setInvites] = useState<Invites>({ incoming: [], outgoing: [] });
  const [friends, setFriends] = useState<Friend[]>([]);
  const [resume, setResume] = useState<MatchState | null>(null);
  const action = useAction();
  const opened = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const [inv, fr] = await Promise.all([api.invites(), api.friends()]);
      setInvites(inv);
      setFriends(fr);
      // 相手が招待を承認した: 対戦の準備画面へは OnlineApp が (サーバーの active_match を見て) 移る。
      // 過去に承認された招待でこの画面を作り直したときに、終わった対戦を開き直さないよう、ここでは開かない
      for (const out of inv.outgoing) {
        if (out.status === 'accepted' && out.match_id && !opened.current.has(out.id)) {
          opened.current.add(out.id);
          void refresh();
        }
      }
    } catch {
      /* 一覧の更新に失敗しても画面は維持する (接続バナーで状態が分かる) */
    }
  }, [refresh]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(id);
  }, [load]);

  useOnlineEvents((event) => {
    if (event.type === 'invite' || event.type === 'friends_changed' || event.type === 'match') void load();
  });

  // 前回の対戦が残っていないか確認する
  useEffect(() => {
    if (!me?.active_match) {
      setResume(null);
      return;
    }
    let cancelled = false;
    void api.matchCurrent().then((m) => {
      if (!cancelled) setResume(m);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [me?.active_match]);

  const accept = (id: string, yes: boolean) =>
    action.run(async () => {
      const res = await api.respondInvite(id, yes);
      if (res.status === 'accepted' && res.match_id) onMatch(res.match_id);
      else if (res.status === 'expired') toast('info', '招待の期限が切れました');
      else if (res.status === 'busy') toast('info', 'どちらかが対戦中のため開始できませんでした');
      else if (res.status === 'cancelled') toast('info', '招待は取り消されました');
      await load();
    });

  const invite = (friend: Friend) =>
    action.run(async () => {
      await api.sendInvite(friend.id);
      toast('success', `${friend.name} さんを招待しました (60秒以内に返事が来ます)`);
      await load();
    });

  const online = friends.filter((f) => f.online);

  return (
    <div className="tab-body lobby">
      {resume && resume.status === 'lobby' && (
        <section className="card card-accent" aria-live="polite">
          <h3>対戦の準備中です</h3>
          <p>相手と対戦の準備をしている途中です。</p>
          <button type="button" className="btn btn-primary" onClick={() => onMatch(resume.id)}>
            対戦に戻る
          </button>
        </section>
      )}
      {resume && resume.status === 'playing' && (
        <section className="card card-warn" aria-live="polite">
          <h3>前回の対戦は中断されました</h3>
          <p>ページを閉じた対戦には戻れません。相手の勝ちとして終了します。</p>
          <button
            type="button"
            className="btn btn-danger"
            disabled={action.busy}
            onClick={() => void action.run(async () => { await api.matchLeave(resume.id); setResume(null); toast('info', '対戦を終了しました'); })}
          >
            終了する
          </button>
        </section>
      )}

      <section className="card quick">
        <h3>クイックマッチ</h3>
        {state.phase === 'idle' ? (
          <>
            <p>オンラインの誰かと2分間のスコアバトル。同じ順番で落ちてくるてるきで、どちらが高得点か勝負！</p>
            {state.timedOut && <p className="notice">対戦相手が見つかりませんでした。時間をおいてもう一度試すか、フレンドを招待してみてください。</p>}
            <button type="button" className="btn btn-primary btn-big" onClick={() => void join()} data-testid="quick-match" disabled={!!resume}>
              ⚔ 対戦相手を探す
            </button>
          </>
        ) : (
          <div className="searching" data-testid="searching">
            <Spinner label={`対戦相手を探しています… ${state.waited}秒`} />
            {state.searching > 1 && <p className="muted">待機中のプレイヤー: {state.searching}人</p>}
            {state.slow && (
              <p className="notice">
                なかなか見つかりません。もう少し待つか、<button type="button" className="link" onClick={onOpenFriends}>フレンドを招待</button>してみましょう。
              </p>
            )}
            <button type="button" className="btn" onClick={() => void cancel()} data-testid="cancel-search">
              キャンセル
            </button>
          </div>
        )}
      </section>

      {invites.incoming.length > 0 && (
        <section className="card card-accent" aria-live="polite">
          <h3>対戦の招待</h3>
          <ul className="rows">
            {invites.incoming.map((inv) => (
              <li key={inv.id} className="row" data-testid="invite-in">
                <span className="row-main">
                  <b>{inv.name}</b> さんから招待されています
                </span>
                <span className="row-actions">
                  <button type="button" className="btn btn-primary btn-small" disabled={action.busy} onClick={() => void accept(inv.id, true)} data-testid="invite-accept">
                    受ける
                  </button>
                  <button type="button" className="btn btn-small" disabled={action.busy} onClick={() => void accept(inv.id, false)}>
                    断る
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {invites.outgoing.filter((o) => o.status === 'pending').length > 0 && (
        <section className="card">
          <h3>送った招待</h3>
          <ul className="rows">
            {invites.outgoing
              .filter((o) => o.status === 'pending')
              .map((out) => (
                <li key={out.id} className="row">
                  <span className="row-main">
                    <b>{out.name}</b> さんの返事を待っています…
                  </span>
                  <button type="button" className="btn btn-small" disabled={action.busy} onClick={() => void action.run(async () => { await api.cancelInvite(out.id); await load(); })}>
                    取り消す
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h3>フレンドと対戦</h3>
        {online.length === 0 ? (
          <p className="muted">
            いまオンラインのフレンドはいません。
            <button type="button" className="link" onClick={onOpenFriends}>フレンドを探す</button>
          </p>
        ) : (
          <ul className="rows">
            {online.map((f) => (
              <li key={f.id} className="row">
                <span className="row-main">
                  <StatusDot status={f.status} /> <b>{f.name}</b>
                </span>
                <button
                  type="button"
                  className="btn btn-small btn-primary"
                  disabled={action.busy || f.status === 'in_match'}
                  onClick={() => void invite(f)}
                  data-testid={`invite-${f.name}`}
                >
                  {f.status === 'in_match' ? '対戦中' : '招待'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
