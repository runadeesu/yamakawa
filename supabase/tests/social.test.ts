import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, makeFriends, makePlayer, online, type Player } from './helpers';

describe('search, friends, blocks, reports', () => {
  let db: PGlite;
  let alice: Player, bob: Player, carol: Player, dave: Player;
  beforeAll(async () => {
    db = await createDb();
    alice = await makePlayer(db, 'alice');
    bob = await makePlayer(db, 'bob_the_builder');
    carol = await makePlayer(db, 'carol');
    dave = await makePlayer(db, 'bobby');
    await online(alice, bob, carol, dave);
  });

  it('searches by name prefix or exact code, excluding self', async () => {
    const byPrefix = await alice.rpc('search_players', 'bob');
    expect(byPrefix.map((p: any) => p.name).sort()).toEqual(['bob_the_builder', 'bobby']);
    expect(byPrefix.every((p: any) => p.relation === 'none')).toBe(true);
    const byCode = await alice.rpc('search_players', bob.code.toLowerCase());
    expect(byCode.map((p: any) => p.id)).toEqual([bob.id]);
    expect((await alice.rpc('search_players', 'alice')).length).toBe(0);
  });

  it('treats LIKE wildcards literally and validates the query length', async () => {
    expect(await alice.rpc('search_players', '%%')).toEqual([]);
    expect(await alice.rpc('search_players', 'b_')).toEqual([]);
    expect(await alice.errorOf('search_players', 'a')).toBe('invalid_input');
    expect(await alice.errorOf('search_players', 'x'.repeat(40))).toBe('invalid_input');
  });

  it('friend request flow: send, duplicate, accept, list, remove', async () => {
    const sent = await alice.rpc('friend_request_send', bob.id);
    expect(sent.status).toBe('pending');
    expect(await alice.errorOf('friend_request_send', bob.id)).toBe('already_requested');
    expect(await alice.errorOf('friend_request_send', alice.id)).toBe('invalid_target');
    expect(await alice.errorOf('friend_request_send', '00000000-0000-0000-0000-000000000000')).toBe('not_found');

    const lists = await bob.rpc('friend_requests_list');
    expect(lists.incoming).toHaveLength(1);
    expect(lists.incoming[0].name).toBe('alice');
    expect((await alice.rpc('friend_requests_list')).outgoing).toHaveLength(1);
    expect((await bob.rpc('get_me')).pending_requests).toBe(1);

    expect(await alice.errorOf('friend_request_respond', sent.id, true)).toBe('not_found');   // 送信者は承認できない
    expect((await bob.rpc('friend_request_respond', sent.id, true)).status).toBe('accepted');
    expect(await bob.errorOf('friend_request_respond', sent.id, true)).toBe('already_handled');
    expect(await alice.errorOf('friend_request_send', bob.id)).toBe('already_friends');

    const friends = await alice.rpc('friends_list');
    expect(friends.map((f: any) => f.name)).toEqual(['bob_the_builder']);
    expect(friends[0].online).toBe(true);
    expect(friends[0].status).toBe('online');
    expect((await bob.sql(`select * from public.friendships`)).length).toBe(1);

    await alice.rpc('friend_remove', bob.id);
    expect(await alice.rpc('friends_list')).toEqual([]);
    expect(await bob.rpc('friends_list')).toEqual([]);
    expect(await alice.errorOf('friend_remove', bob.id)).toBe('not_found');
  });

  it('declined requests can be re-sent later but not spammed', async () => {
    const r = await carol.rpc('friend_request_send', dave.id);
    await dave.rpc('friend_request_respond', r.id, false);
    expect((await carol.rpc('friend_requests_list')).outgoing).toHaveLength(0);
    await carol.rpc('friend_request_send', dave.id);
    const l = await dave.rpc('friend_requests_list');
    await dave.rpc('friend_request_respond', l.incoming[0].id, false);
    await carol.rpc('friend_request_send', dave.id);
    const l2 = await dave.rpc('friend_requests_list');
    await dave.rpc('friend_request_respond', l2.incoming[0].id, false);
    expect(await carol.errorOf('friend_request_send', dave.id)).toBe('rate_limited');   // 同じ相手へは 1日3回まで
  });

  it('cancelling an outgoing request works and only for the sender', async () => {
    const eve = await makePlayer(db, 'eve');
    const r = await eve.rpc('friend_request_send', alice.id);
    expect(await alice.errorOf('friend_request_cancel', r.id)).toBe('not_found');
    await eve.rpc('friend_request_cancel', r.id);
    expect((await alice.rpc('friend_requests_list')).incoming).toHaveLength(0);
  });

  it('crossing requests are accepted automatically', async () => {
    const frank = await makePlayer(db, 'frank');
    const grace = await makePlayer(db, 'grace');
    await frank.rpc('friend_request_send', grace.id);
    const res = await grace.rpc('friend_request_send', frank.id);
    expect(res.status).toBe('accepted');
    expect((await grace.rpc('friends_list')).map((f: any) => f.name)).toEqual(['frank']);
  });

  it('limits friend-request volume per hour', async () => {
    const spammer = await makePlayer(db, 'spammer');
    const targets: Player[] = [];
    for (let i = 0; i < 21; i++) targets.push(await makePlayer(db, `target${i}`));
    for (let i = 0; i < 20; i++) await spammer.rpc('friend_request_send', targets[i]!.id);
    expect(await spammer.errorOf('friend_request_send', targets[20]!.id)).toBe('rate_limited');
  });

  it('blocking removes the friendship, hides the blocker from search and stops requests', async () => {
    const x = await makePlayer(db, 'xavier');
    const y = await makePlayer(db, 'yvonne');
    await makeFriends(x, y);
    await x.rpc('block_set', y.id, 'block');
    expect(await x.rpc('friends_list')).toEqual([]);
    expect(await y.rpc('friends_list')).toEqual([]);
    expect((await y.rpc('search_players', 'xavier'))).toEqual([]);                   // ブロックした側は検索に出ない
    expect((await x.rpc('search_players', 'yvonne'))[0].relation).toBe('blocked');
    expect(await y.errorOf('friend_request_send', x.id)).toBe('not_found');          // ブロックされたことは伏せる
    expect(await x.errorOf('friend_request_send', y.id)).toBe('you_blocked');
    expect(await y.errorOf('get_profile', x.id)).toBe('not_found');
    expect((await x.rpc('blocks_list')).map((b: any) => b.name)).toEqual(['yvonne']);
    await x.rpc('block_clear', y.id);
    expect(await x.rpc('blocks_list')).toEqual([]);
    expect(await x.errorOf('block_set', x.id, 'block')).toBe('invalid_target');
    expect(await x.errorOf('block_set', y.id, 'ban')).toBe('invalid_input');
  });

  it('pending requests are cancelled when either side blocks', async () => {
    const p = await makePlayer(db, 'peter');
    const q = await makePlayer(db, 'quinn');
    await p.rpc('friend_request_send', q.id);
    await q.rpc('block_set', p.id, 'block');
    expect((await q.rpc('friend_requests_list')).incoming).toHaveLength(0);
    expect((await p.rpc('friend_requests_list')).outgoing).toHaveLength(0);
  });

  it('reports: validates reason, dedupes, rate limits, only visible to the reporter', async () => {
    const r1 = await alice.rpc('report_player', dave.id, 'spam', '  迷惑な\nメッセージ  ');
    const again = await alice.rpc('report_player', dave.id, 'spam', 'もう一度');
    expect(again).toBe(r1);
    expect(await alice.errorOf('report_player', dave.id, 'nonsense')).toBe('invalid_input');
    expect(await alice.errorOf('report_player', alice.id, 'spam')).toBe('invalid_target');
    expect(await alice.errorOf('report_player', dave.id, 'other', 'x'.repeat(301))).toBe('too_long');
    const mine = await alice.sql<{ detail: string }>(`select detail from public.reports`);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.detail).toBe('迷惑な メッセージ');
    expect(await dave.sql(`select * from public.reports`)).toEqual([]);
    expect(await bob.sql(`select * from public.reports`)).toEqual([]);
  });

  it('players only see their own friend requests / friendships / blocks through RLS', async () => {
    const s1 = await makePlayer(db, 'sam');
    const s2 = await makePlayer(db, 'sue');
    const s3 = await makePlayer(db, 'stan');
    await makeFriends(s1, s2);
    await s1.rpc('block_set', s3.id, 'mute');
    expect(await s3.sql(`select * from public.friendships`)).toEqual([]);
    expect(await s3.sql(`select * from public.friend_requests`)).toEqual([]);
    expect(await s3.sql(`select * from public.player_blocks`)).toEqual([]);
    expect((await s1.sql(`select * from public.player_blocks`)).length).toBe(1);
  });
});
