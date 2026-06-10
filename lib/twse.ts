// 證交所 MIS API 查詢股票名稱與市場（新增股票時用）
// Vercel 主機在國外，若連不上也沒關係：market 留空，
// 雲端監控腳本下一輪（30 秒內）會自動補偵測。

const MIS_URL = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';

export interface LookupResult {
  name: string;
  code: string;
  market: string;
  yf_only?: boolean;
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
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          Referer: 'https://mis.twse.com.tw/',
        },
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
