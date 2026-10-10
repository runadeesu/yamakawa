/**
 * オンライン機能の E2E: 本番ビルド (vite preview) を実ブラウザ 2 台分 (別セッション) で操作し、
 * 実際の Supabase バックエンドに対して アカウント → フレンド → チャット → 対戦 → 切断 を検証する。
 *
 *   npm run build && npm run e2e:online
 *
 * 前提: .env.production (または .env.local) に VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY があること。
 * テスト用アカウントは `zz_e2e_*` という表示名で作られる。終わったら README の「テストデータの掃除」を参照。
 * Chromium は環境変数のプロキシ設定 (HTTPS_PROXY) を自分で読むので、特別な設定は要らない。
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const PORT = 4181;
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
if (!existsSync(new URL('../dist/index.html', import.meta.url))) {
  console.error('dist/ がありません。先に npm run build を実行してください。');
  process.exit(2);
}

/* ------------------------------------------------------------- tiny test kit */

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name} ${detail}`);
  }
}
const section = (title) => console.log(`\n■ ${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, { timeout = 15000, every = 250, what = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      /* retry */
    }
    await sleep(every);
  }
  throw new Error(`timeout waiting for ${what}`);
}

/* ----------------------------------------------------------- preview server */

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
  detached: true,
});
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('preview server did not start');
}

/* ---------------------------------------------------------------- page utils */

const RUN = Math.random().toString(36).slice(2, 7);
const NAME_A = `zz_e2e_a_${RUN}`;
const NAME_B = `zz_e2e_b_${RUN}`;
const PASSWORD = `E2e-${RUN}-pass1`;
const ids = { a: null, b: null };

const T = (page, id) => page.locator(`[data-testid="${id}"]`);
const visible = async (page, id) => (await T(page, id).count()) > 0 && (await T(page, id).first().isVisible());
const text = async (page, id) => (await T(page, id).first().innerText()).replace(/\s+/g, ' ').trim();
const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png` }).catch(() => undefined);

const EXPECTED_NOISE = /WebSocket connection|Failed to load resource|net::ERR_|Failed to fetch/;

async function newClient(browser, label, viewport = { width: 390, height: 844 }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !EXPECTED_NOISE.test(m.text())) errors.push(`${label} console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  await page.goto(BASE);
  return { label, context, page, errors };
}

async function openOnline(page) {
  await page.waitForSelector('[data-testid=online-start]:not([disabled])', { timeout: 15000 });
  await page.click('[data-testid=online-start]', { force: true });
}

async function fillAuth(page, name, password, confirm) {
  await T(page, 'auth-name').fill(name);
  await T(page, 'auth-password').fill(password);
  if (confirm !== undefined) await T(page, 'auth-confirm').fill(confirm);
}

async function signup(page, name, password) {
  await T(page, 'tab-signup').click();
  await fillAuth(page, name, password, password);
  await T(page, 'auth-submit').click();
  await page.waitForSelector('[data-testid=online-home]', { timeout: 20000 });
}

async function login(page, name, password) {
  await fillAuth(page, name, password);
  await T(page, 'auth-submit').click();
  await page.waitForSelector('[data-testid=online-home]', { timeout: 20000 });
}

const tab = (page, id) => T(page, `tab-${id}`).click();
const authError = async (page) => {
  await page.waitForSelector('[data-testid=auth-error]', { timeout: 15000 });
  return text(page, 'auth-error');
};

/** Space キーではなく実際のマウス操作で、同じ位置に落とし続ける (積み上がってゲームオーバーになる) */
async function playUntilResult(page, { x = 0.5, maxMs = 120000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (await visible(page, 'match-result')) return true;
    const box = await T(page, 'field').boundingBox().catch(() => null);
    if (box) await page.mouse.click(box.x + box.width * x, box.y + box.height * 0.2).catch(() => undefined);
    await sleep(540);
  }
  return false;
}

const phase = (page) => page.locator('[data-testid=versus]').getAttribute('data-phase').catch(() => null);

/* ===================================================================== main */

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
});

