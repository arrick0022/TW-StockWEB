import { NextRequest, NextResponse } from 'next/server';
import { checkAuth } from '@/lib/auth';
import { getStocks, getStatus, getSettings, getTodayAlerts } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = checkAuth(req);
  if (denied) return denied;
  try {
    const [stocks, status, settings, alerts] = await Promise.all([
      getStocks(),
      getStatus(),
      getSettings(),
      getTodayAlerts(),
    ]);
    return NextResponse.json({ stocks, status, settings, alerts });
  } catch (err) {
    return NextResponse.json(
      { error: '讀取資料失敗', detail: String(err) },
      { status: 500 }
    );
  }
}
