import { describe, expect, it } from 'vitest';
import { createDb } from './helpers';

describe('migrations', () => {
  it('apply cleanly in order', async () => {
    const db = await createDb();
    const r = await db.query<{ n: number }>(`select count(*)::int as n from information_schema.tables where table_schema = 'public'`);
    expect(r.rows[0]!.n).toBeGreaterThan(8);
  });
});
