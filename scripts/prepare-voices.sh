#!/usr/bin/env bash
# ボイス素材 (ユーザー提供の MP3 クリップ集) をゲーム用に整える。
#
#   scripts/prepare-voices.sh <入力ディレクトリ> <出力ディレクトリ>
#   例: scripts/prepare-voices.sh ./yamakawa_teruki_rage_sfx public/audio/voices
#
# やること (内容の編集・加工はしません。音量とフォーマットを揃えるだけ):
#   1. モノラルに変換 (素材は実質モノ。容量が半分になる。モノ化は最初に行う)
#   2. 音量を揃える: 統合ラウドネス TARGET_LUFS に合わせる。ただしピークが天井を超えないよう
#      リミッターで抑える (持ち上げすぎて歪まないよう、リミッターのかかり具合は MAX_LIMIT_DB まで)
#   3. 端のフェード (先頭 5ms / 末尾 40ms) を足して、切れ目の「ぷつっ」を防ぐ。
#      末尾は「反転 → フェードイン → 反転」で行う (MP3 の長さにはエンコーダの余白が含まれ、
#      長さから逆算するとフェードが実際の音の終わりより後ろにずれてしまうため)
#   4. 96kbps の MP3 で書き出す
# 既存のボイス (yamakawateruki-ndedayotuboooom.mp3) は約 -5.9 LUFS。素材はもともと -14〜-21 LUFS と小さいので、
# そのまま鳴らすと小さすぎる。そのためここで揃える。
#
# 必要: ffmpeg (libmp3lame)
set -euo pipefail

# モノ化は必ずフィルタの先頭で行う (出力オプション -ac 1 だと、リミッターの「後」に左右が加算されて
# ピークが最大 +3dB 持ち上がり、音量の測定もずれる)。平均なので左右同じ音のレベルは変わらない。
MONO='pan=mono|c0=0.5*c0+0.5*c1'

IN_DIR=${1:?入力ディレクトリを指定してください}
OUT_DIR=${2:?出力ディレクトリを指定してください}
TARGET_LUFS=${TARGET_LUFS:--9.0}      # 目標の音量 (統合ラウドネス)
CEILING_DB=${CEILING_DB:--1.5}        # 許容するピーク (dBFS)
MAX_LIMIT_DB=${MAX_LIMIT_DB:-6.5}     # リミッターで削ってよい量 (dB)

mkdir -p "$OUT_DIR"
shopt -s nullglob
count=0
for f in "$IN_DIR"/rage_*.mp3; do
  name=$(basename "$f")
  num=${name:5:3}
  # 測定 (モノに落とした状態で)
  loud=$(ffmpeg -hide_banner -nostats -i "$f" -af "$MONO,ebur128" -f null - 2>&1 | awk '/Integrated loudness/{f=1} f&&/I:/{print $2; exit}')
  peak=$(ffmpeg -hide_banner -nostats -i "$f" -af "$MONO,volumedetect" -f null - 2>&1 | awk '/max_volume/{print $5; exit}')
  gain=$(awk -v t="$TARGET_LUFS" -v i="$loud" -v c="$CEILING_DB" -v p="$peak" -v m="$MAX_LIMIT_DB" \
    'BEGIN{g=t-i; lim=c-p+m; if(g>lim)g=lim; printf "%.2f", g}')
  limit=$(awk -v c="$CEILING_DB" 'BEGIN{printf "%.4f", 10^(c/20)}')
  ffmpeg -hide_banner -loglevel error -y -i "$f" -ac 1 -ar 44100 \
    -af "${MONO},volume=${gain}dB,alimiter=limit=${limit}:attack=3:release=40:level=0,afade=t=in:d=0.005,areverse,afade=t=in:d=0.04,areverse" \
    -c:a libmp3lame -b:a 96k "$OUT_DIR/rage_${num}.mp3"
  printf '%s  %s LUFS, peak %s dB -> gain %+.1f dB\n' "rage_${num}" "$loud" "$peak" "$gain"
  count=$((count + 1))
done
echo "done: $count clips -> $OUT_DIR"
