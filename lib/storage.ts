import { Redis } from '@upstash/redis';

// 延遲初始化，避免建置時找不到環境變數
let _redis: Redis | null = null;
function getRedis(): Redis {
  if (!_redis) {
    _redis = Redis.fromEnv();
  }
  return _redis;
}

// 與 monitor/monitor.py 共用的 Redis key
const KEYS = {
  stocks: 'twstock:stocks',
  status: 'twstock:status',
  settings: 'twstock:settings',
  alerts: (date: string) => `twstock:alerts:${date}`,
};

export interface Stock {
  name: string;
  code: string;
  market: string; // tse / otc / emerging / ''（待偵測）
  yf_only?: boolean;
}

export interface StatusRow {
  code: string;
  name: string;
  market?: string;
  yf_only?: boolean;
  ok: boolean;
  price?: number;
  change?: number;
  pct?: number;
  delta?: number;
  threshold?: number;
  spike?: boolean;
  last_spike?: string | null;
  delayed?: boolean;
}

export interface Status {
  updated: string;
  running: boolean;
  market_open: boolean;
  threshold_ratio: number;
  rows: StatusRow[];
}

export interface Alert {
  time: string;
  code: string;
  name: string;
  price: number;
  pct: number;
  delta: number;
  threshold: number;
  emailed: boolean;
}

export interface Settings {
  email_to: string;
  threshold_ratio: number;
}

// 台灣時區的今天（YYYYMMDD），警報記錄以此分日
export function todayTW(): string {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  return s.replaceAll('-', '');
}

export async function getStocks(): Promise<Stock[]> {
  const data = await getRedis().get<Stock[]>(KEYS.stocks);
  return data ?? [];
}

export async function saveStocks(stocks: Stock[]): Promise<void> {
  await getRedis().set(KEYS.stocks, stocks);
}

export async function getStatus(): Promise<Status | null> {
  return (await getRedis().get<Status>(KEYS.status)) ?? null;
}

export async function getSettings(): Promise<Settings> {
  const data = await getRedis().get<Partial<Settings>>(KEYS.settings);
  return {
    email_to: data?.email_to ?? '',
    threshold_ratio: data?.threshold_ratio ?? 0.02,
  };
}

export async function saveSettings(s: Settings): Promise<void> {
  await getRedis().set(KEYS.settings, s);
}

export async function getTodayAlerts(): Promise<Alert[]> {
  const data = await getRedis().lrange<Alert>(KEYS.alerts(todayTW()), 0, 199);
  return data ?? [];
}
