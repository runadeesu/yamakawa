# やまかわてるきゲーム

**同じてるきを合体させろ！** — 「スイカゲーム」風の物理合体パズル。
React + TypeScript + Vite + Matter.js + Web Audio API。スマホ縦画面優先 / PC・タブレット対応。

## 遊ぶ

```bash
npm install
npm run dev        # 開発サーバ
npm run build      # 型チェック + 本番ビルド (dist/)
npm run preview    # ビルド結果を確認
```

| | 位置決め | 落とす |
|---|---|---|
| PC | マウスを動かす / ← → | クリック / Space |
| スマホ・タブレット | 指をスライド | 指を離す(タップ) |

- 同じレベルのてるきがぶつかると合体して1段階大きくなる (Level 1 → 8 = FINAL TERUKI)
- 短時間に続けて合体するとコンボ (スコア倍率 + 演出)
- 赤い線の上に約2秒居座るとゲームオーバー (落下直後の猶予あり)
- 🔊 音声 / 🔔 効果音 は別々に ON/OFF でき、`localStorage` に保存される

## 音声について

- 叫び声・ボイスは **ユーザー提供の MP3 だけ** (`public/audio/yamakawateruki-ndedayotuboooom.mp3`)。新しいセリフ・TTS・加工は一切ありません。
- 合体で再生。ただしボイスは常に最大1本で、重ならないようクールダウンを設けています (`src/audio/voiceScheduler.ts`)。
  - 通常合体: 前のボイスが終わって 250ms 後まで再生しない
  - 大型合体 (Level 6+): 500ms 経っていれば再生中でも切り替えて再生
  - 最終形態: ほぼ常に再生
- drop / collision / merge / button / gameover などの効果音は Web Audio で合成 (`src/audio/sfx.ts`)。
- MP3 の読み込み失敗・AudioContext なし・localStorage 不可でもゲーム本体は動きます。

## 構成

```
src/
  game/
    config.ts      定数 (フィールド・物理・タイミング・スコア)
    levels.ts      8段階のてるき定義 (半径・色・スコア)
    world.ts       Matter.js ワールド: 物理・衝突検出・合体 (mergingIds で二重合体を防止)
    session.ts     ゲームルール: 落下・スコア・コンボ・危険ライン・ゲームオーバー (DOM 非依存)
    sprites.ts     顔写真 + リング + 王冠などの装飾を Canvas で合成
    effects.ts     パーティクル・ポップアップ・バナー・フラッシュ・シェイク
    renderer.ts    Canvas 描画 (固定ステップ間の補間つき)
    input.ts       マウス / タッチ / キーボード
    Game.ts        固定ステップの rAF ループ。React state には依存しない
  audio/           AudioManager (MP3 ボイス) / Sfx (合成音) / VoiceScheduler
  components/      タイトル・HUD・コントロール・ゲームオーバー・遊び方
  assets/faces/    てるきの顔画像 (提供画像から切り出し)
e2e/play.mjs       実ブラウザ(Chromium)での通しテスト
```

## テスト

```bash
npm test                      # 物理・合体・スコア・ゲームオーバー・ボイスのクールダウン (vitest)
npm run build && npm run e2e  # START → 落下 → 合体 → MP3 → 最終形態 → GAME OVER → リスタート ほか
```

E2E は `?debug` を付けたときだけ公開される `window.__TERUKI__` で状態を読み取り、入力は実際のマウス・タッチ・キーボードで行います。
