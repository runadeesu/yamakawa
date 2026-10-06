import { describe, expect, it } from 'vitest';
import { VOICE_RULES, VoiceScheduler } from './voiceScheduler';

const DURATION = 1416;

function started(s: VoiceScheduler, now: number): void {
  s.commit(now, DURATION);
}

describe('VoiceScheduler', () => {
  it('plays the first merge voice', () => {
    expect(new VoiceScheduler().decide(0, 'merge')).toBe('play');
  });

  it('never overlaps normal merge voices while one is playing or cooling down', () => {
    const s = new VoiceScheduler();
    started(s, 1000);
    for (const t of [1001, 1200, 2000, 2400, 1000 + DURATION + VOICE_RULES.gapAfterEndMs - 1]) {
      expect(s.decide(t, 'merge')).toBe('skip');
    }
    expect(s.decide(1000 + DURATION + VOICE_RULES.gapAfterEndMs, 'merge')).toBe('play');
  });

  it('plays at most one voice per cooldown in a rapid combo chain', () => {
    const s = new VoiceScheduler();
    let plays = 0;
    for (let t = 0; t < 3000; t += 100) {
      if (s.decide(t, 'merge') === 'play') {
        s.commit(t, DURATION);
        plays++;
      }
    }
    expect(plays).toBe(2); // t=0 and t=1700
  });

  it('lets a big merge cut in once the minimum gap has passed', () => {
    const s = new VoiceScheduler();
    started(s, 0);
    expect(s.decide(300, 'big')).toBe('skip');
    expect(s.decide(600, 'big')).toBe('interrupt');
    expect(s.decide(DURATION + 10, 'big')).toBe('play');
  });

  it('always lets the final form through (after the duplicate guard)', () => {
    const s = new VoiceScheduler();
    started(s, 0);
    expect(s.decide(50, 'final')).toBe('skip');
    expect(s.decide(300, 'final')).toBe('interrupt');
  });

  it('reset clears the cooldown', () => {
    const s = new VoiceScheduler();
    started(s, 0);
    s.reset();
    expect(s.decide(10, 'merge')).toBe('play');
  });
});
