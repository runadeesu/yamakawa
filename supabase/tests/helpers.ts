import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);

export async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(readFileSync(new URL('tests/bootstrap.sql', root), 'utf8'));
  const dir = new URL('migrations/', root);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await db.exec(readFileSync(new URL(file, dir), 'utf8'));
    } catch (error) {
      throw new Error(`migration ${file} failed: ${(error as Error).message}`);
    }
  }
  return db;
}

type Role = 'anon' | 'authenticated' | 'service_role';

/** 指定ロール・ユーザーとして 1 回だけ SQL を実行する (PostgREST + JWT と同じ前提)。 */
export async function runAs<T = Record<string, unknown>>(
  db: PGlite,
  role: Role,
  userId: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
  await db.exec(`set role ${role}`);
  try {
    const result = await db.query<T>(sql, params);
    return result.rows;
  } finally {
    await db.exec('reset role');
  }
}

export class Player {
  readonly db: PGlite;
  readonly id: string;
  readonly name: string;
  code = '';

  constructor(db: PGlite, id: string, name: string) {
    this.db = db;
    this.id = id;
    this.name = name;
  }

  /** public.<fn>(args) を RPC として呼ぶ。エラーは error.message (= エラーコード) で投げる */
  async rpc<T = any>(fn: string, ...args: unknown[]): Promise<T> {
    const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
    const rows = await runAs<{ r: T }>(this.db, 'authenticated', this.id, `select public.${fn}(${placeholders}) as r`, args);
    return rows[0]?.r as T;
  }

  sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
    return runAs<T>(this.db, 'authenticated', this.id, query, params);
  }

  async errorOf(fn: string, ...args: unknown[]): Promise<string> {
    try {
      await this.rpc(fn, ...args);
    } catch (error) {
      return (error as Error).message;
    }
    return 'NO_ERROR';
  }
}

let counter = 0;

/** サインアップ相当: auth.users (admin 作成) → svc_create_player */
export async function makePlayer(db: PGlite, name: string): Promise<Player> {
  counter++;
  const email = `p${counter}-${Math.random().toString(16).slice(2)}@players.invalid`;
  const user = await db.query<{ id: string }>(
    `insert into auth.users (email, raw_app_meta_data) values ($1, '{"teruki":"1"}') returning id`,
    [email],
  );
  const id = user.rows[0]!.id;
  const rows = await runAs<{ r: { code: string } }>(
    db,
    'service_role',
    null,
    `select public.svc_create_player($1, $2, $3, $4) as r`,
    [id, name, name.normalize('NFKC').toLowerCase(), email],
  );
  await db.query(`update app_private.presence set last_seen = now() - interval '10 minutes' where player_id = $1`, [id]);   // 登録直後はオフライン扱いにして始める
  const p = new Player(db, id, name);
  p.code = rows[0]!.r.code;
  return p;
}

/** 心拍を送ってオンラインにする */
export async function online(...players: Player[]): Promise<void> {
  for (const p of players) await p.rpc('heartbeat');
}

export async function makeFriends(a: Player, b: Player): Promise<void> {
  const res = await a.rpc('friend_request_send', b.id);
  await b.rpc('friend_request_respond', res.id, true);
}
