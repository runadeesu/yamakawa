import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { PHYSICS } from '../../src/game/config';
import { mulberry32 } from '../../src/game/rng';
import { GameSession } from '../../src/game/session';
import { createDb, makePlayer, online } from './helpers';
import type { LogEvent } from './logTools';

type Strategy = 'random' | 'same-column' | 'aligned';

/** 本物の GameSession (Matter.js 物理) で遊び、クライアントが送るのと同じ形式のログを記録する */
function play(seq: number[], seed: number, strategy: Strategy, maxSteps: number) {
  const session = new GameSession(mulberry32(seed), 0, seq);
  const log: LogEvent[] = [];
  session.on((e) => {
    if (e.type === 'drop') log.push([session.stepCount, 0, e.level]);
    else if (e.type === 'merge') log.push([session.stepCount, 1, e.level]);
    else if (e.type === 'gameover') log.push([session.stepCount, 2, 0]);
  });
  const rng = mulberry32(seed + 1);
  let merges = 0;
  session.on((e) => {
    if (e.type === 'merge') merges++;
  });
  while (session.phase === 'playing' && session.stepCount < maxSteps) {
    if (session.canDrop()) {
      if (strategy === 'random') session.setAim(20 + rng() * 320);
      else if (strategy === 'same-column') session.setAim(180);
      else {
        const same = [...session.world.pieces.values()]
          .filter((p) => p.level === session.currentLevel)
          .sort((a, b) => a.body.position.y - b.body.position.y)[0];
        session.setAim(same ? same.body.position.x : 30 + rng() * 300);
      }
      session.drop();
    }
    session.step(PHYSICS.stepMs);
  }
  return { session, log, merges };
}

describe('client rules and server validation agree (golden)', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createDb();
  });

  const cases: Array<[Strategy, number, number]> = [
    ['random', 11, 3600],
    ['aligned', 12, 3600],
    ['aligned', 13, 7000],
    ['same-column', 14, 6000],
  ];

  for (const [strategy, seed, maxSteps] of cases) {
    it(`server score == client score (${strategy}, seed ${seed})`, async () => {
      const a = await makePlayer(db, `ga${seed}`);
      const b = await makePlayer(db, `gb${seed}`);
      await online(a, b);
      await a.rpc('queue_join');
      const q = await b.rpc('queue_join');
      await a.rpc('match_ready', q.match_id);
      const st = await b.rpc('match_ready', q.match_id);

      const { session, log, merges } = play(st.seq, seed, strategy, maxSteps);
      expect(merges).toBeGreaterThan(5);
      await db.query(
        `update public.matches set starts_at = starts_at - interval '125 seconds', ends_at = ends_at - interval '125 seconds' where id = $1`,
        [q.match_id],
      );
      await db.query(`update public.match_players set last_progress_at = now() where match_id = $1`, [q.match_id]);

      const reason = session.phase === 'over' ? 'over' : 'time';
      const res = await a.rpc('match_finish', q.match_id, log, reason);
      expect(res.error, JSON.stringify(res)).toBeUndefined();
      const mine = res.players.find((p: any) => p.id === a.id);
      expect(mine.final_score).toBe(session.score);
      expect(mine.eliminated).toBe(reason === 'over');
      console.log(`  ${strategy}/${seed}: ${reason}, steps=${session.stepCount}, drops=${log.filter((e) => e[1] === 0).length}, merges=${merges}, score=${session.score}`);
    }, 120000);
  }

  it('a log with one fabricated merge is rejected or changes the score', async () => {
    const a = await makePlayer(db, 'golden_cheat_a');
    const b = await makePlayer(db, 'golden_cheat_b');
    await online(a, b);
    await a.rpc('queue_join');
    const q = await b.rpc('queue_join');
    await a.rpc('match_ready', q.match_id);
    const st = await b.rpc('match_ready', q.match_id);
    const { session, log } = play(st.seq, 21, 'random', 1800);
    await db.query(`update public.matches set starts_at = starts_at - interval '125 seconds', ends_at = ends_at - interval '125 seconds' where id = $1`, [q.match_id]);
    await db.query(`update public.match_players set last_progress_at = now() where match_id = $1`, [q.match_id]);
    // 末尾に「存在しない 7→8 合体」を足す
    const forged = [...log, [session.stepCount + 5, 1, 8]];
    const res = await a.rpc('match_finish', q.match_id, forged, 'time');
    expect(res.error).toBe('invalid_log');
    expect(res.detail).toBe('impossible_merge');
  }, 60000);
});
