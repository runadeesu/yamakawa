import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, makePlayer, runAs } from './helpers';

describe('accounts & access control', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createDb();
  });

  it('creates a player with a unique public code', async () => {
    const a = await makePlayer(db, 'Alice');
    const b = await makePlayer(db, 'Bob');
    expect(a.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(a.code).not.toBe(b.code);
    const me = await a.rpc('get_me');
    expect(me.player.name).toBe('Alice');
    expect(me.player.wins).toBe(0);
  });

  it('rejects duplicate display names (case-insensitive key)', async () => {
    await makePlayer(db, 'Carol');
    await expect(makePlayer(db, 'carol')).rejects.toThrow('name_taken');
    const rows = await runAs<{ r: boolean }>(db, 'service_role', null, `select public.svc_name_available('carol') as r`);
    expect(rows[0]!.r).toBe(false);
  });

  it('looks up the internal login email by display-name key (service role only)', async () => {
    const d = await makePlayer(db, 'Dave');
    const found = await runAs<{ r: { player_id: string; auth_email: string } }>(
      db, 'service_role', null, `select public.svc_login_lookup('dave') as r`);
    expect(found[0]!.r.player_id).toBe(d.id);
    expect(found[0]!.r.auth_email).toMatch(/@players\.invalid$/);
    const none = await runAs<{ r: unknown }>(db, 'service_role', null, `select public.svc_login_lookup('nobody') as r`);
    expect(none[0]!.r).toBeNull();
  });

  it('blocks public sign-ups: only admin-created auth users are accepted', async () => {
    await expect(db.query(`insert into auth.users (email) values ('attacker@example.com')`)).rejects.toThrow('signup_disabled');
    await expect(
      db.query(`insert into auth.users (email, raw_app_meta_data) values ('x@example.com', '{"provider":"email"}')`),
    ).rejects.toThrow('signup_disabled');
  });

  it('accepts GoTrue-style admin creation (INSERT, then app_metadata set in the same transaction)', async () => {
    await db.exec(`begin; insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'admin-made@x.invalid');
      update auth.users set raw_app_meta_data = '{"provider":"email","teruki":"1"}' where id = '11111111-1111-1111-1111-111111111111'; commit;`);
    const rows = await db.query<{ n: number }>(`select count(*)::int as n from auth.users where email = 'admin-made@x.invalid'`);
    expect(rows.rows[0]!.n).toBe(1);
    // 同じ流れでフラグを付けなければコミット時に拒否され、ユーザーは残らない
    await expect(
      db.exec(`begin; insert into auth.users (email) values ('public-signup@x.invalid'); commit;`),
    ).rejects.toThrow('signup_disabled');
    await db.exec('rollback');
    const none = await db.query<{ n: number }>(`select count(*)::int as n from auth.users where email = 'public-signup@x.invalid'`);
    expect(none.rows[0]!.n).toBe(0);
  });

  it('login throttle helpers: peek does not count, hit counts, reset clears', async () => {
    const svc = (q: string) => runAs<{ r: any }>(db, 'service_role', null, q);
    expect((await svc(`select public.svc_rate_peek('t:login', 3, 60) as r`))[0]!.r.allowed).toBe(true);
    for (let i = 0; i < 3; i++) await svc(`select public.svc_rate_hit('t:login', 60) as r`);
    const locked = (await svc(`select public.svc_rate_peek('t:login', 3, 60) as r`))[0]!.r;
    expect(locked.allowed).toBe(false);
    expect(locked.retry_after).toBeGreaterThan(0);
    await svc(`select public.svc_rate_reset('t:login') as r`);
    expect((await svc(`select public.svc_rate_peek('t:login', 3, 60) as r`))[0]!.r.allowed).toBe(true);
  });

  it('clients cannot write any table directly', async () => {
    const a = await makePlayer(db, 'Erin');
    const attempts = [
      `insert into public.players (id, name, name_key, code) values (gen_random_uuid(), 'zz', 'zz', 'ZZZZZZZZ')`,
      `update public.players set wins = 999 where id = '${a.id}'`,
      `update public.players set name = 'Hacked' where id = '${a.id}'`,
      `delete from public.players where id = '${a.id}'`,
      `insert into public.friendships (player_a, player_b) values ('${a.id}', '${a.id}')`,
      `insert into public.messages (conversation_id, sender_id, body) values (null, '${a.id}', 'x')`,
      `update public.matches set status = 'finished'`,
      `insert into public.reports (reporter_id, target_id, reason) values ('${a.id}', '${a.id}', 'abuse')`,
    ];
    for (const q of attempts) {
      await expect(a.sql(q), q).rejects.toThrow(/permission denied/);
    }
  });

  it('clients cannot read internal tables, secrets or call service-role functions', async () => {
    const a = await makePlayer(db, 'Frank');
    await expect(a.sql(`select * from app_private.player_secrets`)).rejects.toThrow(/permission denied/);
    await expect(a.sql(`select * from app_private.rate_limits`)).rejects.toThrow(/permission denied/);
    await expect(a.sql(`select * from app_private.match_seeds`)).rejects.toThrow(/permission denied/);
    await expect(a.sql(`select * from auth.users`)).rejects.toThrow(/permission denied/);
    await expect(a.sql(`select public.svc_login_lookup('frank')`)).rejects.toThrow(/permission denied/);
    await expect(a.sql(`select public.svc_create_player(gen_random_uuid(), 'x', 'x', 'x')`)).rejects.toThrow(/permission denied/);
    await expect(a.sql(`select app_private.purge_old_data()`)).rejects.toThrow(/permission denied/);
    await expect(a.sql(`select app_private.create_match('${a.id}', '${a.id}', 'quick')`)).rejects.toThrow(/permission denied/);
  });

  it('anonymous callers cannot use any RPC', async () => {
    for (const q of [`select public.get_me()`, `select public.search_players('ab')`, `select public.heartbeat()`, `select public.queue_join()`]) {
      await expect(runAs(db, 'anon', null, q), q).rejects.toThrow(/permission denied/);
    }
    await expect(runAs(db, 'anon', null, `select * from public.players`)).rejects.toThrow(/permission denied/);
  });

  it('a logged-in user without a player row is rejected', async () => {
    const orphan = await db.query<{ id: string }>(`insert into auth.users (email, raw_app_meta_data) values ('o@x.invalid', '{"teruki":"1"}') returning id`);
    const rows = runAs(db, 'authenticated', orphan.rows[0]!.id, `select public.get_me()`);
    await expect(rows).rejects.toThrow('no_player');
    await expect(runAs(db, 'authenticated', null, `select public.get_me()`)).rejects.toThrow('unauthenticated');
  });

  it('players can only read their own row directly', async () => {
    const a = await makePlayer(db, 'Grace');
    await makePlayer(db, 'Heidi');
    const rows = await a.sql<{ id: string }>(`select id from public.players`);
    expect(rows.map((r) => r.id)).toEqual([a.id]);
  });
});
