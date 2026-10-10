/** Web Audio API で合成する効果音。叫び声は含まない (ボイスはユーザー提供MP3のみ) */
export class Sfx {
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;
  private readonly noise: AudioBuffer;

  constructor(ctx: AudioContext, out: AudioNode) {
    this.ctx = ctx;
    this.out = out;
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }

  private tone(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; to?: number; delay?: number } = {}): void {
    const { ctx } = this;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t0 + dur);
    const peak = opts.gain ?? 0.2;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(this.out);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private thud(dur: number, gainValue: number, cutoff: number): void {
    const { ctx } = this;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainValue, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(gain).connect(this.out);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  drop(): void {
    this.tone(520, 0.09, { to: 300, gain: 0.18 });
  }

  hit(impact: number, level: number): void {
    const power = Math.min(1, impact / 12);
    this.thud(0.07, 0.05 + power * 0.18, 500 + (8 - level) * 90);
    this.tone(150 + (8 - level) * 24, 0.08, { gain: 0.04 + power * 0.1, to: 90 });
  }

  merge(level: number, combo: number): void {
    const semitones = (level - 2) * 2 + Math.min(combo - 1, 6) * 2;
    const f = 330 * Math.pow(2, semitones / 12);
    this.tone(f, 0.16, { to: f * 1.5, gain: 0.2, type: 'triangle' });
    this.tone(f * 1.5, 0.2, { gain: 0.12, delay: 0.05 });
    if (level >= 5) this.tone(f * 2, 0.24, { gain: 0.1, delay: 0.1, type: 'triangle' });
  }

  final(): void {
    [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568].forEach((f, i) => {
      this.tone(f, 0.3, { type: 'triangle', gain: 0.16, delay: i * 0.08 });
      this.tone(f / 2, 0.3, { type: 'square', gain: 0.04, delay: i * 0.08 });
    });
    this.thud(0.5, 0.2, 2500);
  }

  button(): void {
    this.tone(880, 0.05, { type: 'square', gain: 0.07, to: 1180 });
  }

  gameOver(): void {
    [440, 370, 311, 220].forEach((f, i) => this.tone(f, 0.28, { type: 'sawtooth', gain: 0.1, delay: i * 0.2, to: f * 0.92 }));
    this.thud(0.45, 0.14, 400);
  }
}
