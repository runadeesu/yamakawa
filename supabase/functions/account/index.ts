// Supabase Edge Function (Deno): POST /functions/v1/account  { action: 'signup' | 'login', name, password }
// verify_jwt = false (ログイン前に呼ぶため)。認可は core.ts の検証・レート制限が担う。
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleAccount, type Backend } from './core.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const admin = createClient(url, serviceKey, noSession);

const toHex = (buf: ArrayBuffer | Uint8Array) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

const backend: Backend = {
  nameAvailable: (nameKey) => rpc<boolean>('svc_name_available', { p_name_key: nameKey }),
  async createAuthUser(email, password) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { teruki: '1' },
    });
    if (error || !data.user) throw new Error(`createUser failed: ${error?.message ?? 'no user'}`);
    return { id: data.user.id };
  },
  async deleteAuthUser(id) {
    await admin.auth.admin.deleteUser(id);
  },
  createPlayer: (id, name, nameKey, authEmail) =>
    rpc('svc_create_player', { p_user_id: id, p_name: name, p_name_key: nameKey, p_auth_email: authEmail }),
  loginLookup: (nameKey) => rpc('svc_login_lookup', { p_name_key: nameKey }),
  async signIn(email, password) {
    const anon = createClient(url, anonKey, noSession);
    const { data, error } = await anon.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.status === 400 || error.code === 'invalid_credentials') return null;
      throw new Error(`signIn failed: ${error.message}`);
    }
    const s = data.session;
    return { access_token: s.access_token, refresh_token: s.refresh_token, expires_in: s.expires_in, expires_at: s.expires_at, token_type: s.token_type };
  },
  rate: {
    peek: (key, max, windowSecs) => rpc('svc_rate_peek', { p_key: key, p_max: max, p_window_secs: windowSecs }),
    hit: async (key, windowSecs) => {
      await rpc('svc_rate_hit', { p_key: key, p_window_secs: windowSecs });
    },
    reset: async (key) => {
      await rpc('svc_rate_reset', { p_key: key });
    },
  },
  randomHex: (bytes) => toHex(crypto.getRandomValues(new Uint8Array(bytes))),
  async hashIp(ip) {
    const data = new TextEncoder().encode(`${serviceKey.slice(-24)}:${ip}`);   // サービスキーを胡椒にして IP をハッシュ化 (生の IP は保存しない)
    return toHex(await crypto.subtle.digest('SHA-256', data)).slice(0, 32);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

Deno.serve((req) => handleAccount(req, backend));
