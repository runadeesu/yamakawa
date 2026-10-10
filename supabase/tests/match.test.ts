import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, makeFriends, makePlayer, online, runAs, type Player } from './helpers';
import { buildLog } from './logTools';

let n = 0;
const uniq = (p: string) => `${p}${++n}`;

describe('matchmaking, invites and match results', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createDb();
  });

  async function pair(): Promise<[Player, Player]> {
    const a = await makePlayer(db, uniq('pa'));
    const b = await makePlayer(db, uniq('pb'));
    await online(a, b);
    return [a, b];
  }

  async function startMatch(a: Player, b: Player) {
    await a.rpc('queue_join');
    const q = await b.rpc('queue_join');
    expect(q.status).toBe('matched');
    const id: string = q.match_id;
    await a.rpc('match_ready', id);
    const st = await b.rpc('match_ready', id);
    expect(st.status).toBe('playing');
    return { id, seq: st.seq as number[] };
  }

  const rewind = (id: string, secs: number) =>
    db.query(`update public.matches set starts_at = starts_at - make_interval(secs => $2), ends_at = ends_at - make_interval(secs => $2) where id = $1`, [id, secs]);
  /** 時計を進めたあと、両者がずっと進捗を送っていた状態にする (切断扱いにならないように) */
  const alive = (id: string) =>
    db.query(`update public.match_players set last_progress_at = now() where match_id = $1 and not finished`, [id]);
  const stats = async (p: Player) => (await p.rpc('get_me')).player;
  const violations = async (id: string) =>
    Number((await db.query<{ n: number }>(`select count(*)::int as n from app_private.match_violations where match_id = $1`, [id])).rows[0]!.n);

  describe('quick match', () => {
    it('pairs two waiting players exactly once and shares one seed', async () => {
      const [a, b] = await pair();
      expect((await a.rpc('queue_join')).status).toBe('waiting');
      expect((await a.rpc('queue_status')).status).toBe('waiting');
      const q = await b.rpc('queue_join');
      expect(q.status).toBe('matched');
      expect((await a.rpc('queue_status'))).toEqual({ status: 'matched', match_id: q.match_id });
      const sa = await a.rpc('match_get', q.match_id);
      const sb = await b.rpc('match_get', q.match_id);
      expect(sa.seq).toHaveLength(400);
      expect(sa.seq).toEqual(sb.seq);
      expect(sa.seq.every((l: number) => l >= 1 && l <= 4)).toBe(true);
      expect(sa.players.map((p: any) => p.name)).toEqual([sa.players[0].name, sb.players[1].name]);
      expect(sa.status).toBe('lobby');
      expect((await a.rpc('match_current')).id).toBe(q.match_id);
      expect((await a.rpc('queue_join')).match_id).toBe(q.match_id);   // 参加中なら新しく作らず同じ試合を返す
    });

    it('does not match a third player into someone else’s match', async () => {
      const [a, b] = await pair();
      const c = await makePlayer(db, uniq('pc'));
      await online(c);
      await a.rpc('queue_join');
      const q = await b.rpc('queue_join');
      expect((await c.rpc('queue_join')).status).toBe('waiting');
      expect(await c.errorOf('match_get', q.match_id)).toBe('not_found');
      expect(await c.errorOf('match_ready', q.match_id)).toBe('not_found');
      expect(await c.errorOf('match_finish', q.match_id, [], 'time')).toBe('not_found');
      expect(await c.sql(`select * from public.matches`)).toEqual([]);
      expect(await c.sql(`select * from public.match_players`)).toEqual([]);
      await c.rpc('queue_leave');
    });

    it('queue_leave cancels searching; offline and blocked players are never paired', async () => {
      const a = await makePlayer(db, uniq('qa'));
      const b = await makePlayer(db, uniq('qb'));
      await online(a, b);
      await a.rpc('queue_join');
      await a.rpc('queue_leave');
      expect((await a.rpc('queue_status')).status).toBe('idle');
      expect((await b.rpc('queue_join')).status).toBe('waiting');   // a はもういない
      await b.rpc('queue_leave');

      await a.rpc('queue_join');
      await db.query(`update app_private.presence set last_seen = now() - interval '5 minutes' where player_id = $1`, [a.id]);
      expect((await b.rpc('queue_join')).status).toBe('waiting');   // a はオフライン扱い
      await a.rpc('queue_leave');
      await b.rpc('queue_leave');

      await online(a, b);
      await a.rpc('block_set', b.id, 'block');
      await a.rpc('queue_join');
      expect((await b.rpc('queue_join')).status).toBe('waiting');
      await a.rpc('queue_leave');
      await b.rpc('queue_leave');
    });

    it('cancels a lobby when players do not become ready in time', async () => {
      const [a, b] = await pair();
      await a.rpc('queue_join');
      const q = await b.rpc('queue_join');
      await a.rpc('match_ready', q.match_id);
      await db.query(`update public.matches set ready_deadline = now() - interval '1 second' where id = $1`, [q.match_id]);
      const st = await a.rpc('match_get', q.match_id);
      expect(st.status).toBe('cancelled');
      expect(st.end_reason).toBe('ready_timeout');
      expect((await stats(a)).matches).toBe(0);
      expect(await a.rpc('match_current')).toBeNull();
      expect(await b.errorOf('match_ready', q.match_id)).toBe('NO_ERROR');   // 何も起きないだけ
    });
  });

  describe('results are validated and stored by the server', () => {
    it('accepts valid logs, recomputes the score, decides the winner and updates stats once', async () => {
      const [a, b] = await pair();
      const { id, seq } = await startMatch(a, b);
      await rewind(id, 125);
      await alive(id);
      const good = buildLog(seq, 100);
      const worse = buildLog(seq, 40);
      const ra = await a.rpc('match_finish', id, good.log, 'time');
      expect(ra.error).toBeUndefined();
      expect(ra.players.find((p: any) => p.id === a.id).final_score).toBe(good.score);
      expect(ra.status).toBe('playing');                       // 相手の報告待ち
      const rb = await b.rpc('match_finish', id, worse.log, 'time');
      expect(rb.status).toBe('finished');
      expect(rb.result).toBe('win');
      expect(rb.winner_id).toBe(a.id);
      expect(rb.end_reason).toBe('time_up');
      expect(rb.players.find((p: any) => p.id === b.id).final_score).toBe(worse.score);
      expect(good.score).toBeGreaterThan(worse.score);

      expect(await stats(a)).toMatchObject({ matches: 1, wins: 1, losses: 0, draws: 0 });
      expect(await stats(b)).toMatchObject({ matches: 1, wins: 0, losses: 1, draws: 0 });

      // 二重送信・遅れて来た報告は結果を変えず、戦績も二重加算されない
      await a.rpc('match_finish', id, buildLog(seq, 100).log, 'time');
      await b.rpc('match_finish', id, buildLog(seq, 120).log, 'time');
      expect(await stats(a)).toMatchObject({ matches: 1, wins: 1 });
      expect(await stats(b)).toMatchObject({ matches: 1, losses: 1 });
      const again = await b.rpc('match_get', id);
      expect(again.players.find((p: any) => p.id === b.id).final_score).toBe(worse.score);
      expect(again.seq).toBeNull();                              // 終了後は出現順を返さない

      const prof = await a.rpc('get_profile');
      expect(prof).toMatchObject({ matches: 1, wins: 1, win_rate: 100, self: true });
      expect(prof.recent).toHaveLength(1);
      expect(prof.recent[0]).toMatchObject({ opponent: b.name, my_score: good.score, opp_score: worse.score, outcome: 'win' });
    });

    it('a draw counts for both players', async () => {
      const [a, b] = await pair();
      const { id, seq } = await startMatch(a, b);
      await rewind(id, 125);
      await alive(id);
      const log = buildLog(seq, 60).log;
      await a.rpc('match_finish', id, log, 'time');
      const r = await b.rpc('match_finish', id, log, 'time');
      expect(r.result).toBe('draw');
      expect(r.winner_id).toBeNull();
      expect(await stats(a)).toMatchObject({ matches: 1, wins: 0, losses: 0, draws: 1 });
      expect(await stats(b)).toMatchObject({ draws: 1 });
    });

    it('rejects tampered / impossible logs and records the attempts', async () => {
      const [a, b] = await pair();
      const { id, seq } = await startMatch(a, b);
      await rewind(id, 125);
      await alive(id);
      const ok = buildLog(seq, 30);
      const cases: Record<string, [any, string]> = {
        bad_piece_order: [[[0, 0, seq[0] === 1 ? 2 : 1]], 'time'],
        drop_too_fast: [[[0, 0, seq[0]], [10, 0, seq[1]]], 'time'],
        impossible_merge: [[[0, 0, seq[0]], [40, 1, 2]], 'time'],
        bad_level: [[[0, 0, seq[0]], [40, 1, 9]], 'time'],
        bad_time: [[[100, 0, seq[0]], [50, 0, seq[1]]], 'time'],
        bad_kind: [[[0, 7, 1]], 'time'],
        malformed: [{ not: 'an array' }, 'time'],
        malformed2: [[[0, 0]], 'time'],
        too_many_events: [Array.from({ length: 4001 }, (_, i) => [i, 2, 0]), 'time'],
        event_after_gameover: [[[0, 2, 0], [40, 0, seq[0]]], 'over'],
        no_gameover_event: [ok.log, 'over'],
        not_leading: [ok.log, 'lead'],
      };
      let expectedViolations = 0;
      for (const [name, [log, reason]] of Object.entries(cases)) {
        const res = await a.rpc('match_finish', id, log, reason);
        expect(res.error, name).toBe('invalid_log');
        expect(res.detail, name).toBe(name.replace(/2$/, ''));
        expectedViolations++;
      }
      expect(await violations(id)).toBe(expectedViolations);
      expect(await a.errorOf('match_finish', id, ok.log, 'cheat')).toBe('invalid_input');
      // どれも結果には影響しない
      expect((await a.rpc('match_get', id)).status).toBe('playing');
      expect((await a.rpc('match_get', id)).players.every((p: any) => !p.finished)).toBe(true);
    });

    it('rejects claims of more simulated time than has really elapsed (speed hacks)', async () => {
      const [a, b] = await pair();
      const { id, seq } = await startMatch(a, b);        // starts_at は未来 (4秒後)
      const big = buildLog(seq, 100);                    // 3000 steps = 50 秒ぶん
      const res = await a.rpc('match_finish', id, big.log, 'over');
      expect(res.error).toBe('invalid_log');
      await rewind(id, 10);                              // まだ 6 秒しか経っていない
      await alive(id);
      expect((await a.rpc('match_finish', id, big.log, 'time')).detail).toBe('time_travel');
      const early = await a.rpc('match_finish', id, buildLog(seq, 5).log, 'time');
      expect(early.detail).toBe('too_early');            // 時間切れは 120 秒経ってから
      void b;
    });

    it('elimination flow: the survivor wins only by surpassing the eliminated score', async () => {
      const [a, b] = await pair();
      const { id, seq } = await startMatch(a, b);
      await rewind(id, 70);
      await alive(id);
      const weak = buildLog(seq, 20);
      const over = [...weak.log, [weak.lastStep, 2, 0]];
      const ra = await a.rpc('match_finish', id, over, 'over');
      expect(ra.players.find((p: any) => p.id === a.id)).toMatchObject({ finished: true, eliminated: true, final_score: weak.score });
      expect(ra.status).toBe('playing');

      const stillLow = await b.rpc('match_finish', id, buildLog(seq, 3).log, 'lead');
      expect(stillLow.detail).toBe('not_leading');
      const strong = buildLog(seq, 60);
      const rb = await b.rpc('match_finish', id, strong.log, 'lead');
      expect(rb.status).toBe('finished');
      expect(rb.winner_id).toBe(b.id);
      expect(rb.end_reason).toBe('elimination');
      expect(await stats(a)).toMatchObject({ losses: 1 });
    });

    it('both eliminated: higher score wins', async () => {
      const [a, b] = await pair();
      const { id, seq } = await startMatch(a, b);
      await rewind(id, 70);
      await alive(id);
      const l1 = buildLog(seq, 25);
      const l2 = buildLog(seq, 45);
      await a.rpc('match_finish', id, [...l1.log, [l1.lastStep, 2, 0]], 'over');
      const r = await b.rpc('match_finish', id, [...l2.log, [l2.lastStep, 2, 0]], 'over');
      expect(r.winner_id).toBe(b.id);
    });
  });

  describe('forfeits and disconnects', () => {
    it('leaving a running match is a loss; leaving a lobby cancels without stats', async () => {
      const [a, b] = await pair();
      const { id } = await startMatch(a, b);
      const r = await a.rpc('match_leave', id);
      expect(r.status).toBe('finished');
      expect(r.winner_id).toBe(b.id);
      expect(r.end_reason).toBe('opponent_forfeit');
      expect(await stats(a)).toMatchObject({ matches: 1, losses: 1 });
      expect(await stats(b)).toMatchObject({ matches: 1, wins: 1 });

      const [c, d] = await pair();
      await c.rpc('queue_join');
      const q = await d.rpc('queue_join');
      const lobby = await c.rpc('match_leave', q.match_id);
      expect(lobby.status).toBe('cancelled');
      expect(await stats(c)).toMatchObject({ matches: 0 });
      expect(await stats(d)).toMatchObject({ matches: 0 });
    });

    it('a player who stops sending progress is forfeited by the opponent’s next call', async () => {
      const [a, b] = await pair();
      const { id } = await startMatch(a, b);
      await rewind(id, 40);                                     // 試合は 36 秒経過
      await a.rpc('match_progress', id, 12);                    // a は生きている
      await db.query(`update public.match_players set last_progress_at = now() - interval '30 seconds' where match_id = $1 and player_id = $2`, [id, b.id]);
      const st = await a.rpc('match_progress', id, 15);
      expect(st.status).toBe('finished');
      expect(st.winner_id).toBe(a.id);
      expect(await stats(b)).toMatchObject({ losses: 1 });
    });

    it('unreported players are forfeited after the deadline; both missing => void', async () => {
      const [a, b] = await pair();
      const { id, seq } = await startMatch(a, b);
      await rewind(id, 150);                                    // ends_at から 26 秒経過
      const log = buildLog(seq, 50);
      await a.rpc('match_progress', id, 1);                     // (期限後なので記録されない) 状態の整理だけ走る
      const st = await a.rpc('match_get', id);
      expect(st.status).toBe('finished');
      expect(st.result).toBe('void');
      expect(st.end_reason).toBe('both_forfeit');
      expect(await stats(a)).toMatchObject({ matches: 0 });
      void log;

      const [c, d] = await pair();
      const m = await startMatch(c, d);
      await rewind(m.id, 125);
      await alive(m.id);
      await c.rpc('match_finish', m.id, buildLog(m.seq, 30).log, 'time');
      await rewind(m.id, 30);                                   // d は 20 秒の猶予内に報告しなかった
      const r = await c.rpc('match_get', m.id);
      expect(r.winner_id).toBe(c.id);
      expect(r.end_reason).toBe('opponent_forfeit');
    });

    it('exposes how long the opponent has been silent (server-side connection indicator)', async () => {
      const [a, b] = await pair();
      const { id } = await startMatch(a, b);
      const lobby = await a.rpc('match_get', id);
      expect(lobby.players.every((p: any) => p.idle_ms !== undefined)).toBe(true);
      await rewind(id, 12);
      await a.rpc('match_progress', id, 10);
      await db.query(`update public.match_players set last_progress_at = now() - interval '9 seconds' where match_id = $1 and player_id = $2`, [id, b.id]);
      const st = await a.rpc('match_progress', id, 10);
      const mine = st.players.find((p: any) => p.id === a.id);
      const theirs = st.players.find((p: any) => p.id === b.id);
      expect(mine.idle_ms).toBeLessThan(2000);
      expect(theirs.idle_ms).toBeGreaterThanOrEqual(9000);
      expect(theirs.idle_ms).toBeLessThan(15000);
      await a.rpc('match_leave', id);
      const done = await b.rpc('match_get', id);
      expect(done.players.every((p: any) => p.idle_ms === null)).toBe(true);   // 終了後は null
    });

    it('progress is monotonic, rate limited and exposes the opponent score', async () => {
      const [a, b] = await pair();
      const { id } = await startMatch(a, b);
      await rewind(id, 10);
      await a.rpc('match_progress', id, 50);
      await a.rpc('match_progress', id, 20);                    // 下げようとしても下がらない
      const st = await b.rpc('match_progress', id, 5);
      expect(st.players.find((p: any) => p.id === a.id).progress_score).toBe(50);
      for (let i = 0; i < 59; i++) await b.rpc('match_progress', id, 5);
      expect(await b.errorOf('match_progress', id, 5)).toBe('rate_limited');
    });
  });

  describe('invites', () => {
    it('invite flow: offline friend, accept creates a match, decline, expiry, busy', async () => {
      const a = await makePlayer(db, uniq('ia'));
      const b = await makePlayer(db, uniq('ib'));
      const c = await makePlayer(db, uniq('ic'));
      await makeFriends(a, b);
      await online(a);
      expect(await a.errorOf('invite_send', b.id)).toBe('offline');
      await online(b);
      expect(await a.errorOf('invite_send', c.id)).toBe('not_friends');
      expect(await a.errorOf('invite_send', a.id)).toBe('invalid_target');

      const inv = await a.rpc('invite_send', b.id);
      expect(await a.errorOf('invite_send', b.id)).toBe('already_invited');
      const list = await b.rpc('invites_list');
      expect(list.incoming).toHaveLength(1);
      expect(list.incoming[0].name).toBe(a.name);
      expect((await b.rpc('get_me')).pending_invites).toBe(1);
      expect(await a.errorOf('invite_respond', inv.id, true)).toBe('not_found');   // 送信者は承認できない

      const res = await b.rpc('invite_respond', inv.id, true);
      expect(res.status).toBe('accepted');
      const out = (await a.rpc('invites_list')).outgoing[0];
      expect(out).toMatchObject({ status: 'accepted', match_id: res.match_id });
      expect((await a.rpc('match_get', res.match_id)).status).toBe('lobby');
      expect((await b.rpc('invite_respond', inv.id, true)).status).toBe('accepted');   // 再送しても同じ結果
      expect(await a.errorOf('invite_send', b.id)).toBe('busy');                       // すでに対戦中

      const [x, y] = await pair();
      await makeFriends(x, y);
      const i1 = await x.rpc('invite_send', y.id);
      expect((await y.rpc('invite_respond', i1.id, false)).status).toBe('declined');
      const i2 = await x.rpc('invite_send', y.id);
      await db.query(`update public.match_invites set expires_at = now() - interval '1 second' where id = $1`, [i2.id]);
      expect((await y.rpc('invite_respond', i2.id, true)).status).toBe('expired');
      expect((await y.rpc('invites_list')).incoming).toEqual([]);
      const i3 = await x.rpc('invite_send', y.id);
      await x.rpc('invite_cancel', i3.id);
      expect((await y.rpc('invite_respond', i3.id, true)).status).toBe('cancelled');
    });

    it('blocked or unfriended players cannot be invited and invites disappear', async () => {
      const [x, y] = await pair();
      await makeFriends(x, y);
      const i = await x.rpc('invite_send', y.id);
      await y.rpc('block_set', x.id, 'block');
      expect((await y.rpc('invites_list')).incoming).toEqual([]);
      expect((await y.rpc('invite_respond', i.id, true)).status).toBe('cancelled');
      expect(await x.errorOf('invite_send', y.id)).toBe('not_friends');
    });
  });

  describe('match chat, profile and RLS', () => {
    it('only the two participants can chat or read the match chat', async () => {
      const [a, b] = await pair();
      const c = await makePlayer(db, uniq('oc'));
      await online(c);
      const { id } = await startMatch(a, b);
      await a.rpc('match_chat_send', id, 'よろしく！');
      await new Promise((r) => setTimeout(r, 550));
      await b.rpc('match_chat_send', id, '<b>gg</b>');
      const hist = await a.rpc('match_chat_history', id);
      expect(hist.map((m: any) => m.body)).toEqual(['よろしく！', '＜b＞gg＜/b＞']);
      expect(await c.errorOf('match_chat_send', id, 'hi')).toBe('forbidden');
      expect(await c.errorOf('match_chat_history', id)).toBe('not_found');
      expect(await c.sql(`select * from public.messages`)).toEqual([]);
      expect((await a.sql(`select * from public.messages`)).length).toBe(2);
      await b.rpc('block_set', a.id, 'mute');
      expect((await b.rpc('match_chat_history', id)).map((m: any) => m.body)).toEqual(['＜b＞gg＜/b＞']);
    });

    it('participants can read their match rows, outsiders cannot; match tables stay read-only', async () => {
      const [a, b] = await pair();
      const c = await makePlayer(db, uniq('oc'));
      const { id } = await startMatch(a, b);
      expect((await a.sql(`select id from public.matches where id = $1`, [id])).length).toBe(1);
      expect((await a.sql(`select * from public.match_players where match_id = $1`, [id])).length).toBe(2);
      expect(await c.sql(`select id from public.matches where id = $1`, [id])).toEqual([]);
      await expect(a.sql(`update public.match_players set final_score = 999999 where match_id = $1`, [id])).rejects.toThrow(/permission denied/);
      await expect(a.sql(`update public.players set wins = wins + 100 where id = $1`, [a.id])).rejects.toThrow(/permission denied/);
    });

    it('profiles: online status only for friends, blocked players are hidden', async () => {
      const a = await makePlayer(db, uniq('pr'));
      const b = await makePlayer(db, uniq('pr'));
      const c = await makePlayer(db, uniq('pr'));
      await online(a, b, c);
      await makeFriends(a, b);
      const asFriend = await a.rpc('get_profile', b.id);
      expect(asFriend).toMatchObject({ relation: 'friend', online: true, friend_count: 1, matches: 0, win_rate: null });
      const asStranger = await c.rpc('get_profile', b.id);
      expect(asStranger).toMatchObject({ relation: 'none', online: null });
      expect(await c.errorOf('get_profile', '00000000-0000-0000-0000-000000000000')).toBe('not_found');
      await b.rpc('block_set', c.id, 'block');
      expect(await c.errorOf('get_profile', b.id)).toBe('not_found');
    });
  });

  it('sweeps stale matches in bulk (what pg_cron runs)', async () => {
    const [a, b] = await pair();
    const { id } = await startMatch(a, b);
    await rewind(id, 400);
    await db.exec(`select app_private.sweep_matches()`);
    const rows = await runAs<{ status: string }>(db, 'authenticated', a.id, `select status from public.matches where id = '${id}'`);
    expect(rows[0]!.status).toBe('finished');
  });
});
