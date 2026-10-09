import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioManager } from '../../audio/AudioManager';
import { Composer, MessageList } from '../../components/online/ChatTab';
import { Confirm, Sheet, Spinner, StatusDot, useAction } from '../../components/online/common';
import { ReportSheet } from '../../components/online/ReportSheet';
import { GameCanvas } from '../../components/GameCanvas';
import { ToggleButton } from '../../components/ToggleButton';
import type { Game, HudState } from '../../game/Game';
import { levelDef } from '../../game/levels';
import type { SpriteSet } from '../../game/sprites';
import { api } from '../api';
import { useOnline, useOnlineEvents } from '../OnlineProvider';
import type { ChatMessage, MatchState } from '../types';
import { MatchResult } from './MatchResult';
import { OpponentView } from './OpponentView';
import { VersusRunner } from './VersusRunner';

interface Props {
  matchId: string;
  sprites: SpriteSet;
  audio: AudioManager;
  voiceOn: boolean;
  sfxOn: boolean;
  onToggleVoice: () => void;
  onToggleSfx: () => void;
  /** ロビーへ戻る */
  onExit: () => void;
  /** 結果画面の「もう一度」 */
  onAgain: (match: MatchState) => void;
}

const clock = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const LINK_TEXT = { good: '良好', weak: '不安定', lost: '途切れています' } as const;

function MatchChat({ matchId, onClose, opponent }: { matchId: string; onClose: () => void; opponent: { id: string; name: string } | null }) {
  const { me, fail } = useOnline();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [picked, setPicked] = useState<ChatMessage | null>(null);
  const [reporting, setReporting] = useState<ChatMessage | null>(null);
  const action = useAction();
  const myId = me?.player.id;

  useEffect(() => {
    let cancelled = false;
    void api.matchChatHistory(matchId).then((list) => {
      if (!cancelled) setMessages((current) => [...list, ...current.filter((m) => !list.some((x) => x.id === m.id))]);
    }).catch(fail);
    return () => {
      cancelled = true;
    };
  }, [matchId, fail]);

  useOnlineEvents((event) => {
    if (event.type !== 'message' || event.matchId !== matchId || event.senderId === myId) return;
    setMessages((list) => (list.some((m) => m.id === event.id) ? list : [...list, { id: event.id, sender_id: event.senderId, mine: false, body: event.body, created_at: event.createdAt }]));
  });

  const send = async (body: string): Promise<boolean> => {
    const sent = await action.run(() => api.matchChatSend(matchId, body));
    if (!sent || !myId) return false;
    setMessages((list) => (list.some((m) => m.id === sent.id) ? list : [...list, { id: sent.id, sender_id: myId, mine: true, body, created_at: new Date().toISOString() }]));
    return true;
  };

  return (
    <Sheet title="対戦チャット" onClose={onClose}>
      <div className="match-chat" data-testid="match-chat">
        <MessageList messages={messages} onPickIncoming={opponent ? setPicked : undefined} />
        <Composer onSend={send} />
      </div>
      {picked && opponent && (
        <Sheet title="メッセージの操作" onClose={() => setPicked(null)}>
          <p className="sheet-text quote">{picked.body}</p>
          <div className="sheet-actions">
            <button type="button" className="btn" onClick={() => { setReporting(picked); setPicked(null); }}>🚩 このメッセージを通報</button>
            <button type="button" className="btn" onClick={() => void action.run(async () => { await api.setBlock(opponent.id, 'mute'); setPicked(null); onClose(); })}>🔇 {opponent.name} をミュート</button>
          </div>
        </Sheet>
      )}
      {reporting && opponent && <ReportSheet target={opponent} messageId={reporting.id} matchId={matchId} onClose={() => setReporting(null)} />}
    </Sheet>
  );
}

