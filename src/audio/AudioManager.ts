import { Sfx } from './sfx';
import { VOICE_CLIPS, type VoiceClip } from './voiceClips';
import { VoicePool } from './voicePool';
import { VoiceScheduler, type VoiceKind } from './voiceScheduler';

type ContextCtor = typeof AudioContext;

/** 次に鳴らす候補のうち、先読み (取得 + デコード) しておく本数。メモリを抑えるため全部は持たない */
const AHEAD = 3;
const HISTORY_MAX = 200;

export interface AudioStats {
  voicePlays: number;
  voiceSkipped: number;
  /** 1 本以上デコードできた */
  voiceLoaded: boolean;
  /** 直近にデコードしたクリップの長さ */
  voiceDurationMs: number;
  /** 鳴らしたクリップの id (時系列。ランダム性の確認用) */
  voiceHistory: string[];
}

/**
 * 音声の窓口。
 * - ボイス: ユーザー提供MP3だけを再生 (合成音声・新規セリフは一切使わない)。
 *   65 クリップ (元の 1 本 + 怒声 64 本) をシャッフルバッグでランダムに選ぶ。
 *   必要になる少し前に取得・デコードし、鳴らし終えたものは捨てる (全部をメモリに置かない)
 * - SFX: Web Audio で合成
 * どの処理が失敗してもゲーム本体は動き続ける (すべて握りつぶして no-op に落ちる)。
 */
export class AudioManager {
  voiceEnabled = true;
  sfxEnabled = true;
  readonly stats: AudioStats = { voicePlays: 0, voiceSkipped: 0, voiceLoaded: false, voiceDurationMs: 0, voiceHistory: [] };

  private ctx: AudioContext | null = null;
  private sfx: Sfx | null = null;
  private sfxGain: GainNode | null = null;
  private voiceGain: GainNode | null = null;
  private voiceSource: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
  private readonly scheduler = new VoiceScheduler();
  private readonly clips: Map<string, VoiceClip>;
  private readonly pool: VoicePool;
  /** 取得済みでまだデコードしていないバイト列 (AudioContext が無い間はここに置く) */
  private readonly bytes = new Map<string, ArrayBuffer>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly loading = new Set<string>();
  private readonly decoding = new Set<string>();

  constructor(clips: readonly VoiceClip[] = VOICE_CLIPS, rng: () => number = Math.random) {
    this.clips = new Map(clips.map((clip) => [clip.id, clip]));
    this.pool = new VoicePool(
      clips.map((clip) => clip.id),
      rng,
    );
  }

  /** 次に鳴らす数本を先読みする (AudioContext は不要なのでユーザー操作前でもOK。デコードは unlock 後) */
  async preload(): Promise<void> {
    await this.pump();
  }

  /** ユーザー操作の中で呼ぶ。AudioContext の生成・再開と、取得済みクリップのデコードを行う */
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
      void this.settle();
    } catch (error) {
      console.warn('AudioContext unavailable; continuing silently', error);
      this.ctx = null;
    }
  }

  /** 取得済みをデコードし、足りない分を取りに行く */
  private async settle(): Promise<void> {
    await Promise.all([...this.bytes.keys()].map((id) => this.decode(id)));
    await this.pump();
  }

  /** 次に鳴らす候補の先頭 AHEAD 本が、取得・デコード済みになるようにする */
  private async pump(): Promise<void> {
    const wanted = this.pool.peek(AHEAD).filter((id) => !this.buffers.has(id) && !this.loading.has(id));
    await Promise.all(wanted.map((id) => this.load(id)));
  }

  private async load(id: string): Promise<void> {
    const clip = this.clips.get(id);
    if (!clip) return;
    this.loading.add(id);
    try {
      if (!this.bytes.has(id)) {
        const res = await fetch(clip.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.bytes.set(id, await res.arrayBuffer());
      }
      await this.decode(id);
    } catch (error) {
      this.giveUp(id, error);
    } finally {
      this.loading.delete(id);
    }
  }

  private async decode(id: string): Promise<void> {
    const ctx = this.ctx;
    const bytes = this.bytes.get(id);
    if (!ctx || !bytes || this.buffers.has(id) || this.decoding.has(id)) return;
    this.decoding.add(id);
    try {
      const buffer = await ctx.decodeAudioData(bytes.slice(0));
      this.buffers.set(id, buffer);
      this.bytes.delete(id);
      this.stats.voiceLoaded = true;
      this.stats.voiceDurationMs = Math.round(buffer.duration * 1000);
    } catch (error) {
      this.giveUp(id, error);
    } finally {
      this.decoding.delete(id);
    }
  }

  /** 読み込み・デコードできないクリップは、このセッションでは使わない (残りで続ける) */
  private giveUp(id: string, error: unknown): void {
    console.warn(`voice clip ${id} could not be loaded; skipping it`, error);
    this.bytes.delete(id);
    this.pool.remove(id);
    void this.pump();
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

  /**
   * ユーザー提供のボイスをランダムに 1 本再生する。クールダウン・重なり防止は VoiceScheduler が判断。
   * 次の候補がまだ読み込めていないときは鳴らさない (ゲームを待たせない)
   */
  playVoice(kind: VoiceKind): boolean {
    const ctx = this.ctx;
    if (!this.voiceEnabled || !ctx || !this.voiceGain || ctx.state !== 'running') return false;
    const id = this.pool.peek(AHEAD).find((candidate) => this.buffers.has(candidate));
    const buffer = id ? this.buffers.get(id) : undefined;
    if (!id || !buffer) {
      void this.pump();
      return false;
    }
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
      this.stats.voiceHistory.push(id);
      if (this.stats.voiceHistory.length > HISTORY_MAX) this.stats.voiceHistory.shift();
      // 使ったクリップはバッグから外してメモリからも捨て、次の候補を先読みする
      this.pool.take(id);
      this.buffers.delete(id);
      void this.pump();
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
