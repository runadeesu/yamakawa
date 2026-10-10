import { MAX_LEVEL } from './config';

export interface LevelDef {
  level: number;
  name: string;
  radius: number;
  /** この Level が合体で生まれたときの基本スコア */
  score: number;
  /** リング色 (虹色の Final は accent を使わず sprite 側で描く) */
  ring: string;
  accent: string;
}

export const LEVELS: readonly LevelDef[] = [
  { level: 1, name: 'Mini Teruki', radius: 15, score: 1, ring: '#6ee7b7', accent: '#34d399' },
  { level: 2, name: 'Small Teruki', radius: 20, score: 3, ring: '#60c8ff', accent: '#2aa6f5' },
  { level: 3, name: 'Teruki', radius: 26, score: 6, ring: '#a3e635', accent: '#84cc16' },
  { level: 4, name: 'Big Teruki', radius: 33, score: 10, ring: '#ffd43b', accent: '#f5b700' },
  { level: 5, name: 'Super Teruki', radius: 42, score: 20, ring: '#ff9f43', accent: '#f97316' },
  { level: 6, name: 'Mega Teruki', radius: 53, score: 40, ring: '#ff5c8a', accent: '#e11d63' },
  { level: 7, name: 'Ultra Teruki', radius: 65, score: 80, ring: '#b57bff', accent: '#8b3dff' },
  { level: 8, name: 'Final Teruki', radius: 78, score: 200, ring: '#ffd43b', accent: '#ff3d71' },
];

export function levelDef(level: number): LevelDef {
  const idx = Math.min(MAX_LEVEL, Math.max(1, Math.round(level))) - 1;
  return LEVELS[idx] as LevelDef;
}
