import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../../online/api';
import { useOnline, useOnlineEvents } from '../../online/OnlineProvider';
import type { ChatMessage, Friend } from '../../online/types';
import { Badge, Sheet, StatusDot, clockTime, timeAgo, useAction } from './common';
import { ReportSheet } from './ReportSheet';

export const CHAT_MAX = 200;

/** 入力欄つきのメッセージ一覧。友達チャットと対戦中チャットの両方で使う */
export function MessageList({ messages, onPickIncoming }: { messages: ChatMessage[]; onPickIncoming?: (m: ChatMessage) => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);
  return (
    <div className="messages" data-testid="messages" role="log" aria-live="polite">
      {messages.length === 0 && <p className="muted center">まだメッセージがありません。</p>}
      {messages.map((m) => (
        <div key={m.id} className={`msg ${m.mine ? 'msg-mine' : 'msg-theirs'}`}>
          {/* 本文は必ずテキストとして描画する (HTML として解釈しない) */}
          {m.mine ? (
            <span className="msg-bubble">{m.body}</span>
          ) : (
            <button type="button" className="msg-bubble" onClick={() => onPickIncoming?.(m)} aria-label="このメッセージの操作">
              {m.body}
            </button>
          )}
          <time dateTime={m.created_at}>{clockTime(m.created_at)}</time>
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

export function Composer({ onSend, disabled }: { onSend: (body: string) => Promise<boolean>; disabled?: boolean }) {
  const [text, setText] = useState('');
  const composing = useRef(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const body = text.trim();
    if (!body || busy || composing.current) return;
    setBusy(true);
    const ok = await onSend(body);
    if (ok) setText('');
    setBusy(false);
  };

  return (
    <form className="composer" onSubmit={(e) => void submit(e)}>
      <input
        data-testid="chat-input"
        type="text"
        value={text}
        maxLength={CHAT_MAX}
        onChange={(e) => setText(e.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        placeholder="メッセージを入力"
        aria-label="メッセージ"
        autoComplete="off"
        disabled={disabled}
      />
      <span className="counter" aria-hidden="true">{text.length}/{CHAT_MAX}</span>
      <button type="submit" className="btn btn-primary btn-small" disabled={busy || disabled || !text.trim()} data-testid="chat-send">
        送信
      </button>
    </form>
  );
}

function Thread({ friend, onBack, onProfile }: { friend: Friend; onBack: () => void; onProfile: (id: string) => void }) {
  const { fail, refresh, toast } = useOnline();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [picked, setPicked] = useState<ChatMessage | null>(null);
  const [reporting, setReporting] = useState<ChatMessage | null>(null);
  const action = useAction();
  const me = useOnline().me?.player.id;

  const load = useCallback(async () => {
    try {
      setMessages(await api.chatHistory(friend.id));
      await api.chatRead(friend.id);
      void refresh();
    } catch (e) {
      fail(e);
    }
  }, [friend.id, fail, refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  useOnlineEvents((event) => {
    if (event.type !== 'message' || event.matchId) return;
    if (event.senderId === friend.id) {
      setMessages((list) => (list.some((m) => m.id === event.id) ? list : [...list, { id: event.id, sender_id: event.senderId, mine: false, body: event.body, created_at: event.createdAt }]));
      void api.chatRead(friend.id).then(() => refresh()).catch(() => undefined);
    }
  });

  const send = async (body: string): Promise<boolean> => {
    const sent = await action.run(() => api.chatSend(friend.id, body));
    if (!sent || !me) return false;
    setMessages((list) => (list.some((m) => m.id === sent.id) ? list : [...list, { id: sent.id, sender_id: me, mine: true, body: sent.body, created_at: sent.created_at }]));
    return true;
  };

  return (
    <div className="thread" data-testid="thread">
      <header className="thread-head">
        <button type="button" className="btn btn-small" onClick={onBack} aria-label="チャット一覧へ戻る">←</button>
        <button type="button" className="thread-name link-row" onClick={() => onProfile(friend.id)}>
          <StatusDot status={friend.status} /> <b>{friend.name}</b>
        </button>
      </header>
      <MessageList messages={messages} onPickIncoming={setPicked} />
      <Composer onSend={send} />
      {picked && (
        <Sheet title="メッセージの操作" onClose={() => setPicked(null)}>
          <p className="sheet-text quote">{picked.body}</p>
          <div className="sheet-actions">
            <button type="button" className="btn" onClick={() => { setReporting(picked); setPicked(null); }}>🚩 このメッセージを通報</button>
            <button type="button" className="btn" onClick={() => void action.run(async () => { await api.setBlock(friend.id, 'mute'); setPicked(null); toast('success', 'ミュートしました'); onBack(); })}>🔇 {friend.name} をミュート</button>
            <button type="button" className="btn" onClick={() => void action.run(async () => { await api.setBlock(friend.id, 'block'); setPicked(null); toast('success', 'ブロックしました'); onBack(); })}>⛔ {friend.name} をブロック</button>
          </div>
        </Sheet>
      )}
      {reporting && <ReportSheet target={{ id: friend.id, name: friend.name }} messageId={reporting.id} onClose={() => setReporting(null)} />}
    </div>
  );
}

interface Props {
  openId: string | null;
  onOpen: (friendId: string | null) => void;
  onProfile: (playerId: string) => void;
}

export function ChatTab({ openId, onOpen, onProfile }: Props) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      setFriends(await api.friends());
    } catch {
      /* 接続バナーで状態が分かる */
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load, openId]);
  useOnlineEvents((event) => {
    if (event.type === 'message' || event.type === 'friends_changed') void load();
  });

  const open = openId ? friends.find((f) => f.id === openId) : undefined;
  if (open) return <Thread friend={open} onBack={() => onOpen(null)} onProfile={onProfile} />;

  const sorted = [...friends].sort((a, b) => (b.last_at ?? '').localeCompare(a.last_at ?? '') || a.name.localeCompare(b.name));
  return (
    <div className="tab-body chats">
      <section className="card">
        <h3>チャット</h3>
        {!loaded ? null : sorted.length === 0 ? (
          <p className="muted">フレンドができるとチャットできます。</p>
        ) : (
          <ul className="rows" data-testid="chat-list">
            {sorted.map((f) => (
              <li key={f.id}>
                <button type="button" className="row row-button" onClick={() => onOpen(f.id)} data-testid="chat-row">
                  <span className="row-main">
                    <StatusDot status={f.status} /> <b>{f.name}</b>
                    <small className="muted chat-preview">{f.last_body ?? 'メッセージはまだありません'}</small>
                  </span>
                  <span className="row-meta">
                    <small className="muted">{timeAgo(f.last_at)}</small>
                    <Badge count={f.unread} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">チャットの履歴は直近30日・1会話あたり最新500件まで保存されます。対戦中のチャットは試合の7日後に削除されます。</p>
      </section>
    </div>
  );
}
