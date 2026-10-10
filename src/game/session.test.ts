import { describe, expect, it } from 'vitest';
import { DANGER_Y, FIELD_H, FIELD_W, MAX_LEVEL, PHYSICS, TIMING } from './config';
import { levelDef } from './levels';
import { mulberry32 } from './rng';
import { GameSession, comboMultiplier, type SessionEvent } from './session';

const STEP = PHYSICS.stepMs;

function setup(best = 0) {
  const session = new GameSession(mulberry32(1), best);
  const events: SessionEvent[] = [];
  session.on((e) => events.push(e));
  return { session, events };
}

function run(session: GameSession, ms: number): void {
  for (let t = 0; t < ms; t += STEP) session.step(STEP);
}

const merges = (events: SessionEvent[]) => events.filter((e) => e.type === 'merge');

describe('merge', () => {
  it('merges two same-level pieces into exactly one piece of level+1', () => {
    const { session, events } = setup();
    session.world.spawn(1, 150, 520);
    session.world.spawn(1, 160, 520);
    run(session, 1000);
    expect(session.world.pieces.size).toBe(1);
    const [piece] = [...session.world.pieces.values()];
    expect(piece?.level).toBe(2);
    expect(merges(events)).toHaveLength(1);
    expect(session.score).toBe(levelDef(2).score);
  });

  it('does not merge different levels', () => {
    const { session, events } = setup();
    session.world.spawn(1, 150, 540);
    session.world.spawn(2, 190, 540);
    run(session, 1500);
    expect(session.world.pieces.size).toBe(2);
    expect(merges(events)).toHaveLength(0);
  });

  it('never double-merges when one piece touches two partners', () => {
    const { session, events } = setup();
    session.world.spawn(1, 150, 540);
    session.world.spawn(1, 175, 540);
    session.world.spawn(1, 200, 540);
    run(session, 3000);
    // 3 pieces -> exactly one merge (2 consumed), one level-1 left over
    expect(merges(events)).toHaveLength(1);
    const levels = [...session.world.pieces.values()].map((p) => p.level).sort();
    expect(levels).toEqual([1, 2]);
  });

  it('chains merges and reports combo', () => {
    const { session, events } = setup();
    // 1+1 -> 2, which lands on top of an existing 2 -> 3
    session.world.spawn(2, 180, 540);
    session.world.spawn(1, 170, 500);
    session.world.spawn(1, 190, 500);
    run(session, 3000);
    const m = merges(events);
    expect(m.length).toBeGreaterThanOrEqual(2);
    const levels = [...session.world.pieces.values()].map((p) => p.level);
    expect(levels).toContain(3);
    const combos = m.map((e) => (e.type === 'merge' ? e.combo : 0));
    expect(Math.max(...combos)).toBeGreaterThanOrEqual(2);
  });

  it('keeps the merged piece inside the field with a sane speed', () => {
    const { session } = setup();
    // merge right next to the left wall and floor
    session.world.spawn(5, 44, FIELD_H - 44);
    session.world.spawn(5, 50, FIELD_H - 60);
    for (let i = 0; i < 200; i++) {
      session.step(STEP);
      for (const p of session.world.pieces.values()) {
        const r = levelDef(p.level).radius;
        expect(p.body.position.x).toBeGreaterThanOrEqual(r - 3);
        expect(p.body.position.y).toBeLessThanOrEqual(FIELD_H - r + 3);
        expect(Math.hypot(p.body.velocity.x, p.body.velocity.y)).toBeLessThanOrEqual(PHYSICS.maxSpeed + 1e-6);
      }
    }
  });

  it('creates the final form and flags it', () => {
    const { session, events } = setup();
    session.world.spawn(7, 150, 500);
    session.world.spawn(7, 215, 500);
    run(session, 1500);
    const final = events.find((e) => e.type === 'merge' && e.final);
    expect(final).toBeDefined();
    expect(session.finalCount).toBe(1);
    expect(session.score).toBe(levelDef(MAX_LEVEL).score);
    expect([...session.world.pieces.values()].some((p) => p.level === MAX_LEVEL)).toBe(true);
  });

  it('does not merge two final forms', () => {
    const { session, events } = setup();
    session.world.spawn(MAX_LEVEL, 100, 500);
    session.world.spawn(MAX_LEVEL, 260, 500);
    run(session, 2000);
    expect(session.world.pieces.size).toBe(2);
    expect(merges(events)).toHaveLength(0);
  });
});

