import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, makeFriends, makePlayer, online, type Player } from './helpers';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('chat', () => {
  let db: PGlite;
  let a: Player, b: Player, c: Player;
  beforeAll(async () => {
    db = await createDb();
    a = await makePlayer(db, 'chat_a');
    b = await makePlayer(db, 'chat_b');
    c = await makePlayer(db, 'chat_c');
    await makeFriends(a, b);
    await online(a, b, c);
  });

  it('sends messages between friends and stores history in order', async () => {
    const m1 = await a.rpc('chat_send', b.id, 'こんにちは');
    await wait(550);
    const m2 = await b.rpc('chat_send', a.id, 'やあ！');
    expect(m2.id).toBeGreaterThan(m1.id);
    const hist = await a.rpc('chat_history', b.id);
    expect(hist.map((m: any) => [m.mine, m.body])).toEqual([[true, 'こんにちは'], [false, 'やあ！']]);
    const older = await a.rpc('chat_history', b.id, m2.id, 10);
    expect(older.map((m: any) => m.body)).toEqual(['こんにちは']);
  });

  it('tracks unread counts and marks them read', async () => {
    await wait(550);
    await b.rpc('chat_send', a.id, 'unread 1');
    await wait(550);
    await b.rpc('chat_send', a.id, 'unread 2');
    let friends = await a.rpc('friends_list');
    expect(friends[0].unread).toBe(3);   // 前のテストの「やあ！」 + 2通
    expect(friends[0].last_body).toBe('unread 2');
    expect((await a.rpc('get_me')).unread).toBe(3);
    await a.rpc('chat_mark_read', b.id);
    friends = await a.rpc('friends_list');
    expect(friends[0].unread).toBe(0);
    expect((await a.rpc('get_me')).unread).toBe(0);
    expect((await b.rpc('get_me')).unread).toBe(0);   // b は返信した時点で a の発言を読んだ扱い
  });

  it('only friends can chat; strangers cannot send or read', async () => {
    expect(await c.errorOf('chat_send', a.id, 'hi')).toBe('forbidden');
    expect(await a.errorOf('chat_send', c.id, 'hi')).toBe('forbidden');
    expect(await a.errorOf('chat_send', a.id, 'hi')).toBe('forbidden');
    expect(await c.rpc('chat_history', a.id)).toEqual([]);
    expect(await c.sql(`select * from public.messages`)).toEqual([]);
    expect(await c.sql(`select * from public.conversations`)).toEqual([]);
  });

  it('neutralizes HTML/script, control and invisible characters', async () => {
    await wait(550);
    const m = await a.rpc('chat_send', b.id, '<script>alert(1)</script>\n<img src=x onerror=alert(2)>​‮');
    expect(m.body).not.toMatch(/[<>]/);
    expect(m.body).toContain('＜script＞alert(1)＜/script＞');
    expect(m.body).not.toMatch(/[​‮\n]/);
  });

  it('validates length and emptiness', async () => {
    await wait(550);
    expect(await a.errorOf('chat_send', b.id, '   ')).toBe('empty');
    await wait(550);
    expect(await a.errorOf('chat_send', b.id, null)).toBe('empty');
    await wait(550);
    expect(await a.errorOf('chat_send', b.id, 'あ'.repeat(201))).toBe('too_long');
    await wait(550);
    expect((await a.rpc('chat_send', b.id, 'あ'.repeat(200))).body).toHaveLength(200);
  });

  it('masks NG words', async () => {
    await wait(550);
    const m = await a.rpc('chat_send', b.id, 'おまえ きもい FUCK you');
    expect(m.body).toBe('おまえ ＊＊＊ ＊＊＊＊ you');
  });

  it('rejects rapid-fire and duplicate messages', async () => {
    await wait(550);
    await a.rpc('chat_send', b.id, 'fast 1');
    expect(await a.errorOf('chat_send', b.id, 'fast 2')).toBe('too_fast');
    await wait(550);
    expect(await a.errorOf('chat_send', b.id, 'fast 1')).toBe('duplicate');
  });

  it('caps the sending rate (20 messages / 30s)', async () => {
    const s = await makePlayer(db, 'flood');
    const t = await makePlayer(db, 'flood_t');
    await makeFriends(s, t);
    let limited = false;
    for (let i = 0; i < 24 && !limited; i++) {
      await wait(520);
      const err = await s.errorOf('chat_send', t.id, `msg ${i}`);
      if (err === 'rate_limited') limited = true;
      else expect(err).toBe('NO_ERROR');
    }
    expect(limited).toBe(true);
  }, 30000);

  it('blocked users cannot send, and muted/blocked senders are hidden from the receiver', async () => {
    const x = await makePlayer(db, 'blk_x');
    const y = await makePlayer(db, 'blk_y');
    await makeFriends(x, y);
    await online(x, y);
    await wait(550);
    await y.rpc('chat_send', x.id, 'before mute');
    await x.rpc('block_set', y.id, 'mute');                       // ミュート: 友達のまま、相手の発言は見えない
    expect((await x.rpc('chat_history', y.id))).toEqual([]);
    expect((await x.sql(`select * from public.messages`))).toEqual([]);   // RLS (= Realtime) でも見えない
    expect((await x.rpc('friends_list'))[0].unread).toBe(0);
    await wait(550);
    await y.rpc('chat_send', x.id, 'while muted');                // 送信自体はできる (ミュートは通知されない)
    expect((await x.rpc('get_me')).unread).toBe(0);
    expect((await y.rpc('chat_history', x.id)).length).toBe(2);   // 送信者本人には見える

    await x.rpc('block_set', y.id, 'block');                      // ブロック: 友達解除、送信不可
    expect(await y.errorOf('chat_send', x.id, 'hello?')).toBe('forbidden');
    expect(await x.errorOf('chat_send', y.id, 'hello?')).toBe('forbidden');
    await x.rpc('block_clear', y.id);
    expect(await y.errorOf('chat_send', x.id, 'hello again')).toBe('forbidden');   // 友達ではなくなっている
  });

  it('retention: purges old messages, keeps the newest 500 per conversation', async () => {
    await db.exec(`
      insert into public.messages (conversation_id, sender_id, body, created_at)
      select c.id, c.player_a, 'old ' || g, now() - interval '31 days' from public.conversations c, generate_series(1, 3) g limit 3;
    `);
    const before = Number((await db.query<{ n: number }>(`select count(*)::int as n from public.messages where body like 'old %'`)).rows[0]!.n);
    expect(before).toBe(3);
    await db.exec(`select app_private.purge_old_data()`);
    const after = Number((await db.query<{ n: number }>(`select count(*)::int as n from public.messages where body like 'old %'`)).rows[0]!.n);
    expect(after).toBe(0);

    const conv = (await db.query<{ id: string; player_a: string }>(`select id, player_a from public.conversations limit 1`)).rows[0]!;
    await db.query(`insert into public.messages (conversation_id, sender_id, body) select $1, $2, 'bulk ' || g from generate_series(1, 520) g`, [conv.id, conv.player_a]);
    await db.exec(`select app_private.purge_old_data()`);
    const kept = Number((await db.query<{ n: number }>(`select count(*)::int as n from public.messages where conversation_id = '${conv.id}'`)).rows[0]!.n);
    expect(kept).toBe(500);
  });
});