const clients = [];
let fatal = null;
try {
  await waitForServer();
  const A = await newClient(browser, 'A');
  clients.push(A);

  /* ---------------------------------------------------------------- 1. 新規登録 */
  section('1. 新規登録 (表示名 + パスワードだけ)');
  await openOnline(A.page);
  await A.page.waitForSelector('[data-testid=auth-name]', { timeout: 15000 });
  check('ログイン画面: メール欄・電話欄がない', (await A.page.locator('input[type=email], input[type=tel]').count()) === 0);
  check('パスワード再設定なしの注意書きがある', /復旧できません/.test(await A.page.locator('.auth').innerText()));
  await shot(A.page, 'online-01-auth');

  await T(A.page, 'tab-signup').click();
  await fillAuth(A.page, 'a', PASSWORD, PASSWORD);
  await T(A.page, 'auth-submit').click();
  check('短すぎる表示名を拒否', /2〜16文字/.test(await authError(A.page)));
  await fillAuth(A.page, 'bad name!', PASSWORD, PASSWORD);
  await T(A.page, 'auth-submit').click();
  await until(async () => /英数字/.test(await text(A.page, 'auth-error')), { what: 'invalid chars error' });
  check('使えない文字を拒否', true);
  await fillAuth(A.page, NAME_A, 'password123', 'password123');
  await T(A.page, 'auth-submit').click();
  await until(async () => /推測されやすい/.test(await text(A.page, 'auth-error')), { what: 'weak password error' });
  check('弱いパスワードを拒否', true);
  await fillAuth(A.page, NAME_A, PASSWORD, PASSWORD + 'x');
  await T(A.page, 'auth-submit').click();
  await until(async () => /一致しません/.test(await text(A.page, 'auth-error')), { what: 'mismatch error' });
  check('確認用パスワードの不一致を拒否', true);

  await fillAuth(A.page, NAME_A, PASSWORD, PASSWORD);
  await T(A.page, 'auth-submit').click();
  await A.page.waitForSelector('[data-testid=online-home]', { timeout: 25000 });
  check('登録でき、そのままログイン状態になる', true);
  await shot(A.page, 'online-02-lobby');

  await tab(A.page, 'profile');
  await A.page.waitForSelector('[data-testid=profile-name]', { timeout: 15000 });
  check('プロフィール: 表示名が出る', (await text(A.page, 'profile-name')) === NAME_A);
  const codeA = await text(A.page, 'profile-code');
  check('プロフィール: プレイヤーIDが出る (8文字)', /^[A-Z2-9]{8}$/.test(codeA), codeA);
  check('プロフィール: 戦績は 0 戦 0 勝 0 敗', (await text(A.page, 'stat-matches')) === '0' && (await text(A.page, 'stat-wins')) === '0');
  await shot(A.page, 'online-03-profile');

  /* ---------------------------------------------------------------- 2. 表示名の重複 */
  section('2. 表示名の重複');
  const C = await newClient(browser, 'C');
  clients.push(C);
  await openOnline(C.page);
  await C.page.waitForSelector('[data-testid=auth-name]', { timeout: 15000 });
  await T(C.page, 'tab-signup').click();
  await fillAuth(C.page, NAME_A.toUpperCase(), PASSWORD, PASSWORD);
  await T(C.page, 'auth-submit').click();
  check('大文字小文字違いでも重複として拒否', /すでに使われています/.test(await authError(C.page)));
  await C.context.close();
  clients.splice(clients.indexOf(C), 1);

  /* ---------------------------------------------------------------- 3. ログイン失敗 */
  section('3. ログイン失敗とログイン試行の制限');
  const D = await newClient(browser, 'D');
  clients.push(D);
  await openOnline(D.page);
  await D.page.waitForSelector('[data-testid=auth-name]', { timeout: 15000 });
  await fillAuth(D.page, NAME_A, 'wrong-password-1');
  await T(D.page, 'auth-submit').click();
  const wrongMsg = await authError(D.page);
  check('間違ったパスワードを拒否', /表示名またはパスワードが違います/.test(wrongMsg), wrongMsg);
  await fillAuth(D.page, `zz_e2e_nobody_${RUN}`, 'wrong-password-1');
  await T(D.page, 'auth-submit').click();
  await until(async () => (await text(D.page, 'auth-error')) === wrongMsg, { what: 'unknown-user error' }).catch(() => undefined);
  check('存在しない表示名でも同じメッセージ (アカウントの有無を漏らさない)', (await text(D.page, 'auth-error')) === wrongMsg);
  // 同じ表示名への連続失敗 → 一時ロック
  const lockName = `zz_e2e_lock_${RUN}`;
  let locked = false;
  for (let i = 0; i < 7 && !locked; i++) {
    await fillAuth(D.page, lockName, `wrong-password-${i}`);
    await T(D.page, 'auth-submit').click();
    await sleep(900);
    locked = /試行回数が多すぎます/.test(await text(D.page, 'auth-error').catch(() => ''));
  }
  check('連続失敗するとログインが一時的に制限される', locked);
  await shot(D.page, 'online-04-ratelimit');
  await D.context.close();
  clients.splice(clients.indexOf(D), 1);

  /* ---------------------------------------------------------------- 4. セッション維持・ログアウト */
  section('4. セッション維持 / ログアウト / 再ログイン');
  await A.page.reload();
  await openOnline(A.page);
  await A.page.waitForSelector('[data-testid=online-home]', { timeout: 20000 });
  check('再読み込みしてもログイン状態が保たれる', true);
  await tab(A.page, 'settings');
  check('設定: パスワード復旧不可の注意が出る', /復旧や.*変更はできません/.test(await A.page.locator('.settings').innerText()));
  await T(A.page, 'logout').click();
  await A.page.getByRole('button', { name: 'ログアウト', exact: true }).last().click();
  await A.page.waitForSelector('[data-testid=auth-name]', { timeout: 15000 });
  check('ログアウトするとログイン画面に戻る', true);
  const stored = await A.page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('teruki_online')));
  check('ログアウト後は端末に保存されたセッションが消える', stored.length === 0 || (await A.page.evaluate(() => localStorage.getItem('teruki_online_session'))) === null, JSON.stringify(stored));
  await login(A.page, NAME_A, PASSWORD);
  check('同じ表示名・パスワードで再ログインできる', true);

  /* ---------------------------------------------------------------- 5. 同時に 2 アカウント */
  section('5. 2 つのアカウントが同時にオンライン');
  const B = await newClient(browser, 'B');
  clients.push(B);
  await openOnline(B.page);
  await B.page.waitForSelector('[data-testid=auth-name]', { timeout: 15000 });
  await signup(B.page, NAME_B, PASSWORD);
  check('B も登録してログイン', true);
  await tab(A.page, 'friends');
  await tab(B.page, 'friends');

  /* ---------------------------------------------------------------- 6. フレンド */
  section('6. フレンド (検索 → 申請 → 承認 → 一覧 → 削除)');
  await T(A.page, 'friend-search').fill(NAME_A);
  await T(A.page, 'friend-search-submit').click();
  await A.page.waitForSelector('[data-testid=search-results]', { timeout: 15000 });
  check('自分自身は検索結果に出ず、申請もできない', (await T(A.page, 'search-row').count()) === 0 && (await T(A.page, 'send-request').count()) === 0);
  await T(A.page, 'friend-search').fill(NAME_B.slice(0, 12));
  await T(A.page, 'friend-search-submit').click();
  await until(async () => (await A.page.locator('[data-testid=search-row]', { hasText: NAME_B }).count()) > 0, { what: 'search result for B' });
  check('表示名の前方一致で相手が見つかる', true);
  await shot(A.page, 'online-05-search');
  await A.page.locator('[data-testid=search-row]', { hasText: NAME_B }).locator('[data-testid=send-request]').click();
  await until(async () => (await A.page.locator('[data-testid=search-row]', { hasText: NAME_B }).innerText()).includes('申請中'), { what: 'pending label' });
  check('申請後は「申請中」になり、重複申請できない', (await A.page.locator('[data-testid=send-request]').count()) === 0);

  await until(async () => visible(B.page, 'request-in'), { timeout: 40000, what: 'incoming friend request on B' });
  check('B に申請が届く (通知)', true);
  check('B のタブにバッジが出る', (await B.page.locator('[data-testid=tab-friends] .badge').count()) > 0);
  await shot(B.page, 'online-06-request');
  await T(B.page, 'request-accept').click();
  await until(async () => (await B.page.locator('[data-testid=friend-row]', { hasText: NAME_A }).count()) > 0, { what: 'B friend list' });
  check('承認すると B のフレンド一覧に A が載る', true);
  await until(async () => (await A.page.locator('[data-testid=friend-row]', { hasText: NAME_B }).count()) > 0, { timeout: 40000, what: 'A friend list' });
  check('A のフレンド一覧にも B が載る', true);
  await until(async () => /オンライン/.test(await A.page.locator('[data-testid=friend-row]', { hasText: NAME_B }).innerText()), { timeout: 40000, what: 'B online status' });
  check('フレンドのオンライン状態が表示される', true);
  await shot(A.page, 'online-07-friends');

  /* ---------------------------------------------------------------- 7. チャット */
  section('7. チャット (リアルタイム相当の配信 / 未読 / 安全性)');
  await tab(B.page, 'lobby');
  await tab(A.page, 'chat');
  await A.page.locator('[data-testid=chat-row]', { hasText: NAME_B }).click();
  await A.page.waitForSelector('[data-testid=thread]');
  await T(A.page, 'chat-input').fill('こんにちは！ よろしくね');
  await T(A.page, 'chat-send').click();
  await until(async () => /こんにちは/.test(await text(A.page, 'messages')), { what: 'own message shown' });
  check('送ったメッセージが自分の画面に出る', true);
  await until(async () => (await B.page.locator('[data-testid=tab-chat] .badge').count()) > 0, { timeout: 40000, what: 'unread badge on B' });
  check('B のチャットタブに未読バッジが出る', true);
  await tab(B.page, 'chat');
  await B.page.locator('[data-testid=chat-row]', { hasText: NAME_A }).click();
  await until(async () => /こんにちは/.test(await text(B.page, 'messages')), { what: 'message on B' });
  check('B のスレッドにメッセージが届く (送信者・時刻つき)', (await B.page.locator('.msg-theirs time').count()) > 0);
  await sleep(1200);
  await T(B.page, 'chat-input').fill('よろしく！');
  await T(B.page, 'chat-send').click();
  await until(async () => /よろしく！/.test(await text(A.page, 'messages')), { timeout: 30000, what: 'reply on A' });
  check('返信が A に届く (双方向)', true);
  await shot(A.page, 'online-08-chat');

  await sleep(800);
  await T(A.page, 'chat-input').fill('<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>');
  await T(A.page, 'chat-send').click();
  await until(async () => /img src=x/.test(await text(B.page, 'messages')), { timeout: 30000, what: 'xss text on B' });
  check('HTML を含むメッセージは文字として表示され、実行されない', (await B.page.evaluate(() => window.__xss)) === undefined && (await B.page.locator('[data-testid=messages] img, [data-testid=messages] script').count()) === 0);
  await sleep(800);
  await T(A.page, 'chat-input').fill('お前 しね よ');
  await T(A.page, 'chat-send').click();
  await until(async () => /＊＊/.test(await text(B.page, 'messages')), { timeout: 30000, what: 'masked word on B' });
  check('不適切な語は伏せ字になる', !/しね/.test(await text(B.page, 'messages')));
  await sleep(800);
  await T(A.page, 'chat-input').fill('連投テスト1');
  await T(A.page, 'chat-send').dblclick();   // 素早く 2 回押しても 1 通しか送られない (二重送信防止)
  await until(async () => /連投テスト1/.test(await text(A.page, 'messages')), { what: 'double-click message' });
  await sleep(1500);
  check('送信ボタンを素早く連打しても 1 通だけ送られる', (await A.page.locator('[data-testid=messages] .msg-mine', { hasText: '連投テスト1' }).count()) === 1);
  await sleep(1200);
  await T(A.page, 'chat-input').fill('連投テスト1');
  await T(A.page, 'chat-send').click();
  await until(async () => (await A.page.locator('.toast-error', { hasText: '同じメッセージ' }).count()) > 0, { what: 'duplicate toast' });
  check('同じメッセージの連続送信は拒否される', true);

  // 履歴の永続化: 再読み込みしても残る
  await A.page.reload();
  await openOnline(A.page);
  await A.page.waitForSelector('[data-testid=online-home]', { timeout: 20000 });
  await tab(A.page, 'chat');
  await A.page.locator('[data-testid=chat-row]', { hasText: NAME_B }).click();
  await until(async () => /こんにちは/.test(await text(A.page, 'messages')) && /よろしく！/.test(await text(A.page, 'messages')), { what: 'history after reload' });
  check('再読み込みしてもチャット履歴が残る', true);

  /* ---------------------------------------------------------------- 8. 通報・ミュート */
  section('8. 通報');
  await B.page.locator('[data-testid=messages] .msg-theirs .msg-bubble').first().click();
  await B.page.getByRole('button', { name: /このメッセージを通報/ }).click();
  await T(B.page, 'report-submit').click();
  await until(async () => (await B.page.locator('.toast-success').count()) > 0, { what: 'report toast' });
  check('メッセージを通報できる', true);

  /* ---------------------------------------------------------------- 9. クイックマッチ */
  section('9. クイックマッチ → 対戦 → 結果');
  await tab(A.page, 'lobby');
  await tab(B.page, 'lobby');
  await T(A.page, 'quick-match').click();
  await A.page.waitForSelector('[data-testid=searching]', { timeout: 10000 });
  check('検索中の表示が出る', true);
  await shot(A.page, 'online-09-searching');
  await T(A.page, 'cancel-search').click();
  await until(async () => (await T(A.page, 'searching').count()) === 0, { what: 'search cancelled' });
  check('検索をキャンセルできる', true);

  await T(A.page, 'quick-match').click();
  await T(B.page, 'quick-match').click();
  await Promise.all([A, B].map((c) => c.page.waitForSelector('[data-testid=versus]', { timeout: 45000 })));
  check('2 人が揃うと自動で対戦画面に移る', true);
  await until(async () => (await phase(A.page)) === 'countdown' || (await phase(A.page)) === 'playing', { timeout: 30000, what: 'countdown' });
  await shot(A.page, 'online-10-countdown');
  check('カウントダウンが出る', true);
  await Promise.all([A, B].map((c) => until(async () => (await phase(c.page)) === 'playing', { timeout: 30000, what: `${c.label} playing` })));
  check('両者が同時にプレイ開始', true);
  await sleep(1500);
  await shot(A.page, 'online-11-playing');
  check('対戦中の通信状態表示: 相手との通信が「良好」', /良好/.test(await text(A.page, 'opp-link')), await text(A.page, 'opp-link'));
  check('残り時間が減っている', /^[01]:\d\d$/.test(await text(A.page, 'vs-timer')) && (await text(A.page, 'vs-timer')) !== '2:00');

  // 対戦中チャット
  await T(A.page, 'vs-chat').click();
  await T(A.page, 'chat-input').fill('gl hf');
  await T(A.page, 'chat-send').click();
  await until(async () => /gl hf/.test(await text(A.page, 'messages')), { what: 'match chat own' });
  await A.page.keyboard.press('Escape');
  await T(B.page, 'vs-chat').click();
  await until(async () => /gl hf/.test(await text(B.page, 'messages')), { timeout: 30000, what: 'match chat on B' });
  check('対戦中チャットが相手に届く', true);
  await shot(B.page, 'online-12-matchchat');
  await B.page.keyboard.press('Escape');

  const results = await Promise.all([playUntilResult(A.page, { x: 0.5, maxMs: 160000 }), playUntilResult(B.page, { x: 0.3, maxMs: 160000 })]);
  check('両者のゲームが終了し、結果画面が出る', results.every(Boolean), JSON.stringify(results));
  await until(async () => (await T(A.page, 'result-title').count()) > 0 && (await T(B.page, 'result-title').count()) > 0, { timeout: 40000, what: 'result titles' });
  const [ta, tb] = await Promise.all([text(A.page, 'result-title'), text(B.page, 'result-title')]);
  await shot(A.page, 'online-13-result-a');
  await shot(B.page, 'online-14-result-b');
  const okPair = (ta === 'YOU WIN!' && tb === 'YOU LOSE') || (ta === 'YOU LOSE' && tb === 'YOU WIN!') || (ta === 'DRAW' && tb === 'DRAW');
  check(`勝敗がサーバーで確定し、両者で矛盾しない (A:${ta} / B:${tb})`, okPair);
  const [sa1, sa2, sb1, sb2] = await Promise.all([text(A.page, 'result-my-score'), text(A.page, 'result-opp-score'), text(B.page, 'result-my-score'), text(B.page, 'result-opp-score')]);
  check(`スコアが両者で一致 (A:${sa1}-${sa2} / B:${sb1}-${sb2})`, sa1 === sb2 && sa2 === sb1);

  await T(A.page, 'result-back').click();
  await T(B.page, 'result-back').click();
  await tab(A.page, 'profile');
  await tab(B.page, 'profile');
  await until(async () => (await text(A.page, 'stat-matches')) === '1', { timeout: 20000, what: 'A matches=1' });
  await until(async () => (await text(B.page, 'stat-matches')) === '1', { timeout: 20000, what: 'B matches=1' });
  const winsA = Number(await text(A.page, 'stat-wins'));
  const winsB = Number(await text(B.page, 'stat-wins'));
  check(`戦績がサーバー集計で更新される (A 勝${winsA} / B 勝${winsB})`, winsA + winsB === (ta === 'DRAW' ? 0 : 1));
  check('「最近の対戦」に結果が載る', (await T(A.page, 'recent').count()) > 0);
  await shot(A.page, 'online-15-profile-after');

  /* ---------------------------------------------------------------- 10. 招待対戦 + 切断 */
  section('10. フレンド招待の対戦 / 通信断からの復帰 / 切断時の判定');
  await tab(A.page, 'lobby');
  await tab(B.page, 'lobby');
  await until(async () => (await T(A.page, `invite-${NAME_B}`).count()) > 0, { timeout: 40000, what: 'invite button' });
  await T(A.page, `invite-${NAME_B}`).click();
  await until(async () => visible(B.page, 'invite-in'), { timeout: 40000, what: 'invite on B' });
  check('招待が相手のロビーに届く', true);
  await shot(B.page, 'online-16-invite');
  await T(B.page, 'invite-accept').click();
  await Promise.all([A, B].map((c) => c.page.waitForSelector('[data-testid=versus]', { timeout: 45000 })));
  check('承認すると両者が対戦画面へ移る', true);
  await Promise.all([A, B].map((c) => until(async () => (await phase(c.page)) === 'playing', { timeout: 40000, what: `${c.label} playing 2` })));

  // B の通信を 7 秒だけ切って復帰させる (切断扱いになる 25 秒より短い)
  const aPlays = playUntilResult(A.page, { x: 0.5, maxMs: 90000 });
  await sleep(2500);
  await B.context.setOffline(true);
  await until(async () => (await T(B.page, 'vs-message').count()) > 0, { timeout: 15000, what: 'unstable-connection note on B' });
  check('通信が切れると「通信が不安定です」と表示される', /不安定|切れ/.test(await text(B.page, 'vs-message')));
  await shot(B.page, 'online-17-offline');
  await sleep(4000);
  await B.context.setOffline(false);
  await until(async () => (await T(B.page, 'vs-message').count()) === 0, { timeout: 20000, what: 'note cleared on B' });
  check('通信が戻ると表示が消えて対戦が続く', (await phase(B.page)) === 'playing');

  // B が離脱 (ブラウザを閉じる) → A は相手の通信状態を見て、最終的に不戦勝になる
  await sleep(1500);
  await B.context.close();
  clients.splice(clients.indexOf(B), 1);
  const sawWeak = await until(async () => /不安定|途切れ/.test(await text(A.page, 'opp-link')), { timeout: 25000, what: 'link degraded on A' }).catch(() => false);
  check('相手が切断すると、相手との通信状態が悪化と表示される', !!sawWeak);
  await shot(A.page, 'online-18-opp-lost');
  await aPlays;
  await until(async () => visible(A.page, 'match-result'), { timeout: 60000, what: 'result for A after forfeit' });
  check('切断した相手に対して不戦勝になる', (await text(A.page, 'result-title')) === 'YOU WIN!', await text(A.page, 'result-title'));
  check('結果画面に理由が出る', /退出・切断/.test(await text(A.page, 'result-reason')));
  await shot(A.page, 'online-19-forfeit');
  await T(A.page, 'result-back').click();

  /* ---------------------------------------------------------------- 11. 通信断バナー */
  section('11. サーバー通信断の表示');
  await tab(A.page, 'lobby');
  await A.context.setOffline(true);
  await until(async () => visible(A.page, 'conn-offline'), { timeout: 40000, what: 'offline banner' });
  check('通信できないときは「サーバーと通信できません」を表示', true);
  await shot(A.page, 'online-20-banner');
  await A.context.setOffline(false);
  // 手動の「再接続」ボタンか、数秒ごとの自動更新のどちらかで復帰する (先に自動で復帰すればボタンは消えている)
  const reconnect = A.page.getByRole('button', { name: '再接続' });
  if (await reconnect.count()) await reconnect.click({ timeout: 2000 }).catch(() => undefined);
  await until(async () => !(await visible(A.page, 'conn-offline')), { timeout: 30000, what: 'banner cleared' });
  check('通信が戻ると表示が消える (自動復帰)', true);

  /* ---------------------------------------------------------------- 12. 権限 */
  section('12. 権限のない操作は拒否される (ブラウザから直接 API を叩いても通らない)');
  const env = Object.fromEntries(
    readFileSync(new URL('../.env.production', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );
  const SB = env.VITE_SUPABASE_URL;
  const KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const token = await A.page.evaluate(() => {
    const raw = localStorage.getItem('teruki_online_session');
    return raw ? JSON.parse(raw).access_token : null;
  });
  const myId = token ? JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub : null;
  check('(準備) ログイン済みトークンを取得', !!token && !!myId);

  const call = (path, { method = 'GET', body, auth = true, headers = {} } = {}) =>
    A.page.evaluate(
      async ([base, key, tok, path, method, body, auth, headers]) => {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { apikey: key, ...(auth ? { authorization: `Bearer ${tok}` } : {}), 'content-type': 'application/json', ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const raw = await res.text();
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not json */ }
        return { status: res.status, json, raw: raw.slice(0, 300) };
      },
      [SB, KEY, token, path, method, body, auth, headers],
    );
  const denied = (r) => r.status === 401 || r.status === 403 || r.status === 404 || r.status === 400 || (r.json && r.json.code === 'P0001') || (r.json && r.json.code === '42501');

  let r = await call('/rest/v1/players?select=*', { auth: false });
  check('未ログイン: players を一覧できない', r.status === 401 || (Array.isArray(r.json) && r.json.length === 0), `${r.status} ${r.raw}`);
  r = await call('/rest/v1/rpc/get_me', { method: 'POST', body: {}, auth: false });
  check('未ログイン: get_me は拒否される', denied(r), `${r.status} ${r.raw}`);
  r = await call('/rest/v1/rpc/chat_history', { method: 'POST', body: { p_friend: myId }, auth: false });
  check('未ログイン: チャット履歴は読めない', denied(r), `${r.status} ${r.raw}`);
  r = await call('/rest/v1/players', { method: 'POST', body: { id: myId, name: 'hack', name_key: 'hack', code: 'HACKHACK' } });
  check('ログイン済みでも players に直接 INSERT できない', denied(r), `${r.status} ${r.raw}`);
  r = await call(`/rest/v1/players?id=eq.${myId}`, { method: 'PATCH', body: { wins: 999, matches: 999 }, headers: { prefer: 'return=representation' } });
  check('自分の勝利数を直接書き換えられない', denied(r) || (Array.isArray(r.json) && r.json.length === 0), `${r.status} ${r.raw}`);
  r = await call('/rest/v1/rpc/svc_login_lookup', { method: 'POST', body: { p_name_key: NAME_B } });
  check('サービス専用の関数 (ログイン照会) は一般ユーザーが呼べない', denied(r), `${r.status} ${r.raw}`);
  r = await call('/rest/v1/rpc/svc_create_player', { method: 'POST', body: { p_user_id: myId, p_name: 'x', p_name_key: 'x', p_auth_email: 'x@x' } });
  check('サービス専用の関数 (プレイヤー作成) も呼べない', denied(r), `${r.status} ${r.raw}`);
  r = await call('/rest/v1/rate_limits?select=*', { headers: { 'accept-profile': 'app_private' } });
  check('内部スキーマ (app_private) は API から見えない', denied(r) || r.status === 406, `${r.status} ${r.raw}`);
  r = await call('/rest/v1/match_seeds?select=*');
  check('対戦の出現順テーブルは直接読めない', denied(r) || (Array.isArray(r.json) && r.json.length === 0), `${r.status} ${r.raw}`);
  r = await call('/rest/v1/rpc/match_get', { method: 'POST', body: { p_match: '00000000-0000-4000-8000-000000000000' } });
  check('他人の (存在しない) 対戦は取得できない', denied(r) && /not_found/.test(r.raw), `${r.status} ${r.raw}`);
  r = await call('/rest/v1/rpc/chat_send', { method: 'POST', body: { p_friend: '00000000-0000-4000-8000-000000000000', p_body: 'hi' } });
  check('フレンドでない相手にはチャットを送れない', denied(r), `${r.status} ${r.raw}`);
  r = await call('/rest/v1/rpc/match_finish', { method: 'POST', body: { p_match: '00000000-0000-4000-8000-000000000000', p_log: [], p_reason: 'over' } });
  check('参加していない対戦の結果は提出できない', denied(r) && /not_found/.test(r.raw), `${r.status} ${r.raw}`);
  r = await call('/rest/v1/rpc/friends_list', { method: 'POST', body: {} });
  const bId = Array.isArray(r.json) ? r.json.find((f) => f.name === NAME_B)?.id : null;
  const burst = await A.page.evaluate(
    async ([base, key, tok, friend]) => {
      const codes = [];
      for (let i = 0; i < 26; i++) {
        const res = await fetch(`${base}/rest/v1/rpc/chat_send`, {
          method: 'POST',
          headers: { apikey: key, authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
          body: JSON.stringify({ p_friend: friend, p_body: `spam ${i} ${Math.random()}` }),
        });
        const j = await res.json().catch(() => ({}));
        codes.push(res.ok ? 'ok' : (j.message ?? res.status));
        await new Promise((x) => setTimeout(x, i < 3 ? 0 : 520));
      }
      return codes;
    },
    [SB, KEY, token, bId],
  );
  check('チャットの連投は一定数でサーバーが制限する (rate_limited / too_fast)', burst.some((c) => c === 'rate_limited') && burst.some((c) => c === 'ok'), JSON.stringify(burst));
  r = await call('/rest/v1/rpc/chat_send', { method: 'POST', body: { p_friend: bId, p_body: 'x'.repeat(201) } });
  check('201 文字以上は拒否される', denied(r) && /too_long|rate_limited/.test(r.raw), `${r.status} ${r.raw}`);
  r = await call('/rest/v1/messages?select=body', {});
  check('メッセージは自分が読める範囲だけ返る (全件取得できない)', r.status === 200 && Array.isArray(r.json) && r.json.every((m) => typeof m.body === 'string'), `${r.status}`);
  r = await call('/rest/v1/rpc/search_players', { method: 'POST', body: { p_query: '%' } });
  check('検索のワイルドカード (%) は全件列挙に使えない', denied(r) || (Array.isArray(r.json) && r.json.length === 0), `${r.status} ${r.raw.slice(0, 120)}`);
  r = await call('/rest/v1/rpc/search_players', { method: 'POST', body: { p_query: "x' or '1'='1" } });
  check('SQL インジェクション文字列は無害な検索語として扱われる (結果 0 件)', r.status === 200 && Array.isArray(r.json) && r.json.length === 0, `${r.status} ${r.raw.slice(0, 120)}`);
  r = await call('/rest/v1/rpc/search_players', { method: 'POST', body: { p_query: "x'; drop table players; --" } });
  check('長すぎる検索語は入力検証で拒否される', denied(r) && /invalid_input/.test(r.raw), `${r.status} ${r.raw.slice(0, 120)}`);
  r = await call('/rest/v1/players?select=id&limit=1');
  check('(確認) players テーブルは無事', r.status === 200 && Array.isArray(r.json));
  /* ---------------------------------------------------------------- 13. フレンド削除 */
  section('13. フレンド削除');
  await tab(A.page, 'friends');
  await A.page.locator('[data-testid=friend-row]', { hasText: NAME_B }).locator('.row-main').click();
  await T(A.page, 'sheet-remove').click();
  await A.page.getByRole('button', { name: '削除する' }).click();
  await until(async () => (await A.page.locator('[data-testid=friend-row]', { hasText: NAME_B }).count()) === 0, { what: 'friend removed from list' });
  check('フレンドを削除すると一覧から消える (確認ダイアログつき)', true);
  r = await call('/rest/v1/rpc/friends_list', { method: 'POST', body: {} });
  check('サーバー側でもフレンド関係が削除されている', Array.isArray(r.json) && !r.json.some((f) => f.name === NAME_B), `${r.status}`);
  await shot(A.page, 'online-21-friend-removed');
  writeFileSync(`${OUT}online-session-info.json`, JSON.stringify({ NAME_A, NAME_B, RUN }, null, 2));
} catch (error) {
  fatal = error;
  console.log(`\n✗ 異常終了: ${error.message}`);
  for (const c of clients) await shot(c.page, `online-fail-${c.label}`);
} finally {
  for (const c of clients) {
    if (c.errors.length) {
      failures.push(`${c.label}: unexpected browser errors`);
      for (const e of c.errors) console.log(`  ✗ ${e}`);
    }
  }
  await browser.close().catch(() => undefined);
  try {
    process.kill(-server.pid);
  } catch {
    server.kill();
  }
  console.log(`\nテスト用アカウント: ${NAME_A}, ${NAME_B} (zz_e2e_*)`);
  console.log(`${passed} passed, ${failures.length + (fatal ? 1 : 0)} failed`);
  if (failures.length) console.log('失敗:\n - ' + failures.join('\n - '));
  process.exit(failures.length || fatal ? 1 : 0);
}
