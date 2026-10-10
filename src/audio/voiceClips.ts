/**
 * ボイスのクリップ一覧。すべてユーザー提供の音声 (合成音声・新規セリフは使わない)。
 *   - original: 最初から入っていた「んでだよっぼおおん」(1.4 秒)
 *   - rage_001〜064: 追加された怒声・叫び声のクリップ集 (scripts/prepare-voices.sh で音量とフォーマットを揃えたもの)
 */
export interface VoiceClip {
  id: string;
  url: string;
}

const BASE = import.meta.env.BASE_URL;

export const ORIGINAL_CLIP: VoiceClip = { id: 'original', url: `${BASE}audio/yamakawateruki-ndedayotuboooom.mp3` };

export const RAGE_CLIP_COUNT = 64;

export const RAGE_CLIPS: readonly VoiceClip[] = Array.from({ length: RAGE_CLIP_COUNT }, (_, i) => {
  const id = `rage_${String(i + 1).padStart(3, '0')}`;
  return { id, url: `${BASE}audio/voices/${id}.mp3` };
});

/** 鳴らす候補の全クリップ (65 個) */
export const VOICE_CLIPS: readonly VoiceClip[] = [ORIGINAL_CLIP, ...RAGE_CLIPS];
