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
  users: 'twstock:users',
  stocksOf: (user: string) => `twstock:stocks:${user}`,
  status: 'twstock:status',
  alertsOf: (user: string, date: string) => `twstock:alerts:${user}:${date}`,
  lastSpikeOf: (user: string) => `twstock:lastspike:${user}`,
  legacyStocks: 'twstock:stocks',
  legacySettings: 'twstock:settings',
};

export interface Stock {
  name: string;
  code: string;
  market: string; // tse / otc / emerging / ''（待偵測）
  yf_only?: boolean;
  lookup_at?: number; // 上次嘗試偵測市場的時間（ms），用來節流重試
}

export interface UserProfile {
  pw?: string; // sha256(`${user}:${password}`)；admin 用環境變數驗證，不存這欄
  email_to: string;
  threshold_ratio: number;
  created?: string;
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
  avg_vol?: number;
  delayed?: boolean;
}

export interface Status {
  updated: string;
  running: boolean;
  market_open: boolean;
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

// 台灣時區的今天（YYYYMMDD），警報記錄以此分日
export function todayTW(): string {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  return s.replaceAll('-', '');
}

// ─── 使用者 ────────────────────────────────────────────────────

export async function getUsers(): Promise<Record<string, UserProfile>> {
  const data = await getRedis().get<Record<string, UserProfile>>(KEYS.users);
  if (data && Object.keys(data).length > 0) return data;
  return migrateLegacy();
}

export async function saveUsers(users: Record<string, UserProfile>): Promise<void> {
  await getRedis().set(KEYS.users, users);
}

/** 第一次跑多使用者版：把舊單人資料遷移成 admin 帳號 */
async function migrateLegacy(): Promise<Record<string, UserProfile>> {
  const redis = getRedis();
  const legacySettings = await redis.get<{ email_to?: string; threshold_ratio?: number }>(
    KEYS.legacySettings
  );
  const users: Record<string, UserProfile> = {
    admin: {
      email_to: legacySettings?.email_to ?? '',
      threshold_ratio: legacySettings?.threshold_ratio ?? 0.02,
      created: new Date().toISOString(),
    },
  };
  await redis.set(KEYS.users, users);
  const legacyStocks = await redis.get<Stock[]>(KEYS.legacyStocks);
  if (legacyStocks?.length) {
    const existing = await redis.get<Stock[]>(KEYS.stocksOf('admin'));
    if (!existing) await redis.set(KEYS.stocksOf('admin'), legacyStocks);
  }
  return users;
}

export async function deleteUser(username: string): Promise<void> {
  const users = await getUsers();
  delete users[username];
  await saveUsers(users);
  await getRedis().del(KEYS.stocksOf(username));
}

// ─── 監控清單（每位使用者一份）────────────────────────────────

export async function getStocksOf(user: string): Promise<Stock[]> {
  const data = await getRedis().get<Stock[]>(KEYS.stocksOf(user));
  return data ?? [];
}

export async function saveStocksOf(user: string, stocks: Stock[]): Promise<void> {
  await getRedis().set(KEYS.stocksOf(user), stocks);
}

// ─── 全域狀態 / 個人警報 ──────────────────────────────────────

export async function getStatus(): Promise<Status | null> {
  return (await getRedis().get<Status>(KEYS.status)) ?? null;
}

export async function getTodayAlertsOf(user: string): Promise<Alert[]> {
  const data = await getRedis().lrange<Alert>(KEYS.alertsOf(user, todayTW()), 0, 199);
  return data ?? [];
}

/** 每檔最近一次觸發時間（跨日保留）：{code: ISO 時間} */
export async function getLastSpikeOf(user: string): Promise<Record<string, string>> {
  const data = await getRedis().get<Record<string, string>>(KEYS.lastSpikeOf(user));
  return data ?? {};
}