export function VersusScreen({ matchId, sprites, audio, voiceOn, sfxOn, onToggleVoice, onToggleSfx, onExit, onAgain }: Props) {
  const { me } = useOnline();
  const [, setTick] = useState(0);
  const [runner, setRunner] = useState<VersusRunner | null>(null);
  const [hud, setHud] = useState<HudState>({ score: 0, best: 0, nextLevel: 1 });
  const [chatOpen, setChatOpen] = useState(false);
  const [unreadChat, setUnreadChat] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const runnerRef = useRef<VersusRunner | null>(null);
  const gameRef = useRef<Game | null>(null);
  const sequenceRef = useRef<readonly number[] | null>(null);
  const chatOpenRef = useRef(false);
  chatOpenRef.current = chatOpen;
  const action = useAction();

  // StrictMode でも壊れないよう、Runner は effect の中で作る
  useEffect(() => {
    const next = new VersusRunner(matchId, () => setTick((n) => n + 1));
    runnerRef.current = next;
    setRunner(next);
    if (gameRef.current) next.attachGame(gameRef.current);
    void next.start();
    return () => {
      next.dispose();
      if (runnerRef.current === next) runnerRef.current = null;
    };
  }, [matchId]);

  // 落ちてくる順番は最初に届いたものを使い続ける (途中で変わると Game が作り直されるため)
  if (!sequenceRef.current && runner?.match?.seq) sequenceRef.current = runner.match.seq;

  const onReady = useCallback((game: Game | null) => {
    gameRef.current = game;
    if (game) runnerRef.current?.attachGame(game);
    else runnerRef.current?.detachGame();
  }, []);
  const noop = useCallback(() => undefined, []);

  useOnlineEvents((event) => {
    if (event.type === 'message' && event.matchId === matchId && event.senderId !== me?.player.id && !chatOpenRef.current) {
      setUnreadChat((n) => n + 1);
    }
  });

  useEffect(() => {
    if (chatOpen) setUnreadChat(0);
  }, [chatOpen]);

  const match = runner?.match ?? null;
  const phase = runner?.phase ?? 'joining';
  const opponent = runner?.opponent ?? null;
  const myName = me?.player.name ?? 'あなた';
  const link = runner?.link ?? 'good';
  const countdown = runner?.countdown ?? null;
  const live = phase === 'countdown' || phase === 'playing' || phase === 'finishing';

  const leave = () =>
    action.run(async () => {
      setLeaving(false);
      await runnerRef.current?.leave();
    });

  const readyLeft = match ? Math.max(0, Math.ceil((Date.parse(match.ready_deadline) - (runner?.now() ?? Date.now())) / 1000)) : 0;
  const nextSize = Math.round(levelDef(hud.nextLevel).radius * 1.0 + 4);

  return (
    <div className="game versus" data-testid="versus" data-phase={phase}>
      <header className="vs-hud">
        <div className="vs-side vs-me">
          <span className="hud-label">{myName}</span>
          <span className="hud-value" data-testid="vs-my-score">{runner?.myScore ?? 0}</span>
          <span className="vs-next" aria-label={`NEXT ${levelDef(hud.nextLevel).name}`}>
            <span className="hud-label">NEXT</span>
            <img src={sprites.urls[hud.nextLevel - 1]} width={nextSize} height={nextSize} alt="" draggable={false} />
          </span>
        </div>
        <div className="vs-center">
          <span className="hud-label">TIME</span>
          <span className={`vs-timer${runner && runner.remainingMs < 10_000 && phase === 'playing' ? ' is-urgent' : ''}`} data-testid="vs-timer">
            {clock(runner?.remainingMs ?? 120_000)}
          </span>
          <span className={`netlink netlink-${link}`} data-testid="opp-link" role="status" aria-live="polite">
            <StatusDot status={link === 'good' ? 'online' : 'offline'} /> 相手との通信: {opponent?.finished ? '対戦終了' : LINK_TEXT[link]}
          </span>
        </div>
        <div className="vs-side vs-opp">
          <div className="vs-opp-text">
            <span className="hud-label">{opponent?.name ?? '相手'}</span>
            <span className="hud-value" data-testid="vs-opp-score">{runner?.opponentScore ?? 0}</span>
          </div>
          {runner && <OpponentView runner={runner} sprites={sprites} />}
        </div>
      </header>

      {runner && sequenceRef.current ? (
        <GameCanvas sprites={sprites} audio={audio} sequence={sequenceRef.current} onReady={onReady} onHud={setHud} onGameOver={noop} />
      ) : (
        <div className="stage stage-wait">
          <Spinner label="対戦を準備しています…" />
        </div>
      )}

      {runner?.message && live && (
        <p className="net-note" role="status" data-testid="vs-message">
          {runner.message}
        </p>
      )}

      <footer className="controls versus-controls">
        <ToggleButton on={voiceOn} onIcon="🔊" offIcon="🔇" label="音声" onToggle={onToggleVoice} variant="tile" testId="vs-voice" />
        <ToggleButton on={sfxOn} onIcon="🔔" offIcon="🔕" label="効果音" onToggle={onToggleSfx} variant="tile" testId="vs-sfx" />
        <button type="button" className="btn btn-tile" onClick={() => setChatOpen(true)} data-testid="vs-chat" aria-label={`対戦チャット${unreadChat ? ` 未読${unreadChat}件` : ''}`}>
          <span className="toggle-icon" aria-hidden="true">💬{unreadChat > 0 && <span className="dot-unread" />}</span>
          <span className="toggle-label">チャット</span>
        </button>
        <button type="button" className="btn btn-tile" onClick={() => setLeaving(true)} data-testid="vs-leave" disabled={phase === 'done' || phase === 'cancelled'}>
          <span className="toggle-icon" aria-hidden="true">🚪</span>
          <span className="toggle-label">退出</span>
        </button>
      </footer>

      {(phase === 'joining' || phase === 'lobby') && (
        <div className="overlay overlay-soft" role="status" data-testid="vs-lobby">
          <div className="panel">
            <Spinner label="対戦相手の準備を待っています…" />
            <p className="muted">
              {opponent ? (
                <>
                  <b>{opponent.name}</b> さん {opponent.ready ? 'は準備OKです' : 'の準備を待っています'}
                </>
              ) : (
                '対戦の情報を取得しています'
              )}
            </p>
            {match && <p className="muted small">あと {readyLeft} 秒で準備できなければ対戦は取り消されます</p>}
            <button type="button" className="btn" onClick={() => void leave()} disabled={action.busy}>
              やめる
            </button>
          </div>
        </div>
      )}

      {phase === 'countdown' && (
        <div className="countdown" role="status" aria-live="assertive" data-testid="vs-countdown">
          <span className="countdown-vs">VS {opponent?.name}</span>
          <span className="countdown-num">{countdown && countdown > 0 ? countdown : 'GO!'}</span>
        </div>
      )}

      {phase === 'finishing' && (
        <div className="finish-note" role="status" data-testid="vs-finishing">
          <Spinner label={runner?.message ?? '結果を確認しています…'} />
          <p className="muted small">あなた {runner?.myScore} 点 / 相手 {runner?.opponentScore} 点 — 相手の終了を待っています</p>
        </div>
      )}

      {phase === 'error' && (
        <div className="overlay" role="alertdialog" aria-modal="true" data-testid="vs-error">
          <div className="panel">
            <h2>対戦に接続できません</h2>
            <p className="muted">{runner?.message ?? '対戦の情報を取得できませんでした'}</p>
            <button type="button" className="btn btn-primary" onClick={onExit}>
              ロビーへ戻る
            </button>
          </div>
        </div>
      )}

      {phase === 'cancelled' && match && (
        <MatchResult match={match} onBack={onExit} onAgain={onExit} againLabel="ロビーへ戻る" />
      )}

      {phase === 'done' && match && (
        <MatchResult match={match} onBack={onExit} onAgain={() => onAgain(match)} againLabel={match.mode === 'friend' ? 'もう一度対戦 (招待)' : 'もう一度さがす'} />
      )}

      {chatOpen && <MatchChat matchId={matchId} onClose={() => setChatOpen(false)} opponent={opponent ? { id: opponent.id, name: opponent.name } : null} />}

      {leaving && (
        <Confirm
          title="対戦から退出しますか？"
          text={live ? '対戦中に退出すると、あなたの負けになります。' : '対戦はまだ始まっていません。取り消しても成績には影響しません。'}
          confirmLabel="退出する"
          danger
          onCancel={() => setLeaving(false)}
          onConfirm={() => void leave()}
        />
      )}
    </div>
  );
}
