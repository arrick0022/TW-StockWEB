import { NextRequest, NextResponse } from 'next/server';
import { checkAuth } from '@/lib/auth';
import { saveSettings } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const denied = checkAuth(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    const emailTo = String(body.email_to ?? '').trim();
    const ratio = Number(body.threshold_ratio);
    if (emailTo && !emailTo.split(',').every((e: string) => e.trim().includes('@'))) {
      return NextResponse.json({ error: '收件人格式不正確' }, { status: 400 });
    }
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
      return NextResponse.json({ error: '門檻比例須介於 0 與 1 之間' }, { status: 400 });
    }
    await saveSettings({ email_to: emailTo, threshold_ratio: ratio });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: '儲存失敗', detail: String(err) },
      { status: 500 }
    );
  }
}
