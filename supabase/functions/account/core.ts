/**
 * アカウント (表示名 + パスワードのみ。メールアドレス・電話番号は一切扱わない)。
 *
 * サインアップ/ログインは必ずこの関数を通す:
 *   - 表示名の検証・正規化・重複防止
 *   - パスワード強度の検証
 *   - ログイン試行のレート制限 (表示名ごと / IP ごと)
 *   - Supabase Auth には「ユーザーに見せない推測不能な内部メール」で登録する
 *
 * Deno / Node のどちらでも動くよう、外部依存は Backend インターフェースに閉じ込めている。
 */

export interface SessionData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number;
  token_type: string;
}

export interface PlayerData {
  id: string;
  name: string;
  code: string;
}

export interface Backend {
  nameAvailable(nameKey: string): Promise<boolean>;
  /** Auth ユーザーを作る (メール確認済み・app_metadata.teruki = '1')。失敗時は throw */
  createAuthUser(email: string, password: string): Promise<{ id: string }>;
  deleteAuthUser(id: string): Promise<void>;
  /** players 行を作る。表示名が競合したら Error('name_taken') */
  createPlayer(id: string, name: string, nameKey: string, authEmail: string): Promise<PlayerData>;
  loginLookup(nameKey: string): Promise<{ player_id: string; auth_email: string; name: string; code: string } | null>;
  /** パスワードが違うときは null、それ以外の失敗は throw */
  signIn(email: string, password: string): Promise<SessionData | null>;
  rate: {
    peek(key: string, max: number, windowSecs: number): Promise<{ allowed: boolean; retry_after: number }>;
    hit(key: string, windowSecs: number): Promise<void>;
    reset(key: string): Promise<void>;
  };
  randomHex(bytes: number): string;
  hashIp(ip: string): Promise<string>;
  sleep(ms: number): Promise<void>;
}

export const LIMITS = {
  signupPerIp: { max: 6, windowSecs: 3600 },
  loginPerName: { max: 5, windowSecs: 900 },
  loginPerIp: { max: 20, windowSecs: 900 },
  maxBodyBytes: 2048,
} as const;

export const EMAIL_DOMAIN = 'players.teruki.example';

const NAME_RE = /^[A-Za-z0-9_\-\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー々]+$/u;
const RESERVED = new Set(['admin', 'administrator', 'system', 'support', 'staff', 'moderator', 'official', 'null', 'undefined', '運営', '管理者', '公式']);
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', '11111111', '00000000', 'qwertyui', 'qwerty123',
  'iloveyou', 'abcd1234', 'abc12345', 'letmein1', 'admin123', 'welcome1', 'monkey123', 'dragon123', 'baseball', 'football',
  'passw0rd', 'p@ssw0rd', 'teruki123', 'terukigame', 'yamakawa1',
]);

/** 全角→半角などを NFKC で揃え、ASCII 英字だけ小文字化したキー (重複判定・ログイン識別子) */
export function nameKeyOf(name: string): string {
  return name.normalize('NFKC').replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export type NameCheck = { ok: true; name: string; key: string } | { ok: false; detail: 'type' | 'length' | 'chars' | 'reserved' };

export function checkName(raw: unknown): NameCheck {
  if (typeof raw !== 'string') return { ok: false, detail: 'type' };
  const name = raw.normalize('NFKC').trim();
  const length = [...name].length;
  if (length < 2 || length > 16) return { ok: false, detail: 'length' };
  if (!NAME_RE.test(name)) return { ok: false, detail: 'chars' };
  const key = nameKeyOf(name);
  if (RESERVED.has(key) || key.startsWith('admin')) return { ok: false, detail: 'reserved' };
  return { ok: true, name, key };
}

export type PasswordCheck = { ok: true } | { ok: false; detail: 'type' | 'length' | 'chars' | 'weak' };

export function checkPassword(raw: unknown, nameKey: string): PasswordCheck {
  if (typeof raw !== 'string') return { ok: false, detail: 'type' };
  const bytes = new TextEncoder().encode(raw).length;
  if ([...raw].length < 8 || bytes > 72) return { ok: false, detail: 'length' };   // bcrypt は 72 バイトまで
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, detail: 'chars' };
  const lower = raw.normalize('NFKC').toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || lower === nameKey || new Set([...raw]).size === 1) return { ok: false, detail: 'weak' };
  return { ok: true };
}

