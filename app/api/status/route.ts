import { NextRequest, NextResponse } from 'next/server';
import { authenticate, isAuthFailure } from '@/lib/auth';
import {
  getLastSpikeOf,
  getStatus,
  getStocksOf,
  getTodayAlertsOf,
  saveStocksOf,
  type Status,
  type StatusRow,
  type Stock,
} from '@/lib/storage';
import { fetchMisQuotes, fetchYahooQuote, resolveStock, type LiveQuote } from '@/lib/twse';

export const dynamic = 'force-dynamic';

const LOOKUP_RETRY_MS = 10 * 60 * 1000; // 待偵測股票每 10 分鐘重試一次
const MAX_YF_LIVE = 10; // 即時補價時，興櫃股單檔查詢上限（避免拖慢回應）

/** 「偵測中」的股票：每 10 分鐘自動重試（MIS → Yahoo），成功就寫回清單 */
async function resolvePending(user: string, stocks: Stock[]): Promise<boolean> {
  const now = Date.now();
  const pending = stocks.filter(
    (s) => !s.market && now - (s.lookup_at ?? 0) > LOOKUP_RETRY_MS
  );
  if (pending.length === 0) return false;
  let changed = false;
  for (const s of pending.slice(0, 5)) {
    const info = await resolveStock(s.code);
    if (info) {
      Object.assign(s, info);
      delete s.lookup_at;
    } else {
      s.lookup_at = now;
    }
    changed = true;
  }
  if (changed) await saveStocksOf(user, stocks);
  return changed;
}

/** 快照裡沒有的股票（剛新增、或非監控時段）：網頁伺服器即時補抓報價 */
async function fetchLiveRows(missing: Stock[]): Promise<StatusRow[]> {
  if (missing.length === 0) return [];
  const misStocks = missing.filter((s) => !s.yf_only);
  const yfStocks = missing.filter((s) => s.yf_only).slice(0, MAX_YF_LIVE);

  const [misQuotes, yfQuotes] = await Promise.all([
    fetchMisQuotes(misStocks),
    Promise.all(yfStocks.map((s) => fetchYahooQuote(s.code, s.market))),
  ]);

  const rows: StatusRow[] = [];
  for (const s of missing) {
    let quote: LiveQuote | null = misQuotes[s.code] ?? null;
    if (!quote && s.yf_only) {
      const idx = yfStocks.indexOf(s);
      if (idx >= 0) quote = yfQuotes[idx];
    }
    if (!quote) {
      rows.push({ code: s.code, name: s.name, market: s.market, ok: false });
      continue;
    }
    const change = quote.price - quote.prev;
    rows.push({
      code: s.code,
      name: s.name,
      market: s.market,
      yf_only: s.yf_only,
      ok: true,
      price: Math.round(quote.price * 100) / 100,
      change: Math.round(change * 100) / 100,
      pct: Math.round((change / quote.prev) * 10000) / 100,
      delta: 0,
      avg_vol: 0, // 即時補價沒有均量資料 → 門檻顯示 —
      delayed: s.yf_only,
    });
  }
  return rows;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await authenticate(req);
    if (isAuthFailure(auth)) return auth;

    const [stocks, status, alerts, lastSpike] = await Promise.all([
      getStocksOf(auth.user),
      getStatus(),
      getTodayAlertsOf(auth.user),
      getLastSpikeOf(auth.user),
    ]);

    await resolvePending(auth.user, stocks);

    // 快照裡沒有報價的股票，即時補抓最後成交/收盤價
    const have = new Set((status?.rows ?? []).map((r) => r.code));
    const missing = stocks.filter((s) => s.market && !have.has(s.code));
    const liveRows = await fetchLiveRows(missing);
    const merged: Status = {
      updated: status?.updated ?? '',
      running: status?.running ?? false,
      market_open: status?.market_open ?? false,
      rows: [...(status?.rows ?? []), ...liveRows],
    };

    return NextResponse.json({
      user: auth.user,
      isAdmin: auth.isAdmin,
      settings: {
        email_to: auth.profile.email_to,
        threshold_ratio: auth.profile.threshold_ratio,
      },
      stocks,
      status: merged,
      alerts,
      lastSpike,
    });
  } catch (err) {
    return NextResponse.json(
      { error: '讀取資料失敗', detail: String(err) },
      { status: 500 }
    );
  }
}
