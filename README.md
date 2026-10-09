# やまかわてるきゲーム

**同じてるきを合体させろ！** — 「スイカゲーム」風の物理合体パズル。
React + TypeScript + Vite + Matter.js + Web Audio API。スマホ縦画面優先 / PC・タブレット対応。

**オンライン対戦つき**: 表示名 + パスワードだけ (メール不要) で登録 → フレンド・チャット・クイックマッチ / 招待対戦。
サーバーは Supabase (Auth / PostgreSQL / Realtime / Edge Function)。詳細・セットアップは **[docs/ONLINE.md](docs/ONLINE.md)**。

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

## オンライン (アカウント・フレンド・チャット・対戦)

タイトル画面の **「オンライン対戦」** から入ります。ひとりで遊ぶモードはそのまま遊べ、オンラインの設定がなくても (通信できなくても) ゲームは落ちません。

- アカウント: 表示名 + パスワードのみ。**パスワードのリセットはありません** (メールを持たないため。初期バージョンの仕様)
- 対戦: 2 分間のリアルタイムスコアバトル (同じ順番でてるきが落ちてくる)。結果と戦績は**サーバーが検証して確定**
- 設定: `.env.example` を `.env.local` にコピーして `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` を入れる (公開してよい値のみ。秘密鍵は入れない)
- データベース: `supabase/migrations/` を順に適用、Edge Function は `supabase functions deploy account --no-verify-jwt`

→ 仕組み・DB 構築手順・セキュリティ・テスト結果・制限事項は [docs/ONLINE.md](docs/ONLINE.md)

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
  online/          オンライン: API・ログイン状態・マッチング・対戦の進行 (versus/)
  components/online/  ログイン・ロビー・フレンド・チャット・プロフィール・設定
supabase/
  migrations/      DB スキーマ・RLS・RPC・Realtime 権限 (順番に適用)
  functions/account/  サインアップ / ログインの Edge Function
  tests/           DB 結合テスト (PGlite)
e2e/play.mjs       実ブラウザ(Chromium)での一人用の通しテスト
e2e/online.mjs     実ブラウザ 2 台 × 実 Supabase のオンライン E2E
e2e/realtime.mjs   Node 3 クライアント × 実 Supabase の Realtime 検証
docs/ONLINE.md     オンライン機能の設計・手順・テスト記録
```

## テスト

```bash
npm test                      # 物理・合体・スコア・ボイス + オンライン (DB 結合・Edge Function・対戦ログ) 95 件 (vitest)
npm run build && npm run e2e  # START → 落下 → 合体 → MP3 → 最終形態 → GAME OVER → リスタート ほか (89 項目)
npm run e2e:online            # オンライン E2E (実 Supabase にテスト用 zz_e2e_* アカウントを作る。82 項目)
npm run e2e:realtime          # Realtime (WebSocket) 検証。プロキシ越しの環境では NODE_USE_ENV_PROXY=1 を付ける
```

E2E は `?debug` を付けたときだけ公開される `window.__TERUKI__` で状態を読み取り、入力は実際のマウス・タッチ・キーボードで行います。
