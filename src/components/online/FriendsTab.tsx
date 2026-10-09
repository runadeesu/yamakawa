import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../../online/api';
import { describeError } from '../../online/errors';
import { useOnline, useOnlineEvents } from '../../online/OnlineProvider';
import type { BlockRow, Friend, FriendRequests, SearchResult } from '../../online/types';
import { Badge, Confirm, Sheet, StatusDot, useAction } from './common';
import { ReportSheet } from './ReportSheet';

interface Props {
  onChat: (friendId: string) => void;
  onProfile: (playerId: string) => void;
}

export function FriendsTab({ onChat, onProfile }: Props) {
  const { toast, refresh } = useOnline();
  const [friends, setFriends] = useState<Friend[]>([]);
  const [requests, setRequests] = useState<FriendRequests>({ incoming: [], outgoing: [] });
  const [blocks, setBlocks] = useState<BlockRow[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Friend | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<Friend | null>(null);
  const [reporting, setReporting] = useState<Friend | null>(null);
  const action = useAction();

  const load = useCallback(async () => {
    try {
      const [f, r, b] = await Promise.all([api.friends(), api.requests(), api.blocks()]);
      setFriends(f);
      setRequests(r);
      setBlocks(b);
    } catch {
      /* 接続バナーで状態が分かる */
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(id);
  }, [load]);
  useOnlineEvents((event) => {
    if (event.type === 'friend_request' || event.type === 'friends_changed' || event.type === 'message') void load();
  });

  const runSearch = async (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    if (q.length < 2) {
      setSearchError('2文字以上で入力してください (表示名の先頭 または プレイヤーID)');
      return;
    }
    await action.run(async () => {
      try {
        setResults(await api.search(q));
        setSearchError(null);
      } catch (e) {
        setSearchError(describeError(e));
        setResults(null);
      }
    });
  };

  const after = async (done: string) => {
    toast('success', done);
    await Promise.all([load(), refresh()]);
  };

  const sendRequest = (r: SearchResult) =>
    action.run(async () => {
      const res = await api.sendRequest(r.id);
      setResults((list) => list?.map((x) => (x.id === r.id ? { ...x, relation: res.status === 'accepted' ? 'friend' : 'pending_out' } : x)) ?? null);
      await after(res.status === 'accepted' ? 'フレンドになりました！' : 'フレンド申請を送りました');
    });

  const respond = (id: string, accept: boolean) =>
    action.run(async () => {
      await api.respondRequest(id, accept);
      await after(accept ? 'フレンドになりました！' : '申請を断りました');
    });

  const invite = (f: Friend) =>
    action.run(async () => {
      await api.sendInvite(f.id);
      setSheet(null);
      toast('success', `${f.name} さんを招待しました。ロビーで返事を待ちましょう`);
    });

  return (
    <div className="tab-body friends">
      <section className="card">
        <h3>プレイヤーを探す</h3>
        <form className="search" onSubmit={(e) => void runSearch(e)}>
          <input
            data-testid="friend-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="表示名 または プレイヤーID"
            aria-label="プレイヤー検索"
            maxLength={16}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button type="submit" className="btn btn-primary btn-small" disabled={action.busy} data-testid="friend-search-submit">
            検索
          </button>
        </form>
        {searchError && <p className="form-error">{searchError}</p>}
        {results && (
          <ul className="rows" data-testid="search-results">
            {results.length === 0 && <li className="muted">見つかりませんでした</li>}
            {results.map((r) => (
              <li key={r.id} className="row" data-testid="search-row">
                <button type="button" className="row-main link-row" onClick={() => onProfile(r.id)}>
                  <b>{r.name}</b> <small className="muted mono">{r.code}</small>
                </button>
                {r.relation === 'none' && (
                  <button type="button" className="btn btn-small btn-primary" disabled={action.busy} onClick={() => void sendRequest(r)} data-testid="send-request">
                    申請
                  </button>
                )}
                {r.relation === 'pending_out' && <span className="muted">申請中</span>}
                {r.relation === 'pending_in' && (
                  <button type="button" className="btn btn-small btn-primary" disabled={action.busy} onClick={() => void sendRequest(r)}>
                    承認
                  </button>
                )}
                {r.relation === 'friend' && <span className="muted">フレンド</span>}
                {r.relation === 'self' && <span className="muted">あなた</span>}
                {r.relation === 'blocked' && (
                  <button type="button" className="btn btn-small" disabled={action.busy} onClick={() => void action.run(async () => { await api.clearBlock(r.id); setResults(null); await after('ブロックを解除しました'); })}>
                    ブロック解除
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {requests.incoming.length > 0 && (
        <section className="card card-accent" aria-live="polite">
          <h3>届いたフレンド申請 <Badge count={requests.incoming.length} /></h3>
          <ul className="rows">
            {requests.incoming.map((r) => (
              <li key={r.id} className="row" data-testid="request-in">
                <button type="button" className="row-main link-row" onClick={() => onProfile(r.player_id)}>
                  <b>{r.name}</b> さん
                </button>
                <span className="row-actions">
                  <button type="button" className="btn btn-small btn-primary" disabled={action.busy} onClick={() => void respond(r.id, true)} data-testid="request-accept">
                    承認
                  </button>
                  <button type="button" className="btn btn-small" disabled={action.busy} onClick={() => void respond(r.id, false)} data-testid="request-decline">
                    拒否
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {requests.outgoing.length > 0 && (
        <section className="card">
          <h3>送ったフレンド申請</h3>
          <ul className="rows">
            {requests.outgoing.map((r) => (
              <li key={r.id} className="row">
                <span className="row-main">
                  <b>{r.name}</b> さんの返事を待っています
                </span>
                <button type="button" className="btn btn-small" disabled={action.busy} onClick={() => void action.run(async () => { await api.cancelRequest(r.id); await after('申請を取り消しました'); })}>
                  取り消す
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h3>フレンド ({friends.length})</h3>
        {friends.length === 0 ? (
          <p className="muted">まだフレンドがいません。上の検索から探して申請してみましょう。</p>
        ) : (
          <ul className="rows" data-testid="friend-list">
            {friends.map((f) => (
              <li key={f.id} className="row" data-testid="friend-row">
                <button type="button" className="row-main link-row" onClick={() => setSheet(f)} aria-label={`${f.name} のメニュー`}>
                  <StatusDot status={f.status} /> <b>{f.name}</b>
                </button>
                <span className="row-actions">
                  <button type="button" className="btn btn-small" onClick={() => onChat(f.id)} aria-label={`${f.name} とチャット`}>
                    💬<Badge count={f.unread} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {blocks.length > 0 && (
        <section className="card">
          <h3>ブロック・ミュート中</h3>
          <ul className="rows">
            {blocks.map((b) => (
              <li key={b.player_id} className="row">
                <span className="row-main">
                  <b>{b.name}</b> <small className="muted">{b.mode === 'block' ? 'ブロック' : 'ミュート'}</small>
                </span>
                <button type="button" className="btn btn-small" disabled={action.busy} onClick={() => void action.run(async () => { await api.clearBlock(b.player_id); await after('解除しました'); })}>
                  解除
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sheet && (
        <Sheet title={sheet.name} onClose={() => setSheet(null)}>
          <div className="sheet-actions">
            <button type="button" className="btn" onClick={() => { onProfile(sheet.id); setSheet(null); }}>👤 プロフィール</button>
            <button type="button" className="btn" onClick={() => { onChat(sheet.id); setSheet(null); }}>💬 チャット</button>
            <button type="button" className="btn btn-primary" disabled={action.busy || !sheet.online || sheet.status === 'in_match'} onClick={() => void invite(sheet)} data-testid="sheet-invite">
              ⚔ 対戦に招待 {!sheet.online && '(オフライン)'}
            </button>
            <button type="button" className="btn" onClick={() => void action.run(async () => { await api.setBlock(sheet.id, 'mute'); setSheet(null); await after('ミュートしました (相手のメッセージが見えなくなります)'); })}>🔇 ミュート</button>
            <button type="button" className="btn" onClick={() => void action.run(async () => { await api.setBlock(sheet.id, 'block'); setSheet(null); await after('ブロックしました'); })}>⛔ ブロック</button>
            <button type="button" className="btn" onClick={() => { setReporting(sheet); setSheet(null); }}>🚩 通報</button>
            <button type="button" className="btn btn-danger" onClick={() => { setConfirmRemove(sheet); setSheet(null); }} data-testid="sheet-remove">フレンドを削除</button>
          </div>
        </Sheet>
      )}
      {confirmRemove && (
        <Confirm
          title="フレンドを削除"
          text={`${confirmRemove.name} さんをフレンドから削除しますか? (相手の一覧からも消えます)`}
          confirmLabel="削除する"
          danger
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            const target = confirmRemove;
            setConfirmRemove(null);
            void action.run(async () => { await api.removeFriend(target.id); await after('フレンドを削除しました'); });
          }}
        />
      )}
      {reporting && <ReportSheet target={{ id: reporting.id, name: reporting.name }} onClose={() => setReporting(null)} />}
    </div>
  );
}
