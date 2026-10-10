/**
 * E2E: 本番ビルド (vite preview) を実ブラウザ(Chromium)で操作し、遊べることを検証する。
 *   npm run build && npm run e2e
 * 状態の読み取りだけ ?debug 用フック (window.__TERUKI__) を使い、入力は実際のマウス/タッチ/キーボードで行う。
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const PORT = 4179;
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = new URL('./out/', import.meta.url).pathname;
const FIELD = { w: 360, h: 580 };
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

/* ----------------------------------------------------------- preview server */

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
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

/** AudioBufferSourceNode / OscillatorNode の start を記録し、ボイス(MP3)の再生を数える */
const AUDIO_SPY = () => {
  const log = { buffers: [], oscillators: 0 };
  window.__audioLog = log;
  const proto = AudioBufferSourceNode.prototype;
  const start = proto.start;
  const stop = proto.stop;
  proto.start = function (...args) {
    log.buffers.push({ duration: this.buffer ? this.buffer.duration : 0, at: this.context.currentTime, stopAt: null, node: this });
    return start.apply(this, args);
  };
  proto.stop = function (when = 0) {
    const entry = log.buffers.find((b) => b.node === this);
    if (entry) entry.stopAt = when || this.context.currentTime;
    return stop.call(this, when);
  };
  const osc = OscillatorNode.prototype;
  const oscStart = osc.start;
  osc.start = function (...args) {
    log.oscillators++;
    return oscStart.apply(this, args);
  };
};

const voiceLog = (page) =>
  page.evaluate(() =>
    window.__audioLog.buffers.filter((b) => b.duration > 1).map((b) => ({ at: b.at, duration: b.duration, stopAt: b.stopAt })),
  );
const oscCount = (page) => page.evaluate(() => window.__audioLog.oscillators);

const gameState = (page) =>
  page.evaluate(() => {
    const t = window.__TERUKI__;
    const s = t.game.session;
    return {
      phase: s.phase,
      score: s.score,
      best: s.best,
      current: s.currentLevel,
      cooldown: s.cooldownMs,
      combo: s.combo,
      aimX: s.aimX,
      finalCount: s.finalCount,
      pieces: [...s.world.pieces.values()].map((p) => ({ level: p.level, x: p.body.position.x, y: p.body.position.y })),
      audio: { ...t.audio.stats },
    };
  });

const waitReady = (page) =>
  page.waitForFunction(() => window.__TERUKI__ && window.__TERUKI__.game.session.cooldownMs <= 0, null, { timeout: 5000 });
const waitVoiceLoaded = (page) => page.waitForFunction(() => window.__TERUKI__.audio.stats.voiceLoaded, null, { timeout: 5000 });
const restart = (page) => page.evaluate(() => window.__TERUKI__.game.restart());
const spawnPiece = (page, level, x, y) => page.evaluate(([l, px, py]) => window.__TERUKI__.spawn(l, px, py), [level, x, y]);

async function openGame(browser, options = {}) {
  const { viewport = { width: 390, height: 844 }, mobile = false, query = '?debug=1&seed=3', init = [], routes = [] } = options;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    hasTouch: mobile,
    isMobile: mobile,
  });
  await context.addInitScript(AUDIO_SPY);
  for (const script of init) await context.addInitScript(script);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  for (const [pattern, handler] of routes) await page.route(pattern, handler);
  await page.goto(BASE + query);
  return { context, page, errors };
}

async function startGame(page) {
  await page.waitForSelector('[data-testid=start]:not([disabled])');
  await page.click('[data-testid=start]', { force: true }); // START は脈動アニメ中なので force
  await page.waitForSelector('[data-testid=field]');
  await page.waitForFunction(() => window.__TERUKI__);
}

async function fieldRect(page) {
  const box = await page.locator('[data-testid=field]').boundingBox();
  if (!box) throw new Error('field not visible');
  return box;
}

