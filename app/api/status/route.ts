import { NextRequest, NextResponse } from 'next/server';
import { authenticate, isAuthFailure } from '@/lib/auth';
import { getLastSpikeOf, getStatus, getStocksOf, getTodayAlertsOf } from '@/lib/storage';

export const dynamic = 'force-dynamic';

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
    return NextResponse.json({
      user: auth.user,
      isAdmin: auth.isAdmin,
      settings: {
        email_to: auth.profile.email_to,
        threshold_ratio: auth.profile.threshold_ratio,
      },
      stocks,
      status,
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
