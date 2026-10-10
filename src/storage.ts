import { STORAGE_KEYS } from './game/config';

/** localStorage が使えない環境 (プライベートモード等) でも動くようメモリにフォールバックする */
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, value: string): void {
  memory.set(key, value);
  try {
    globalThis.localStorage.setItem(key, value);
  } catch {
    /* メモリ側に保持済み */
  }
}

export function loadBest(): number {
  const n = Number(read(STORAGE_KEYS.best));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function saveBest(score: number): void {
  write(STORAGE_KEYS.best, String(Math.max(0, Math.floor(score))));
}

export function loadFlag(key: string): boolean {
  return read(key) !== '0';
}

export function saveFlag(key: string, value: boolean): void {
  write(key, value ? '1' : '0');
}

/** supabase-js の auth.storage に渡す。localStorage が使えない環境でもメモリで動く */
export const safeStorage = {
  getItem: (key: string): string | null => read(key),
  setItem: (key: string, value: string): void => write(key, value),
  removeItem: (key: string): void => {
    memory.delete(key);
    try {
      globalThis.localStorage.removeItem(key);
    } catch {
      /* メモリ側は削除済み */
    }
  },
};