type ErrorBody = { ok: false; error: string; detail?: string; retry_after?: number };

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-max-age': '86400',
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

const fail = (status: number, error: string, extra: Partial<ErrorBody> = {}): Response =>
  json(status, { ok: false, error, ...extra } satisfies ErrorBody, extra.retry_after ? { 'retry-after': String(extra.retry_after) } : {});

function clientIp(req: Request): string {
  const forwarded = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for') ?? '';
  return forwarded.split(',')[0]?.trim() || 'unknown';
}

export async function handleAccount(req: Request, backend: Backend): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return fail(405, 'bad_request');

  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > LIMITS.maxBodyBytes) return fail(413, 'bad_request');
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > LIMITS.maxBodyBytes) return fail(413, 'bad_request');
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fail(400, 'bad_request');
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(400, 'bad_request');
  }

  try {
    const ipHash = await backend.hashIp(clientIp(req));
    if (body.action === 'signup') return await signup(body, ipHash, backend);
    if (body.action === 'login') return await login(body, ipHash, backend);
    return fail(400, 'bad_request');
  } catch (error) {
    console.error('account function error', error instanceof Error ? error.message : error);
    return fail(500, 'server_error');
  }
}

async function signup(body: Record<string, unknown>, ipHash: string, backend: Backend): Promise<Response> {
  const name = checkName(body.name);
  if (!name.ok) return fail(400, 'invalid_name', { detail: name.detail });
  const password = checkPassword(body.password, name.key);
  if (!password.ok) return fail(400, 'invalid_password', { detail: password.detail });

  const ipKey = `signup:ip:${ipHash}`;
  const gate = await backend.rate.peek(ipKey, LIMITS.signupPerIp.max, LIMITS.signupPerIp.windowSecs);
  if (!gate.allowed) return fail(429, 'rate_limited', { retry_after: gate.retry_after });
  await backend.rate.hit(ipKey, LIMITS.signupPerIp.windowSecs);

  if (!(await backend.nameAvailable(name.key))) return fail(409, 'name_taken');

  const email = `p${backend.randomHex(16)}@${EMAIL_DOMAIN}`;
  const user = await backend.createAuthUser(email, body.password as string);
  let player: PlayerData;
  try {
    player = await backend.createPlayer(user.id, name.name, name.key, email);
  } catch (error) {
    await backend.deleteAuthUser(user.id).catch(() => undefined);
    if (error instanceof Error && error.message.includes('name_taken')) return fail(409, 'name_taken');
    throw error;
  }
  const session = await backend.signIn(email, body.password as string);
  if (!session) throw new Error('sign-in right after sign-up failed');
  return json(200, { ok: true, session, player });
}

async function login(body: Record<string, unknown>, ipHash: string, backend: Backend): Promise<Response> {
  const name = checkName(body.name);
  // 形式が不正な表示名・パスワードも「認証失敗」と同じ扱い (アカウントの有無を漏らさない)
  const key = name.ok ? name.key : '';
  const nameKey = `login:name:${key || 'invalid'}`;
  const ipKey = `login:ip:${ipHash}`;

  const [byName, byIp] = await Promise.all([
    backend.rate.peek(nameKey, LIMITS.loginPerName.max, LIMITS.loginPerName.windowSecs),
    backend.rate.peek(ipKey, LIMITS.loginPerIp.max, LIMITS.loginPerIp.windowSecs),
  ]);
  if (!byName.allowed || !byIp.allowed) {
    return fail(429, 'rate_limited', { retry_after: Math.max(byName.retry_after, byIp.retry_after) });
  }

  const reject = async (): Promise<Response> => {
    await Promise.all([backend.rate.hit(nameKey, LIMITS.loginPerName.windowSecs), backend.rate.hit(ipKey, LIMITS.loginPerIp.windowSecs)]);
    return fail(401, 'bad_credentials');
  };

  if (!name.ok || typeof body.password !== 'string' || body.password.length === 0 || body.password.length > 200) {
    await backend.sleep(150);
    return reject();
  }
  const found = await backend.loginLookup(name.key);
  if (!found) {
    await backend.sleep(200);   // 存在しない表示名でも応答時間があまり変わらないように
    return reject();
  }
  const session = await backend.signIn(found.auth_email, body.password);
  if (!session) return reject();

  await backend.rate.reset(nameKey);
  return json(200, { ok: true, session, player: { id: found.player_id, name: found.name, code: found.code } satisfies PlayerData });
}
