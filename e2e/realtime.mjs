/**
 * Realtime の実機検証 (Node + supabase-js, 実際の Supabase バックエンド)。
 *   NODE_USE_ENV_PROXY=1 node e2e/realtime.mjs      # プロキシ越しの環境のみ NODE_USE_ENV_PROXY=1
 *
 * 3 つの独立したクライアント (A, B, 第三者 C) を作り、次を確認する:
 *   1. フレンド申請 / 承認 / チャット / 対戦の更新が、当事者にだけ WebSocket で届く (postgres_changes + RLS)
 *   2. 対戦の盤面共有 (private Broadcast) が参加者間で届き、第三者は購読すらできない
 *   3. ブロックした相手のメッセージは Realtime でも届かない
 * テスト用アカウントは `zz_e2e_rt*` という表示名で作られる。
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.production', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const URL_ = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name} ${detail}`);
  }
};
const section = (t) => console.log(`\n■ ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RUN = Math.random().toString(36).slice(2, 7);
const PASSWORD = `Rt-${RUN}-pass-1`;

async function account(action, name) {
  const res = await fetch(`${URL_}/functions/v1/account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: KEY },
    body: JSON.stringify({ action, name, password: PASSWORD }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${action} ${name}: ${JSON.stringify(json)}`);
  return json;
}

async function makeClient(label) {
  const name = `zz_e2e_rt${label}_${RUN}`;
  const { session, player } = await account('signup', name);
  const client = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  const rpc = async (fn, args = {}) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data;
  };
  await rpc('heartbeat');
  return { label, name, id: player.id, client, rpc, events: [] };
}

/** postgres_changes を購読して、受信したものを c.events に溜める */
function listen(c, specs) {
  const ch = c.client.channel(`e2e-${c.label}-${Math.random().toString(36).slice(2, 6)}`);
  for (const spec of specs) {
    ch.on('postgres_changes', spec, (payload) => c.events.push({ table: spec.table, type: payload.eventType, row: payload.new }));
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${c.label}: subscribe timeout`)), 15000);
    ch.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(t);
        resolve(ch);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        clearTimeout(t);
        reject(new Error(`${c.label}: ${status} ${err?.message ?? ''}`));
      }
    });
  });
}

async function waitFor(fn, { timeout = 10000, what = 'condition' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
}

const clients = [];
let fatal = null;
try {
  section('0. 準備: 3 つの独立したクライアントでログイン');
  const A = await makeClient('a');
  const B = await makeClient('b');
  const C = await makeClient('c');
  clients.push(A, B, C);
  check('3 アカウントを作成し、それぞれ別セッションでサインイン', !!A.id && !!B.id && !!C.id && new Set([A.id, B.id, C.id]).size === 3);

  const mine = (c) => [
    { event: '*', schema: 'public', table: 'friend_requests' },
    { event: '*', schema: 'public', table: 'friendships' },
    { event: 'INSERT', schema: 'public', table: 'messages' },
    { event: '*', schema: 'public', table: 'match_players' },
    { event: 'UPDATE', schema: 'public', table: 'matches' },
    { event: '*', schema: 'public', table: 'match_invites' },
  ];
  const chans = await Promise.all([A, B, C].map((c) => listen(c, mine(c))));
  check('WebSocket (Realtime) に 3 クライアントとも接続できた', chans.length === 3);
  // 購読の反映 (サーバー側の登録) が済むまで少し待つ。接続直後の数秒は取りこぼすことがあり、アプリ側は定期更新で補っている
  await sleep(3000);

  section('1. フレンド申請・承認がリアルタイムで届く');
  await A.rpc('friend_request_send', { p_target: B.id });
  const gotReq = await waitFor(() => B.events.find((e) => e.table === 'friend_requests' && e.type === 'INSERT'));
  check('B に「フレンド申請」が WebSocket で即時に届く', !!gotReq);
  check('第三者 C には届かない (RLS)', !C.events.some((e) => e.table === 'friend_requests'));
  const reqs = await B.rpc('friend_requests_list');
  await B.rpc('friend_request_respond', { p_request: reqs.incoming[0].id, p_accept: true });
  const friendEvA = await waitFor(() => A.events.find((e) => e.table === 'friendships'));
  const friendEvB = await waitFor(() => B.events.find((e) => e.table === 'friendships'));
  check('承認で A・B の両方に「フレンド成立」が届く', !!friendEvA && !!friendEvB);
  check('第三者 C にはフレンド成立が届かない', !C.events.some((e) => e.table === 'friendships'));

  section('2. チャットがリアルタイムで届く / 第三者には届かない');
  await A.rpc('chat_send', { p_friend: B.id, p_body: 'realtime こんにちは' });
  const msgB = await waitFor(() => B.events.find((e) => e.table === 'messages' && /realtime/.test(e.row.body)));
  check('B にメッセージが即時に届く (本文・送信者つき)', !!msgB && msgB.row.sender_id === A.id);
  check('第三者 C には届かない (RLS)', !(await waitFor(() => C.events.find((e) => e.table === 'messages'), { timeout: 2500 })));
  const unread = await B.rpc('get_me');
  check('B の未読数がサーバーで数えられている', unread.unread >= 1, JSON.stringify(unread.unread));

  section('3. ミュート / ブロックした相手のメッセージは Realtime でも届かない');
  await B.rpc('block_set', { p_target: A.id, p_mode: 'mute' });   // ミュートはフレンドのまま、相手のメッセージだけ見えなくする
  B.events.length = 0;
  await sleep(700);
  let muteSend = 'ok';
  try {
    await A.rpc('chat_send', { p_friend: B.id, p_body: 'muted message' });
  } catch (e) {
    muteSend = e.message;
  }
  check('ミュート中でも A の送信自体は成功する (相手には通知されない)', muteSend === 'ok', muteSend);
  const leaked = await waitFor(() => B.events.find((e) => e.table === 'messages' && /muted message/.test(e.row.body)), { timeout: 3500 });
  check('ミュート中の相手のメッセージは B に Realtime で配信されない (RLS)', !leaked);
  const hidden = await B.rpc('chat_history', { p_friend: A.id });
  check('ミュート中のメッセージは履歴にも出ない', !hidden.some((m) => /muted message/.test(m.body)));
  await B.rpc('block_clear', { p_target: A.id });
  const shown = await B.rpc('chat_history', { p_friend: A.id });
  check('ミュートを解除すると履歴に現れる', shown.some((m) => /muted message/.test(m.body)));
  await B.rpc('block_set', { p_target: A.id, p_mode: 'block' });
  let blockedSend = 'ok';
  try {
    await A.rpc('chat_send', { p_friend: B.id, p_body: 'blocked message' });
  } catch (e) {
    blockedSend = e.message;
  }
  check('ブロックするとフレンドが解除され、相手は送信できなくなる (拒否される)', blockedSend === 'forbidden' || blockedSend === 'not_friends', blockedSend);
  await B.rpc('block_clear', { p_target: A.id });
  // ブロックでフレンドが外れたので、以降の対戦テストのために結び直す
  await A.rpc('friend_request_send', { p_target: B.id });
  const again = await B.rpc('friend_requests_list');
  await B.rpc('friend_request_respond', { p_request: again.incoming[0].id, p_accept: true });

  section('4. マッチ成立・盤面共有 (private Broadcast)');
  await A.rpc('queue_join');
  const joined = await B.rpc('queue_join');
  check('クイックマッチで 2 人が組まれる', joined.status === 'matched');
  const matchId = joined.match_id;
  const matchEv = await waitFor(() => A.events.find((e) => e.table === 'match_players') && B.events.find((e) => e.table === 'match_players'));
  check('対戦の成立が A・B に WebSocket で届く', !!matchEv);
  check('第三者 C には対戦の成立が届かない', !C.events.some((e) => e.table === 'match_players'));

  const open = (c) =>
    new Promise((resolve) => {
      const ch = c.client.channel(`match:${matchId}`, { config: { private: true, broadcast: { self: false, ack: false } } });
      const got = [];
      ch.on('broadcast', { event: 'snap' }, ({ payload }) => got.push(payload));
      const t = setTimeout(() => resolve({ ch, got, status: 'TIMEOUT' }), 8000);
      ch.subscribe((status) => {
        if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
          clearTimeout(t);
          resolve({ ch, got, status });
        }
      });
    });
  const [ca, cb, cc] = await Promise.all([open(A), open(B), open(C)]);
  check('参加者 A・B は対戦チャンネルに接続できる', ca.status === 'SUBSCRIBED' && cb.status === 'SUBSCRIBED', `${ca.status}/${cb.status}`);
  check('第三者 C は対戦チャンネルに接続できない (Realtime のアクセス制御)', cc.status !== 'SUBSCRIBED', cc.status);

  await ca.ch.send({ type: 'broadcast', event: 'snap', payload: { s: 12, a: 1, n: [1, 100, 200], q: 1 } });
  const snap = await waitFor(() => cb.got[0]);
  check('A の盤面スナップショットが B に届く', !!snap && snap.s === 12);
  check('第三者 C には届かない', cc.got.length === 0);

  await A.rpc('match_ready', { p_match: matchId });
  const st = await B.rpc('match_ready', { p_match: matchId });
  check('両者 ready で対戦が始まる (サーバーが開始時刻を決定)', st.status === 'playing' && !!st.starts_at && st.seq.length === 400);
  const cst = await C.rpc('match_get', { p_match: matchId }).catch((e) => e.message);
  check('第三者 C は対戦情報を取得できない', cst === 'not_found', String(cst));

  await A.rpc('match_leave', { p_match: matchId });
  const finished = await waitFor(() => B.events.find((e) => e.table === 'matches' && e.row.status === 'finished'));
  check('対戦の終了 (棄権) が B に即時に届く', !!finished);
  const after = await B.rpc('match_get', { p_match: matchId });
  check('結果: 棄権した A の負け・B の勝ち (サーバーが確定)', after.winner_id === B.id && after.end_reason === 'opponent_forfeit');
  const profileB = await B.rpc('get_profile');
  check('B の戦績に反映される (1 戦 1 勝)', profileB.matches === 1 && profileB.wins === 1);

  await Promise.all([ca.ch, cb.ch, cc.ch].map((ch) => ch.unsubscribe()));
  await writeNames();
} catch (error) {
  fatal = error;
  console.log(`\n✗ 異常終了: ${error.message}`);
} finally {
  for (const c of clients) {
    try {
      await c.client.removeAllChannels();
    } catch {
      /* ignore */
    }
  }
  console.log(`\nテスト用アカウント: zz_e2e_rt{a,b,c}_${RUN}`);
  console.log(`${passed} passed, ${failures.length + (fatal ? 1 : 0)} failed`);
  if (failures.length) console.log('失敗:\n - ' + failures.join('\n - '));
  process.exit(failures.length || fatal ? 1 : 0);
}

async function writeNames() {
  /* 掃除用に表示名の接頭辞だけ分かればよい */
}
