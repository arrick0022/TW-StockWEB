// 股票查詢與報價（網頁端用）
// - lookupStock：證交所 MIS 查名稱與市場
// - lookupStockYahoo：MIS 查無時的 Yahoo 備援（興櫃股）
// - fetchMisQuotes / fetchYahooQuote：非監控時段網頁即時補抓報價用
// Vercel 主機在國外，任何查詢失敗都安全降級：market 留空，
// 雲端監控腳本下一輪（30 秒內）會自動補偵測。

const MIS_URL = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

export interface LookupResult {
  name: string;
  code: string;
  market: string;
  yf_only?: boolean;
}

export interface LiveQuote {
  price: number;
  prev: number;
}

export async function lookupStock(code: string): Promise<LookupResult | null> {
  for (const market of ['tse', 'otc', 'emerging']) {
    try {
      const params = new URLSearchParams({
        ex_ch: `${market}_${code}.tw`,
        json: '1',
        delay: '0',
      });
      const res = await fetch(`${MIS_URL}?${params}`, {
        headers: { ...UA, Referer: 'https://mis.twse.com.tw/' },
        signal: AbortSignal.timeout(5000),
        cache: 'no-store',
      });
      const data = await res.json();
      const msg = data?.msgArray?.[0];
      const name = (msg?.n ?? '').trim();
      if (name) {
        const hasPrice = msg.y && msg.y !== '-';
        const info: LookupResult = { name, code, market };
        if (!hasPrice) info.yf_only = true;
        return info;
      }
    } catch {
      // 換下一個市場或放棄
    }
  }
  return null;
}

interface ChartMeta {
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  shortName?: string;
}

async function fetchChartMeta(symbol: string): Promise<ChartMeta | null> {
  try {
    const res = await fetch(`${YAHOO_CHART}${symbol}?range=1d&interval=1d`, {
      headers: UA,
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    });
    const json = await res.json();
    return json?.chart?.result?.[0]?.meta ?? null;
  } catch {
    return null;
  }
}

/** MIS 查無時的備援：用 Yahoo 判斷市場（興櫃股多半掛 .TWO） */
export async function lookupStockYahoo(code: string): Promise<LookupResult | null> {
  for (const [suffix, market] of [
    ['.TWO', 'otc'],
    ['.TW', 'tse'],
  ] as const) {
    const meta = await fetchChartMeta(code + suffix);
    if (meta?.regularMarketPrice) {
      return { name: meta.shortName?.trim() || code, code, market, yf_only: true };
    }
  }
  return null;
}

/** MIS 優先、Yahoo 備援（與雲端監控腳本同樣順序） */
export async function resolveStock(code: string): Promise<LookupResult | null> {
  return (await lookupStock(code)) ?? (await lookupStockYahoo(code));
}

/** 批次抓 MIS 報價（現價來源順序與監控腳本一致：z → b1 → o → y） */
export async function fetchMisQuotes(
  stocks: { code: string; market: string }[]
): Promise<Record<string, LiveQuote>> {
  const result: Record<string, LiveQuote> = {};
  if (stocks.length === 0) return result;
  const exCh = stocks.map((s) => `${s.market}_${s.code}.tw`).join('|');
  try {
    const params = new URLSearchParams({ ex_ch: exCh, json: '1', delay: '0' });
    const res = await fetch(`${MIS_URL}?${params}`, {
      headers: { ...UA, Referer: 'https://mis.twse.com.tw/' },
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    });
    const data = await res.json();
    for (const msg of data?.msgArray ?? []) {
      const code = msg.c ?? '';
      const prev = Number(msg.y) || 0;
      let price = 0;
      if (msg.z && msg.z !== '-') price = Number(msg.z) || 0;
      if (!price && msg.b) price = Number(String(msg.b).split('_')[0]) || 0;
      if (!price && msg.o && msg.o !== '-') price = Number(msg.o) || 0;
      if (!price) price = prev;
      if (price && prev) result[code] = { price, prev };
    }
  } catch {
    // 失敗就空手而回，前端顯示 —
  }
  return result;
}

/** 興櫃股（yf_only）單檔報價：Yahoo chart meta */
export async function fetchYahooQuote(
  code: string,
  market: string
): Promise<LiveQuote | null> {
  const suffix = market === 'tse' ? '.TW' : '.TWO';
  const meta = await fetchChartMeta(code + suffix);
  const price = meta?.regularMarketPrice ?? 0;
  const prev = meta?.chartPreviousClose ?? 0;
  if (!price || !prev) return null;
  return { price, prev };
}
