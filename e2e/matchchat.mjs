/**
 * 対戦中チャットの入力テスト (実ブラウザ 2 台 × 実 Supabase)。
 *   npm run build && node e2e/matchchat.mjs
 *
 * 対戦画面は 0.1 秒ごとに再描画される。そのあいだ入力欄がフォーカスを保てるか、
 * 実際のキー入力 (keyboard.type) で検証する。`fill()` は値を直接入れるのでフォーカス喪失を検出できない。
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const PORT = 4182;
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
if (!existsSync(new URL('../dist/index.html', import.meta.url))) {
  console.error('dist/ がありません。先に npm run build を実行してください。');
  process.exit(2);
}

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 20000, what = 'condition' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${what}`);
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
  detached: true,
});
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(BASE)).ok) break;
  } catch {
    /* not up yet */
  }
  await sleep(250);
}

const RUN = Math.random().toString(36).slice(2, 7);
const PASSWORD = `Mc-${RUN}-pass-1`;
const T = (page, id) => page.locator(`[data-testid="${id}"]`);
const text = async (page, id) => (await T(page, id).first().innerText()).replace(/\s+/g, ' ').trim();
const phase = (page) => page.locator('[data-testid=versus]').getAttribute('data-phase').catch(() => null);

async function newClient(browser, label, viewport) {
  const context = await browser.newContext({ viewport, hasTouch: false });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  await page.goto(BASE);
  await page.waitForSelector('[data-testid=online-start]:not([disabled])', { timeout: 15000 });
  await page.click('[data-testid=online-start]', { force: true });
  await page.waitForSelector('[data-testid=auth-name]', { timeout: 15000 });
  await T(page, 'tab-signup').click();
  await T(page, 'auth-name').fill(`zz_e2e_mc${label}_${RUN}`);
  await T(page, 'auth-password').fill(PASSWORD);
  await T(page, 'auth-confirm').fill(PASSWORD);
  await T(page, 'auth-submit').click();
  await page.waitForSelector('[data-testid=online-home]', { timeout: 25000 });
  return { label, context, page, errors };
}

const browser = await chromium.launch({ executablePath: existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined });
const clients = [];
let fatal = null;
try {
  const A = await newClient(browser, 'a', { width: 390, height: 844 });
  const B = await newClient(browser, 'b', { width: 390, height: 844 });
  clients.push(A, B);
  console.log('\n■ 対戦中チャットの入力 (実際のキー入力)');
  await T(A.page, 'quick-match').click();
  await T(B.page, 'quick-match').click();
  await Promise.all([A, B].map((c) => c.page.waitForSelector('[data-testid=versus]', { timeout: 45000 })));
  await Promise.all([A, B].map((c) => until(async () => (await phase(c.page)) === 'playing', { timeout: 40000, what: `${c.label} playing` })));
  check('対戦が始まった (対戦画面は 0.1 秒ごとに再描画される)', true);

  // 対戦中のチャットボタン → 入力欄を押す → 実際にキーを打つ
  await T(A.page, 'vs-chat').click();
  const input = T(A.page, 'chat-input');
  await input.click();
  const focused = () => A.page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'chat-input');
  check('入力欄を押すとフォーカスが入る', await focused());

  const message = 'gl hf see you';
  let lost = 0;
  for (const ch of message) {
    await A.page.keyboard.type(ch);
    await sleep(110);
    if (!(await focused())) lost++;
  }
  check('文字を打っている間、入力欄のフォーカスが外れない', lost === 0, `外れた回数: ${lost}`);
  check('打った文字がすべて入力欄に残っている', (await input.inputValue()) === message, JSON.stringify(await input.inputValue()));
  await sleep(1500);
  check('入力したまま待っても、フォーカスと内容が保たれる', (await focused()) && (await input.inputValue()) === message);
  check('チャットのシートが閉じない', (await T(A.page, 'match-chat').count()) === 1);
  check('入力中のスペースで、ゲーム側のてるきが落ちない', (await A.page.evaluate(() => document.querySelector('[data-testid=vs-my-score]')?.textContent)) === '0');

  await A.page.keyboard.press('Enter');
  await until(async () => /gl hf see you/.test(await text(A.page, 'messages')), { what: 'sent message shown' });
  check('Enter で送信できる', true);

  await T(B.page, 'vs-chat').click();
  await until(async () => /gl hf see you/.test(await text(B.page, 'messages')), { timeout: 30000, what: 'message on B' });
  check('相手にも届く', true);
  await B.page.locator('[data-testid=chat-input]').click();
  await B.page.keyboard.type('ok!', { delay: 90 });
  await sleep(800);
  check('相手側 (B) でも入力が途切れない', (await B.page.locator('[data-testid=chat-input]').inputValue()) === 'ok!');

  // 後片付け: A が退出して対戦を終わらせる
  await A.page.keyboard.press('Escape');
  await T(A.page, 'vs-leave').click();
  await A.page.getByRole('button', { name: '退出する' }).click();
} catch (error) {
  fatal = error;
  console.log(`\n✗ 異常終了: ${error.message}`);
  for (const c of clients) await c.page.screenshot({ path: `${OUT}matchchat-fail-${c.label}.png` }).catch(() => undefined);
} finally {
  for (const c of clients) for (const e of c.errors) {
    failures.push(e);
    console.log(`  ✗ ${e}`);
  }
  await browser.close().catch(() => undefined);
  try {
    process.kill(-server.pid);
  } catch {
    server.kill();
  }
  console.log(`\nテスト用アカウント: zz_e2e_mc{a,b}_${RUN}`);
  console.log(`${passed} passed, ${failures.length + (fatal ? 1 : 0)} failed`);
  process.exit(failures.length || fatal ? 1 : 0);
}