const toScreen = (rect, x, y = 100) => ({ x: rect.x + (x / FIELD.w) * rect.width, y: rect.y + (y / FIELD.h) * rect.height });

async function clickField(page, x) {
  const rect = await fieldRect(page);
  const p = toScreen(rect, x);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.up();
}

/** 実際のマウス操作だけで遊ぶボット。同じレベルの上に落として合体を狙う */
async function playBot(page, drops) {
  const rect = await fieldRect(page);
  let played = 0;
  for (let i = 0; i < drops; i++) {
    await page.waitForFunction(
      () => window.__TERUKI__.game.session.cooldownMs <= 0 || window.__TERUKI__.game.session.phase !== 'playing',
      null,
      { timeout: 5000 },
    );
    const st = await gameState(page);
    if (st.phase !== 'playing') break;
    const same = st.pieces.filter((p) => p.level === st.current).sort((a, b) => a.y - b.y)[0];
    const x = same ? same.x : 30 + ((i * 97) % 300);
    const p = toScreen(rect, x);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.up();
    played++;
  }
  return played;
}

/* --------------------------------------------------------------------- tests */

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let exitCode = 0;
try {
  await waitForServer();

  /* 1 ---------------------------------------------------------------- title */
  section('タイトル画面・遊び方・設定の保存');
  {
    const { context, page, errors } = await openGame(browser);
    await page.waitForSelector('[data-testid=start]:not([disabled])');
    check('document title', (await page.title()) === 'やまかわてるきゲーム');
    const text = await page.locator('.title-main').innerText();
    check('logo text', text.includes('てるき') && text.includes('ゲーム'));
    check('subtitle', text.includes('同じてるきを合体させろ！'));
    check('START button', (await page.locator('[data-testid=start]').innerText()).trim() === 'START');
    await page.screenshot({ path: OUT + 'title.png' });

    await page.click('[data-testid=howto]');
    check('how-to dialog opens', await page.locator('[role=dialog]').isVisible());
    await page.screenshot({ path: OUT + 'howto.png' });
    await page.keyboard.press('Escape');
    check('how-to closes with Escape', !(await page.locator('[role=dialog]').isVisible()));

    await page.click('[data-testid=title-voice]');
    await page.click('[data-testid=title-sfx]');
    const stored = await page.evaluate(() => [localStorage.getItem('teruki_sound_enabled'), localStorage.getItem('teruki_sfx_enabled')]);
    check('voice/sfx OFF saved to localStorage', stored[0] === '0' && stored[1] === '0', JSON.stringify(stored));
    await page.reload();
    await page.waitForSelector('[data-testid=start]:not([disabled])');
    check(
      'settings survive reload',
      (await page.getAttribute('[data-testid=title-voice]', 'aria-pressed')) === 'false' &&
        (await page.getAttribute('[data-testid=title-sfx]', 'aria-pressed')) === 'false',
    );
    await page.click('[data-testid=title-voice]');
    await page.click('[data-testid=title-sfx]');
    const back = await page.evaluate(() => [localStorage.getItem('teruki_sound_enabled'), localStorage.getItem('teruki_sfx_enabled')]);
    check('voice/sfx ON saved again', back[0] === '1' && back[1] === '1');
    check('no console errors on title', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* 2 ----------------------------------------------------- desktop controls */
  section('PC操作: マウス・キーボード・連打');
  {
    const { context, page, errors } = await openGame(browser, { viewport: { width: 1280, height: 800 } });
    await startGame(page);
    await waitVoiceLoaded(page);
    let st = await gameState(page);
    check('game starts with score 0 and no pieces', st.score === 0 && st.pieces.length === 0 && st.phase === 'playing');

    await clickField(page, 60);
    st = await gameState(page);
    check('mouse click drops a piece', st.pieces.length === 1);
    check('piece lands at the clicked x', Math.abs(st.pieces[0].x - 60) < 6, `x=${st.pieces[0]?.x}`);
    check('drop adds score', st.score === 1);

    for (let i = 0; i < 15; i++) await clickField(page, 200);
    st = await gameState(page);
    check('rapid clicking is limited by the cooldown (1 drop per cooldown)', st.pieces.length <= 2, `pieces=${st.pieces.length}`);

    await waitReady(page);
    const before = (await gameState(page)).aimX;
    await page.keyboard.down('ArrowRight');
    await sleep(350);
    await page.keyboard.up('ArrowRight');
    const afterRight = (await gameState(page)).aimX;
    await page.keyboard.down('ArrowLeft');
    await sleep(700);
    await page.keyboard.up('ArrowLeft');
    const afterLeft = (await gameState(page)).aimX;
    check('→ moves the aim right', afterRight > before + 30, `${before} -> ${afterRight}`);
    check('← moves the aim left', afterLeft < afterRight - 60, `${afterRight} -> ${afterLeft}`);
    const count = (await gameState(page)).pieces.length;
    await page.keyboard.press('Space');
    await sleep(60);
    check('Space drops a piece', (await gameState(page)).pieces.length === count + 1);
    check('no console errors', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* 3 ------------------------------------------------------------ touch */
  section('スマホ操作: ドラッグで位置決め → 離すと落下 / タップ');
  {
    const { context, page, errors } = await openGame(browser, { mobile: true });
    await startGame(page);
    const rect = await fieldRect(page);
    const cdp = await context.newCDPSession(page);
    const a = toScreen(rect, 90);
    const b = toScreen(rect, 270);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y }] });
    for (let i = 1; i <= 6; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: a.x + ((b.x - a.x) * i) / 6, y: a.y }],
      });
    }
    let st = await gameState(page);
    check('dragging moves the aim without dropping', st.pieces.length === 0 && Math.abs(st.aimX - 270) < 12, `aim=${st.aimX}`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(80);
    st = await gameState(page);
    check('releasing the finger drops at the dragged x', st.pieces.length === 1 && Math.abs(st.pieces[0].x - 270) < 12, JSON.stringify(st.pieces));

    await waitReady(page);
    const t = toScreen(rect, 100);
    await page.touchscreen.tap(t.x, t.y);
    await sleep(80);
    st = await gameState(page);
    check('tapping drops a piece at the tapped x', st.pieces.length === 2 && Math.abs(st.pieces[1].x - 100) < 12, JSON.stringify(st.pieces));
    check('no console errors', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* 4 ------------------------------------------------- merge / score / voice */
  section('合体・スコア・コンボ・MP3ボイス (ボットが実操作でプレイ)');
  {
    const { context, page, errors } = await openGame(browser, { viewport: { width: 1280, height: 800 } });
    await startGame(page);
    await waitVoiceLoaded(page);
    const st0 = await gameState(page);
    check('voice MP3 loaded & decoded', st0.audio.voiceLoaded && st0.audio.voiceDurationMs > 1000, JSON.stringify(st0.audio));

    // 決定的な合体: 同じレベルを近くに2体
    await spawnPiece(page, 1, 150, 520);
    await spawnPiece(page, 1, 165, 520);
    await sleep(900);
    let st = await gameState(page);
    check('two same pieces merge into one next-level piece', st.pieces.length === 1 && st.pieces[0].level === 2, JSON.stringify(st.pieces));
    check('merge raises the score', st.score === 3, `score=${st.score}`);
    check('first merge plays the provided MP3', (await voiceLog(page)).length === 1, JSON.stringify(await voiceLog(page)));
    check('HUD score reflects the session', (await page.locator('[data-testid=score]').innerText()) === String(st.score));

    // 連鎖 → コンボ
    await restart(page);
    await spawnPiece(page, 3, 180, 540);
    await spawnPiece(page, 2, 165, 470);
    await spawnPiece(page, 2, 195, 470);
    let combo = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      combo = Math.max(combo, (await gameState(page)).combo);
    }
    check('chain merge produces a combo (>= 2)', combo >= 2, `combo=${combo}`);
    await page.screenshot({ path: OUT + 'combo.png' });

    // 本番のプレイ
    await restart(page);
    await sleep(2000); // ボイスのクールダウン明け
    const played = await playBot(page, 55);
    await sleep(1200);
    st = await gameState(page);
    check(`bot played ${played} drops`, played >= 40);
    check('score grew beyond drop points (real merges happened)', st.score > played * 3, `score=${st.score}`);
    const voices = await voiceLog(page);
    check('MP3 voice played during play', voices.length >= 3, `plays=${voices.length}`);
    check('voice cooldown suppressed some merges', st.audio.voiceSkipped > 0, JSON.stringify(st.audio));
    let overlaps = 0;
    for (let i = 1; i < voices.length; i++) {
      const prev = voices[i - 1];
      const endsBefore = voices[i].at >= prev.at + prev.duration - 0.001;
      const cutOff = prev.stopAt !== null && prev.stopAt <= voices[i].at + 0.08;
      if (!endsBefore && !cutOff) overlaps++;
    }
    check('voices never overlap', overlaps === 0, `overlaps=${overlaps}`);
    // ボイスは 65 クリップ (元の 1 本 + 怒声 64 本) からランダムに選ばれる
    const hist = st.audio.voiceHistory;
    check('each voice is one clip of the pool (ids recorded)', hist.length === st.audio.voicePlays && hist.every((id) => /^(original|rage_\d{3})$/.test(id)), JSON.stringify(hist));
    check('the same clip never plays twice in a row', hist.every((id, i) => i === 0 || id !== hist[i - 1]), JSON.stringify(hist));
    check('clips vary (no repeats within one shuffle)', new Set(hist).size === hist.length, JSON.stringify(hist));
    const fetched = await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => /\/audio\/.*\.mp3/.test(r.name)).length);
    check('clips are fetched lazily, a few ahead (not all 65 up front)', fetched >= 1 && fetched < 25, `fetched=${fetched}`);
    await page.screenshot({ path: OUT + 'play.png' });
    check('no console errors', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* 5 ------------------------------------------------------------ toggles */
  section('音声OFF / 効果音OFF');
  {
    const { context, page, errors } = await openGame(browser, { viewport: { width: 1280, height: 800 } });
    await startGame(page);
    await waitVoiceLoaded(page);
    await page.click('[data-testid=voice-toggle]');
    check('voice toggle shows OFF', (await page.getAttribute('[data-testid=voice-toggle]', 'aria-pressed')) === 'false');
    const v0 = (await voiceLog(page)).length;
    await spawnPiece(page, 1, 150, 520);
    await spawnPiece(page, 1, 165, 520);
    await sleep(900);
    check('voice OFF: merge happens but MP3 is not played', (await gameState(page)).score === 3 && (await voiceLog(page)).length === v0);

    await page.click('[data-testid=voice-toggle]');
    await restart(page);
    await sleep(100);
    await spawnPiece(page, 1, 150, 520);
    await spawnPiece(page, 1, 165, 520);
    await sleep(900);
    check('voice ON again: MP3 plays', (await voiceLog(page)).length === v0 + 1);

    await sleep(1800);
    await page.click('[data-testid=sfx-toggle]');
    check('sfx toggle shows OFF', (await page.getAttribute('[data-testid=sfx-toggle]', 'aria-pressed')) === 'false');
    const o0 = await oscCount(page);
    await restart(page);
    await spawnPiece(page, 1, 150, 520);
    await spawnPiece(page, 1, 165, 520);
    await sleep(900);
    check('sfx OFF: no synthesized sound effects', (await oscCount(page)) === o0, `${o0} -> ${await oscCount(page)}`);
    check('sfx OFF: voice (separate setting) still plays', (await voiceLog(page)).length >= v0 + 1);

    await page.click('[data-testid=sfx-toggle]');
    const o1 = await oscCount(page);
    await restart(page);
    await spawnPiece(page, 1, 150, 520);
    await spawnPiece(page, 1, 165, 520);
    await sleep(900);
    check('sfx ON again: effects play', (await oscCount(page)) > o1);
    const stored = await page.evaluate(() => [localStorage.getItem('teruki_sound_enabled'), localStorage.getItem('teruki_sfx_enabled')]);
    check('toggle state stored', stored[0] === '1' && stored[1] === '1');
    check('no console errors', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* 6 ---------------------------------------------- final → game over → retry */
  section('最終形態 → ゲームオーバー → リスタート → ハイスコア保存');
  {
    const { context, page, errors } = await openGame(browser, { viewport: { width: 430, height: 900 }, mobile: true });
    await startGame(page);
    await waitVoiceLoaded(page);
    await sleep(500);

    await spawnPiece(page, 7, 150, 480);
    await spawnPiece(page, 7, 215, 480);
    await sleep(300);
    let st = await gameState(page);
    check('Level 7 + Level 7 creates the final form (Level 8)', st.pieces.some((p) => p.level === 8) && st.finalCount === 1, JSON.stringify(st.pieces));
    await page.screenshot({ path: OUT + 'final.png' });
    check('final form plays the provided MP3', (await voiceLog(page)).length >= 1);
    await sleep(600);
    await page.screenshot({ path: OUT + 'final-after.png' });
    st = await gameState(page);
    const scoreBeforeOver = st.score;
    check('final form gives a big score', scoreBeforeOver >= 200, `score=${scoreBeforeOver}`);

    // 危険ラインを超えて積む
    for (let i = 0; i < 6; i++) await spawnPiece(page, 8, 100 + (i % 2) * 160, 300 - i * 70);
    await page.waitForSelector('[data-testid=gameover]', { timeout: 20000 });
    check('GAME OVER appears after pieces stay over the line', true);
    await page.screenshot({ path: OUT + 'gameover.png' });
    const overText = await page.locator('[data-testid=gameover]').innerText();
    check('GAME OVER screen shows title, SCORE, BEST', overText.includes('GAME OVER') && overText.includes('SCORE') && overText.includes('BEST'));
    const shownScore = Number(await page.locator('[data-testid=final-score]').innerText());
    const shownBest = Number(await page.locator('[data-testid=final-best]').innerText());
    st = await gameState(page);
    check('final score matches the session', shownScore === st.score && shownScore >= scoreBeforeOver);
    check('first run makes the best score', shownBest === shownScore);
    check('best is saved to localStorage', (await page.evaluate(() => localStorage.getItem('teruki_best_score'))) === String(shownBest));
    check('final-form badge is shown', overText.includes('FINAL TERUKI'));

    await page.click('[data-testid=retry]');
    await page.waitForFunction(() => !document.querySelector('[data-testid=gameover]'));
    st = await gameState(page);
    check('もう一回！ restarts with an empty field', st.phase === 'playing' && st.score === 0 && st.pieces.length === 0);
    check('best is kept after restart', st.best === shownBest && (await page.locator('[data-testid=best]').innerText()) === String(shownBest));

    await page.reload();
    await page.waitForSelector('[data-testid=start]:not([disabled])');
    check('best score persists across reloads', (await page.locator('[data-testid=title-best]').innerText()) === String(shownBest));
    check('no console errors', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* 7 ------------------------------------------------------- responsiveness */
  section('レスポンシブ (Android/iPhone/iPad/タブレット/PC)');
  {
    const sizes = [
      ['small-phone', 320, 568],
      ['android', 360, 740],
      ['iphone', 390, 844],
      ['ipad', 820, 1180],
      ['android-tablet', 800, 1280],
      ['desktop', 1920, 1080],
      ['laptop', 1366, 768],
      ['phone-landscape', 844, 390],
    ];
    for (const [name, width, height] of sizes) {
      const { context, page, errors } = await openGame(browser, { viewport: { width, height }, mobile: width < 900 });
      await startGame(page);
      await sleep(300);
      const rect = await fieldRect(page);
      const inside = rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width + 0.5 && rect.y + rect.height <= height + 0.5;
      const ratio = rect.width / rect.height;
      check(`${name} ${width}x${height}: field fits (${Math.round(rect.width)}x${Math.round(rect.height)})`, inside && Math.abs(ratio - FIELD.w / FIELD.h) < 0.02);
      const controls = await page.locator('.controls').boundingBox();
      check(`${name}: controls visible and tappable`, !!controls && controls.y + controls.height <= height + 0.5 && controls.height >= 44);
      await page.screenshot({ path: `${OUT}size-${name}.png` });
      check(`${name}: no console errors`, errors.length === 0, errors.join(' | '));
      await context.close();
    }
  }

  /* 8 ------------------------------------------------------------ failures */
  section('異常系: MP3失敗 / AudioContextなし / localStorage使用不可 / リサイズ');
  {
    const { context, page, errors } = await openGame(browser, {
      routes: [['**/*.mp3', (route) => route.fulfill({ status: 404, body: 'nope' })]],
    });
    await startGame(page);
    await sleep(500);
    await spawnPiece(page, 1, 150, 520);
    await spawnPiece(page, 1, 165, 520);
    await sleep(900);
    const st = await gameState(page);
    check('MP3 404: game still runs and merges', st.score === 3 && st.audio.voiceLoaded === false && st.phase === 'playing');
    const fatal = errors.filter((e) => e.startsWith('pageerror'));
    check('MP3 404: no uncaught exceptions', fatal.length === 0, fatal.join(' | '));
    await context.close();
  }
  {
    const { context, page, errors } = await openGame(browser, {
      init: [
        () => {
          // eslint-disable-next-line no-delete-var
          delete window.AudioContext;
          delete window.webkitAudioContext;
        },
      ],
    });
    await startGame(page);
    await spawnPiece(page, 1, 150, 520);
    await spawnPiece(page, 1, 165, 520);
    await sleep(900);
    const st = await gameState(page);
    check('no AudioContext: game still runs and merges', st.score === 3 && st.phase === 'playing');
    check('no AudioContext: no errors', errors.length === 0, errors.join(' | '));
    await context.close();
  }
  {
    const { context, page, errors } = await openGame(browser, {
      init: [
        () => {
          const boom = () => {
            throw new DOMException('denied', 'SecurityError');
          };
          Object.defineProperty(window, 'localStorage', { get: boom });
        },
      ],
    });
    await startGame(page);
    await spawnPiece(page, 1, 150, 520);
    await spawnPiece(page, 1, 165, 520);
    await sleep(900);
    const st = await gameState(page);
    check('localStorage blocked: game still runs and scores', st.score === 3 && st.best === 3);
    check('localStorage blocked: no errors', errors.length === 0, errors.join(' | '));
    await context.close();
  }
  {
    const { context, page, errors } = await openGame(browser, { viewport: { width: 390, height: 844 }, mobile: true });
    await startGame(page);
    await clickField(page, 120);
    for (const [w, h] of [[844, 390], [320, 480], [1024, 768], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h });
      await sleep(150);
      await clickField(page, 200).catch(() => undefined);
    }
    const rect = await fieldRect(page);
    const st = await gameState(page);
    check('rapid resizing keeps the game alive and in bounds', st.phase === 'playing' && rect.x >= 0 && rect.x + rect.width <= 390.5);
    check('resize: no console errors', errors.length === 0, errors.join(' | '));
    await context.close();
  }
} catch (error) {
  console.error('\nE2E crashed:', error);
  exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('Failed:\n - ' + failures.join('\n - '));
  exitCode = 1;
}
process.exit(exitCode);
