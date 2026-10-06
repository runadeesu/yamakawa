import { Sfx } from './sfx';
import { VoiceScheduler, type VoiceKind } from './voiceScheduler';

export const VOICE_URL = `${import.meta.env.BASE_URL}audio/yamakawateruki-ndedayotuboooom.mp3`;

type ContextCtor = typeof AudioContext;

export interface AudioStats {
  voicePlays: number;
  voiceSkipped: number;
  voiceLoaded: boolean;
  voiceDurationMs: number;
}

/**
 * 音声の窓口。
 * - ボイス: ユーザー提供MP3だけを再生 (合成音声・新規セリフは一切使わない)
 * - SFX: Web Audio で合成
 * どの処理が失敗してもゲーム本体は動き続ける (すべて握りつぶして no-op に落ちる)。
 */
export class AudioManager {
  voiceEnabled = true;
  sfxEnabled = true;
  readonly stats: AudioStats = { voicePlays: 0, voiceSkipped: 0, voiceLoaded: false, voiceDurationMs: 0 };

  private ctx: AudioContext | null = null;
  private sfx: Sfx | null = null;
  private sfxGain: GainNode | null = null;
  private voiceGain: GainNode | null = null;
  private voiceBytes: ArrayBuffer | null = null;
  private voiceBuffer: AudioBuffer | null = null;
  private voiceSource: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
  private decoding = false;
  private readonly scheduler = new VoiceScheduler();
  private readonly voiceUrl: string;

  constructor(voiceUrl: string = VOICE_URL) {
    this.voiceUrl = voiceUrl;
  }

  /** MP3 のバイト列を先読みする (AudioContext は不要なのでユーザー操作前でもOK) */
  async preload(): Promise<void> {
    if (this.voiceBytes || this.voiceBuffer) return;
    try {
      const res = await fetch(this.voiceUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.voiceBytes = await res.arrayBuffer();
      void this.decodeVoice();
    } catch (error) {
      console.warn('voice mp3 could not be loaded; continuing without voice', error);
    }
  }

  /** ユーザー操作の中で呼ぶ。AudioContext の生成・再開と MP3 のデコードを行う */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctor: ContextCtor | undefined =
          window.AudioContext ?? (window as unknown as { webkitAudioContext?: ContextCtor }).webkitAudioContext;
        if (!Ctor) return;
        const ctx = new Ctor();
        this.ctx = ctx;
        this.sfxGain = ctx.createGain();
        this.sfxGain.gain.value = 0.7;
        this.sfxGain.connect(ctx.destination);
        this.voiceGain = ctx.createGain();
        this.voiceGain.gain.value = 1;
        this.voiceGain.connect(ctx.destination);
        this.sfx = new Sfx(ctx, this.sfxGain);
        ctx.addEventListener('statechange', () => {
          if (ctx.state === 'interrupted') void ctx.resume().catch(() => undefined);
        });
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
      void this.decodeVoice();
    } catch (error) {
      console.warn('AudioContext unavailable; continuing silently', error);
      this.ctx = null;
    }
  }

  private async decodeVoice(): Promise<void> {
    if (!this.ctx || !this.voiceBytes || this.voiceBuffer || this.decoding) return;
    this.decoding = true;
    try {
      this.voiceBuffer = await this.ctx.decodeAudioData(this.voiceBytes.slice(0));
      this.stats.voiceLoaded = true;
      this.stats.voiceDurationMs = Math.round(this.voiceBuffer.duration * 1000);
    } catch (error) {
      console.warn('voice mp3 could not be decoded; continuing without voice', error);
    } finally {
      this.decoding = false;
    }
  }

  /** ページが隠れたら止め、戻ったら再開する */
  setPageVisible(visible: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (visible) void ctx.resume().catch(() => undefined);
    else void ctx.suspend().catch(() => undefined);
  }

  setVoiceEnabled(enabled: boolean): void {
    this.voiceEnabled = enabled;
    if (!enabled) this.stopVoice();
  }

  setSfxEnabled(enabled: boolean): void {
    this.sfxEnabled = enabled;
  }

  /** ユーザー提供MP3を再生する。クールダウン・重なり防止は VoiceScheduler が判断 */
  playVoice(kind: VoiceKind): boolean {
    const ctx = this.ctx;
    const buffer = this.voiceBuffer;
    if (!this.voiceEnabled || !ctx || !buffer || !this.voiceGain || ctx.state !== 'running') return false;
    try {
      const now = performance.now();
      const verdict = this.scheduler.decide(now, kind);
      if (verdict === 'skip') {
        this.stats.voiceSkipped++;
        return false;
      }
      if (verdict === 'interrupt') this.stopVoice();

      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      source.buffer = buffer;
      source.connect(gain).connect(this.voiceGain);
      const entry = { source, gain };
      source.onended = () => {
        if (this.voiceSource === entry) this.voiceSource = null;
      };
      source.start();
      this.voiceSource = entry;
      this.scheduler.commit(now, buffer.duration * 1000);
      this.stats.voicePlays++;
      return true;
    } catch (error) {
      console.warn('voice playback failed', error);
      return false;
    }
  }

  private stopVoice(): void {
    const current = this.voiceSource;
    const ctx = this.ctx;
    if (!current || !ctx) return;
    this.voiceSource = null;
    try {
      const t = ctx.currentTime;
      current.gain.gain.cancelScheduledValues(t);
      current.gain.gain.setTargetAtTime(0, t, 0.012);
      current.source.stop(t + 0.06);
    } catch {
      /* すでに停止済み */
    }
    this.scheduler.reset();
  }

  private play(fn: (sfx: Sfx) => void): void {
    if (!this.sfxEnabled || !this.sfx || this.ctx?.state !== 'running') return;
    try {
      fn(this.sfx);
    } catch (error) {
      console.warn('sfx failed', error);
    }
  }

  drop(): void {
    this.play((s) => s.drop());
  }

  hit(impact: number, level: number): void {
    this.play((s) => s.hit(impact, level));
  }

  merge(level: number, combo: number): void {
    this.play((s) => s.merge(level, combo));
  }

  final(): void {
    this.play((s) => s.final());
  }

  button(): void {
    this.play((s) => s.button());
  }

  gameOver(): void {
    this.play((s) => s.gameOver());
  }
}
