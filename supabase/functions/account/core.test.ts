import { describe, expect, it } from 'vitest';
import { checkName, checkPassword, handleAccount, nameKeyOf, type Backend, type SessionData } from './core';

/** メモリ上の偽バックエンド (Supabase なしでサインアップ/ログインのロジックを検証する) */
function fakeBackend() {
  const players = new Map<string, { id: string; name: string; email: string; password: string; code: string }>();
  const counters = new Map<string, number>();
  const calls = { deleted: [] as string[], signIns: 0 };
  let seq = 0;
  const session = (): SessionData => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'bearer' });

  const backend: Backend = {
    nameAvailable: async (key) => !players.has(key),
    createAuthUser: async () => ({ id: `u${++seq}` }),
    deleteAuthUser: async (id) => void calls.deleted.push(id),
    createPlayer: async (id, name, key, email) => {
      if (players.has(key)) throw new Error('name_taken');
      players.set(key, { id, name, email, password: '', code: `CODE${seq}` });
      return { id, name, code: `CODE${seq}` };
    },
    loginLookup: async (key) => {
      const p = players.get(key);
      return p ? { player_id: p.id, auth_email: p.email, name: p.name, code: p.code } : null;
    },
    signIn: async (email, password) => {
      calls.signIns++;
      const p = [...players.values()].find((x) => x.email === email);
      if (!p) return null;
      if (p.password === '') p.password = password;      // サインアップ直後の最初の signIn でパスワードを記録
      return p.password === password ? session() : null;
    },
    rate: {
      peek: async (key, max) => {
        const n = counters.get(key) ?? 0;
        return n >= max ? { allowed: false, retry_after: 600 } : { allowed: true, retry_after: 0 };
      },
      hit: async (key) => void counters.set(key, (counters.get(key) ?? 0) + 1),
      reset: async (key) => void counters.delete(key),
    },
    randomHex: (n) => 'ab'.repeat(n),
    hashIp: async (ip) => `hash(${ip})`,
    sleep: async () => undefined,
  };
  return { backend, players, counters, calls };
}

const post = (body: unknown, headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.7' }) =>
  new Request('https://x.test/functions/v1/account', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers });

async function call(backend: Backend, body: unknown, headers?: Record<string, string>) {
  const res = await handleAccount(post(body, headers), backend);
  return { status: res.status, body: (await res.json()) as any, res };
}

describe('name & password rules', () => {
  it('normalizes names (NFKC) and builds a case-insensitive key', () => {
    const n = checkName('  Ａｌｉｃｅ_1 ');
    expect(n).toEqual({ ok: true, name: 'Alice_1', key: 'alice_1' });
    expect(nameKeyOf('ＴＥＲＵＫＩ')).toBe('teruki');
    expect(checkName('てるき')).toMatchObject({ ok: true });
    expect(checkName('テルキー')).toMatchObject({ ok: true });
    expect(checkName('山川てるき')).toMatchObject({ ok: true });
  });

  it('rejects bad names', () => {
    expect(checkName('a')).toEqual({ ok: false, detail: 'length' });
    expect(checkName('x'.repeat(17))).toEqual({ ok: false, detail: 'length' });
    expect(checkName('has space')).toEqual({ ok: false, detail: 'chars' });
    expect(checkName('<script>')).toEqual({ ok: false, detail: 'chars' });
    expect(checkName('😀😀')).toEqual({ ok: false, detail: 'chars' });
    expect(checkName('аdmin')).toEqual({ ok: false, detail: 'chars' });          // キリル文字の a (なりすまし対策)
    expect(checkName('Admin')).toEqual({ ok: false, detail: 'reserved' });
    expect(checkName('admin01')).toEqual({ ok: false, detail: 'reserved' });
    expect(checkName('公式')).toEqual({ ok: false, detail: 'reserved' });
    expect(checkName(null)).toEqual({ ok: false, detail: 'type' });
  });

  it('rejects weak or malformed passwords', () => {
    expect(checkPassword('short', 'x')).toEqual({ ok: false, detail: 'length' });
    expect(checkPassword('a'.repeat(73), 'x')).toEqual({ ok: false, detail: 'length' });
    expect(checkPassword('あ'.repeat(25), 'x')).toEqual({ ok: false, detail: 'length' });   // 75 バイト
    expect(checkPassword('aaaaaaaa', 'x')).toEqual({ ok: false, detail: 'weak' });
    expect(checkPassword('Password1', 'x')).toEqual({ ok: false, detail: 'weak' });
    expect(checkPassword('alice_the_great', 'alice_the_great')).toEqual({ ok: false, detail: 'weak' });
    expect(checkPassword('bad\u0000pass1234', 'x')).toEqual({ ok: false, detail: 'chars' });
    expect(checkPassword('correct horse battery', 'x')).toEqual({ ok: true });
    expect(checkPassword('てるきのパスワード', 'x')).toEqual({ ok: true });
  });
});

