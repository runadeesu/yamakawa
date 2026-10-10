export const SUPABASE_URL: string | undefined = import.meta.env.VITE_SUPABASE_URL;
export const SUPABASE_KEY: string | undefined = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

/** URL と公開キーが設定されているときだけオンライン機能を有効にする (未設定でもゲーム本体は動く) */
export const ONLINE_ENABLED = Boolean(SUPABASE_URL && SUPABASE_KEY);

/** 生存確認 (オンライン表示)・未読数などの更新間隔 */
export const HEARTBEAT_MS = 25_000;
/** リアルタイム通信が使えないときの更新間隔 */
export const DEGRADED_POLL_MS = 6_000;
export const MATCH_SEARCH_HINT_S = 40;
