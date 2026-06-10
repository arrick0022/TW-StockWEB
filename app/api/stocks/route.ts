import { NextRequest, NextResponse } from 'next/server';
import { authenticate, isAuthFailure } from '@/lib/auth';
import { getStocksOf, saveStocksOf, type Stock } from '@/lib/storage';
import { lookupStock } from '@/lib/twse';

export const dynamic = 'force-dynamic';

// 新增監控股票（自己的清單）
export async function POST(req: NextRequest) {
  try {
    const auth = await authenticate(req);
    if (isAuthFailure(auth)) return auth;

    const { code } = await req.json();
    const trimmed = String(code ?? '').trim();
    if (!/^\d{4,6}$/.test(trimmed)) {
      return NextResponse.json({ error: '請輸入 4~6 位數字的股票代號' }, { status: 400 });
    }
    const stocks = await getStocksOf(auth.user);
    if (stocks.some((s) => s.code === trimmed)) {
      return NextResponse.json({ error: `${trimmed} 已在監控清單中` }, { status: 400 });
    }
    if (stocks.length >= 30) {
      return NextResponse.json({ error: '監控清單最多 30 檔' }, { status: 400 });
    }
    // 先試著查名稱與市場；查不到就留空，雲端監控腳本會在 30 秒內自動補偵測
    const info = await lookupStock(trimmed);
    const stock: Stock = info ?? { name: trimmed, code: trimmed, market: '' };
    stocks.push(stock);
    await saveStocksOf(auth.user, stocks);
    return NextResponse.json({ ok: true, stock, pendingLookup: !info });
  } catch (err) {
    return NextResponse.json(
      { error: '新增失敗', detail: String(err) },
      { status: 500 }
    );
  }
}

// 移除監控股票（自己的清單）
export async function DELETE(req: NextRequest) {
  try {
    const auth = await authenticate(req);
    if (isAuthFailure(auth)) return auth;

    const code = req.nextUrl.searchParams.get('code') ?? '';
    const stocks = await getStocksOf(auth.user);
    const next = stocks.filter((s) => s.code !== code);
    if (next.length === stocks.length) {
      return NextResponse.json({ error: '清單中沒有這檔股票' }, { status: 404 });
    }
    await saveStocksOf(auth.user, next);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: '移除失敗', detail: String(err) },
      { status: 500 }
    );
  }
}
