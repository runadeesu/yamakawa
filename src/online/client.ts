import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { safeStorage } from '../storage';
import { ONLINE_ENABLED, SUPABASE_KEY, SUPABASE_URL } from './config';

let client: SupabaseClient | null = null;

/** 設定が無いとき・生成に失敗したときは null (オンライン機能だけが無効になる) */
export function getClient(): SupabaseClient | null {
  if (!ONLINE_ENABLED || !SUPABASE_URL || !SUPABASE_KEY) return null;
  if (client) return client;
  try {
    client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: safeStorage,
        storageKey: 'teruki_online_session',
      },
      realtime: { params: { eventsPerSecond: 10 } },
    });
  } catch (error) {
    console.warn('supabase client could not be created', error);
    client = null;
  }
  return client;
}