describe('drop & score', () => {
  it('drops once, then respects the cooldown', () => {
    const { session, events } = setup();
    expect(session.drop()).toBe(true);
    expect(session.drop()).toBe(false);
    run(session, TIMING.dropCooldownMs + STEP * 2);
    expect(session.drop()).toBe(true);
    expect(events.filter((e) => e.type === 'drop')).toHaveLength(2);
    expect(session.score).toBe(2);
  });

  it('clamps the drop position inside the walls', () => {
    const { session } = setup();
    session.setAim(-500);
    session.drop();
    const piece = [...session.world.pieces.values()][0];
    expect(piece?.body.position.x).toBeGreaterThanOrEqual(levelDef(piece?.level ?? 1).radius);
    session.setAim(5000);
    expect(session.aimX).toBeLessThanOrEqual(FIELD_W);
  });

  it('applies the combo multiplier', () => {
    expect(comboMultiplier(1)).toBe(1);
    expect(comboMultiplier(2)).toBe(1.5);
    expect(comboMultiplier(3)).toBe(2);
    expect(comboMultiplier(99)).toBe(3);
  });

  it('restart clears everything but keeps best', () => {
    const { session } = setup();
    session.world.spawn(1, 150, 520);
    session.world.spawn(1, 160, 520);
    run(session, 1000);
    const best = session.best;
    expect(best).toBeGreaterThan(0);
    session.restart();
    expect(session.score).toBe(0);
    expect(session.world.pieces.size).toBe(0);
    expect(session.phase).toBe('playing');
    expect(session.best).toBe(best);
  });
});

describe('game over', () => {
  it('does not end the game on a brief touch of the danger line', () => {
    const { session, events } = setup();
    session.world.spawn(3, 180, DANGER_Y + 10); // just born: inside the grace period
    run(session, TIMING.spawnGraceMs - 200);
    expect(events.some((e) => e.type === 'gameover')).toBe(false);
    expect(session.phase).toBe('playing');
  });

  it('ends the game when pieces stay above the danger line, and stops stepping', () => {
    const { session, events } = setup(5);
    // wall of big pieces that cannot all fit below the line
    for (let i = 0; i < 6; i++) session.world.spawn(8, 100 + (i % 2) * 150, 500 - i * 90);
    run(session, 30000);
    const over = events.find((e) => e.type === 'gameover');
    expect(over).toBeDefined();
    expect(session.phase).toBe('over');
    const before = [...session.world.pieces.values()].map((p) => p.body.position.y);
    run(session, 500);
    const after = [...session.world.pieces.values()].map((p) => p.body.position.y);
    expect(after).toEqual(before);
  });

  it('flags a new best only when the previous best is beaten', () => {
    const { session, events } = setup(1);
    session.world.spawn(7, 150, 500);
    session.world.spawn(7, 215, 500);
    run(session, 1500);
    for (let i = 0; i < 6; i++) session.world.spawn(8, 100 + (i % 2) * 150, 300 - i * 80);
    run(session, 30000);
    const over = events.find((e) => e.type === 'gameover');
    expect(over && over.type === 'gameover' && over.newBest).toBe(true);
  });
});

describe('soak', () => {
  it('survives long random play without NaN, escapes or runaway speeds', () => {
    const rng = mulberry32(42);
    const session = new GameSession(rng, 0);
    let over = false;
    session.on((e) => {
      if (e.type === 'gameover') over = true;
    });
    for (let i = 0; i < 400 && !over; i++) {
      session.setAim(rng() * FIELD_W);
      session.drop();
      run(session, 520);
      for (const p of session.world.pieces.values()) {
        expect(Number.isFinite(p.body.position.x)).toBe(true);
        expect(Number.isFinite(p.body.position.y)).toBe(true);
        expect(p.body.position.y).toBeLessThan(FIELD_H + 5);
        expect(p.body.position.x).toBeGreaterThan(-5);
        expect(p.body.position.x).toBeLessThan(FIELD_W + 5);
      }
    }
    expect(session.score).toBeGreaterThan(0);
  });
});
