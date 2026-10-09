import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioManager } from '../../audio/AudioManager';
import type { SpriteSet } from '../../game/sprites';
import { api } from '../../online/api';
import { ONLINE_ENABLED } from '../../online/config';
import { useOnline } from '../../online/OnlineProvider';
import type { MatchState } from '../../online/types';
import { useMatchmaking } from '../../online/useMatchmaking';
import { VersusScreen } from '../../online/versus/VersusScreen';
import { AuthScreen } from './AuthScreen';
import { ChatTab } from './ChatTab';
import { ConnectionBanner } from './ConnectionBanner';
import { Badge, Spinner, useAction } from './common';
import { FriendsTab } from './FriendsTab';
import { LobbyTab } from './LobbyTab';
import { ProfileView } from './ProfileView';
import { SettingsTab } from './SettingsTab';

type Tab = 'lobby' | 'friends' | 'chat' | 'profile' | 'settings';

interface Props {
  sprites: SpriteSet;
  audio: AudioManager;
  voiceOn: boolean;
  sfxOn: boolean;
  onToggleVoice: () => void;
  onToggleSfx: () => void;
  onExit: () => void;
}

const TABS: Array<{ id: Tab; icon: string; label: string }> = [
  { id: 'lobby', icon: '⚔', label: '対戦' },
  { id: 'friends', icon: '👥', label: 'フレンド' },
  { id: 'chat', icon: '💬', label: 'チャット' },
  { id: 'profile', icon: '🏅', label: 'プロフィール' },
  { id: 'settings', icon: '⚙', label: '設定' },
];

function Header({ title, onExit }: { title: string; onExit: () => void }) {
  return (
    <header className="online-head">
      <button type="button" className="btn btn-small" onClick={onExit} aria-label="タイトルへ戻る" data-testid="online-exit">
        ←
      </button>
      <h1>{title}</h1>
    </header>
  );
}

export function OnlineApp(props: Props) {
  const { sprites, audio, voiceOn, sfxOn, onToggleVoice, onToggleSfx, onExit } = props;
  const { phase, me, net, refresh } = useOnline();
  const [tab, setTab] = useState<Tab>('lobby');
  const [chatWith, setChatWith] = useState<string | null>(null);
  const [profileOf, setProfileOf] = useState<string | null>(null);
  const [matchId, setMatchId] = useState<string | null>(null);
  const action = useAction();

  const openMatch = useCallback(
    (id: string) => {
      audio.button();
      setMatchId(id);
    },
    [audio],
  );
  const matchmaking = useMatchmaking(openMatch);

  // 招待が承認されたときなど、別の画面にいても対戦の準備画面へ移る (再読み込み後の「中断された対戦」には入らない)
  const autoOpened = useRef<string | null>(null);
  const activeMatch = me?.active_match ?? null;
  useEffect(() => {
    if (!activeMatch || matchId || autoOpened.current === activeMatch) return undefined;
    autoOpened.current = activeMatch;
    let cancelled = false;
    void api
      .matchCurrent()
      .then((m) => {
        if (!cancelled && m && m.id === activeMatch && m.status === 'lobby') openMatch(activeMatch);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeMatch, matchId, openMatch]);

  const openChat = useCallback((friendId: string) => {
    setChatWith(friendId);
    setTab('chat');
  }, []);

  const backToLobby = useCallback(() => {
    setMatchId(null);
    setTab('lobby');
    void refresh();
  }, [refresh]);

  const again = useCallback(
    (match: MatchState) => {
      const opponent = match.players.find((p) => p.id !== match.me);
      setMatchId(null);
      setTab('lobby');
      void refresh();
      if (match.mode === 'quick') void matchmaking.join();
      else if (opponent) void action.run(async () => { await api.sendInvite(opponent.id); });
    },
    [action, matchmaking, refresh],
  );

  if (!ONLINE_ENABLED || phase === 'disabled') {
    return (
      <main className="online">
        <Header title="オンライン" onExit={onExit} />
        <div className="tab-body">
          <section className="card" data-testid="online-disabled">
            <h3>オンライン機能は準備中です</h3>
            <p>このビルドにはオンラインサーバーの接続設定がありません。ひとりで遊ぶモードはそのまま遊べます。</p>
          </section>
        </div>
      </main>
    );
  }

  if (phase === 'booting') {
    return (
      <main className="online">
        <Header title="オンライン" onExit={onExit} />
        <div className="tab-body center">
          <Spinner label="接続しています…" />
        </div>
      </main>
    );
  }

  if (phase === 'signed_out') {
    return (
      <main className="online">
        <Header title="オンライン" onExit={onExit} />
        <div className="tab-body">
          {net === 'offline' && <p className="notice" role="alert">サーバーに接続できません。ネットワークを確認してください。</p>}
          <AuthScreen />
        </div>
      </main>
    );
  }

  if (matchId) {
    return (
      <VersusScreen
        key={matchId}
        matchId={matchId}
        sprites={sprites}
        audio={audio}
        voiceOn={voiceOn}
        sfxOn={sfxOn}
        onToggleVoice={onToggleVoice}
        onToggleSfx={onToggleSfx}
        onExit={backToLobby}
        onAgain={again}
      />
    );
  }

  const badges: Partial<Record<Tab, number>> = {
    lobby: me?.pending_invites ?? 0,
    friends: me?.pending_requests ?? 0,
    chat: me?.unread ?? 0,
  };

  return (
    <main className="online" data-testid="online-home">
      <Header title={me?.player.name ?? 'オンライン'} onExit={onExit} />
      <ConnectionBanner />
      <div className="online-body">
        {tab === 'lobby' && <LobbyTab matchmaking={matchmaking} onMatch={openMatch} onOpenFriends={() => setTab('friends')} />}
        {tab === 'friends' && <FriendsTab onChat={openChat} onProfile={setProfileOf} />}
        {tab === 'chat' && <ChatTab openId={chatWith} onOpen={setChatWith} onProfile={setProfileOf} />}
        {tab === 'profile' && (
          <div className="tab-body">
            <section className="card">
              <ProfileView />
            </section>
          </div>
        )}
        {tab === 'settings' && <SettingsTab voiceOn={voiceOn} sfxOn={sfxOn} onToggleVoice={onToggleVoice} onToggleSfx={onToggleSfx} onExit={onExit} />}
      </div>
      <nav className="tabbar" aria-label="オンラインメニュー">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab${tab === t.id ? ' is-active' : ''}`}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => {
              if (t.id !== 'chat') setChatWith(null);
              setTab(t.id);
            }}
            data-testid={`tab-${t.id}`}
          >
            <span className="tab-icon" aria-hidden="true">
              {t.icon}
            </span>
            <span className="tab-label">{t.label}</span>
            <Badge count={badges[t.id] ?? 0} />
          </button>
        ))}
      </nav>
      {profileOf && <ProfileView playerId={profileOf} onClose={() => setProfileOf(null)} onChat={(id) => { setProfileOf(null); openChat(id); }} />}
    </main>
  );
}