describe('account endpoint', () => {
  it('answers CORS preflight and rejects non-POST / malformed / oversized bodies', async () => {
    const { backend } = fakeBackend();
    const pre = await handleAccount(new Request('https://x.test', { method: 'OPTIONS' }), backend);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect((await handleAccount(new Request('https://x.test', { method: 'GET' }), backend)).status).toBe(405);
    expect((await call(backend, 'not json')).status).toBe(400);
    expect((await call(backend, '[]')).status).toBe(400);
    expect((await call(backend, { action: 'hack' })).status).toBe(400);
    expect((await call(backend, { action: 'login', name: 'a'.repeat(5000), password: 'x' })).status).toBe(413);
  });

  it('signs up with only a display name and password, then logs in', async () => {
    const { backend, players } = fakeBackend();
    const signup = await call(backend, { action: 'signup', name: 'Alice', password: 'correct horse' });
    expect(signup.status).toBe(200);
    expect(signup.body).toMatchObject({ ok: true, player: { name: 'Alice' }, session: { access_token: 'at', refresh_token: 'rt' } });
    // 内部メールは本人入力ではなく、推測不能な値で作られる
    expect([...players.values()][0]!.email).toMatch(/^p[0-9a-f]{32}@players\.teruki\.example$/);

    const login = await call(backend, { action: 'login', name: 'alice', password: 'correct horse' });
    expect(login.status).toBe(200);
    expect(login.body.player).toMatchObject({ name: 'Alice' });
    expect(login.res.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects duplicate display names, including case/width variants', async () => {
    const { backend, calls } = fakeBackend();
    await call(backend, { action: 'signup', name: 'Bob', password: 'correct horse' });
    for (const name of ['bob', 'BOB', 'Ｂｏｂ']) {
      const res = await call(backend, { action: 'signup', name, password: 'another pass' });
      expect(res.status, name).toBe(409);
      expect(res.body.error).toBe('name_taken');
    }
    expect(calls.deleted).toHaveLength(0);       // 事前チェックで弾くので Auth ユーザーは作られない
  });

  it('cleans up the auth user when a concurrent sign-up wins the name', async () => {
    const { backend, calls } = fakeBackend();
    backend.nameAvailable = async () => true;    // 事前チェックをすり抜ける競合を再現
    backend.createPlayer = async () => {
      throw new Error('name_taken');
    };
    const res = await call(backend, { action: 'signup', name: 'Racer', password: 'correct horse' });
    expect(res.status).toBe(409);
    expect(calls.deleted).toHaveLength(1);
  });

  it('rejects invalid input with specific codes', async () => {
    const { backend } = fakeBackend();
    expect((await call(backend, { action: 'signup', name: 'x', password: 'correct horse' })).body).toMatchObject({ error: 'invalid_name', detail: 'length' });
    expect((await call(backend, { action: 'signup', name: 'Carol', password: 'weak' })).body).toMatchObject({ error: 'invalid_password', detail: 'length' });
    expect((await call(backend, { action: 'signup', name: 'Carol', password: 'password123' })).body).toMatchObject({ error: 'invalid_password', detail: 'weak' });
  });

  it('wrong password / unknown user give the same generic error', async () => {
    const { backend } = fakeBackend();
    await call(backend, { action: 'signup', name: 'Dave', password: 'correct horse' });
    const wrong = await call(backend, { action: 'login', name: 'Dave', password: 'wrong password' });
    const unknown = await call(backend, { action: 'login', name: 'Nobody', password: 'wrong password' });
    const malformed = await call(backend, { action: 'login', name: '<b>', password: 123 });
    for (const r of [wrong, unknown, malformed]) {
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ ok: false, error: 'bad_credentials' });
    }
  });

  it('locks a name after repeated failures, even with the right password, and unlocks after success reset', async () => {
    const { backend, counters } = fakeBackend();
    await call(backend, { action: 'signup', name: 'Erin', password: 'correct horse' });
    for (let i = 0; i < 5; i++) {
      expect((await call(backend, { action: 'login', name: 'Erin', password: `guess ${i} wrong` }, { 'x-forwarded-for': `10.0.0.${i}` })).status).toBe(401);
    }
    const locked = await call(backend, { action: 'login', name: 'Erin', password: 'correct horse' }, { 'x-forwarded-for': '10.9.9.9' });
    expect(locked.status).toBe(429);
    expect(locked.body).toMatchObject({ error: 'rate_limited', retry_after: 600 });
    expect(locked.res.headers.get('retry-after')).toBe('600');

    counters.clear();                                       // ロック時間が過ぎた
    expect((await call(backend, { action: 'login', name: 'Erin', password: 'bad one!!' })).status).toBe(401);
    expect((await call(backend, { action: 'login', name: 'Erin', password: 'correct horse' })).status).toBe(200);
    expect(counters.get('login:name:erin')).toBeUndefined();   // 成功で失敗カウンタはリセット
  });

  it('throttles one IP across many names', async () => {
    const { backend } = fakeBackend();
    for (let i = 0; i < 20; i++) {
      expect((await call(backend, { action: 'login', name: `victim${i}`, password: 'password guess' }, { 'x-forwarded-for': '198.51.100.1' })).status).toBe(401);
    }
    expect((await call(backend, { action: 'login', name: 'victim99', password: 'password guess' }, { 'x-forwarded-for': '198.51.100.1' })).status).toBe(429);
    expect((await call(backend, { action: 'login', name: 'victim99', password: 'password guess' }, { 'x-forwarded-for': '198.51.100.2' })).status).toBe(401);
  });

  it('limits sign-ups per IP', async () => {
    const { backend } = fakeBackend();
    for (let i = 0; i < 6; i++) {
      expect((await call(backend, { action: 'signup', name: `user${i}`, password: 'correct horse' }, { 'x-forwarded-for': '192.0.2.5' })).status).toBe(200);
    }
    expect((await call(backend, { action: 'signup', name: 'user7', password: 'correct horse' }, { 'x-forwarded-for': '192.0.2.5' })).status).toBe(429);
  });

  it('turns unexpected backend failures into a generic 500 without leaking details', async () => {
    const { backend } = fakeBackend();
    backend.nameAvailable = async () => {
      throw new Error('connection to db.internal:5432 refused');
    };
    const res = await call(backend, { action: 'signup', name: 'Frank', password: 'correct horse' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('db.internal');
  });
});
