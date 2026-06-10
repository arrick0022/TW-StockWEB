import { NextRequest, NextResponse } from 'next/server';
import { authenticate, isAuthFailure } from '@/lib/auth';
import { getUsers, saveUsers } from '@/lib/storage';

export const dynamic = 'force-dynamic';

// 更新自己的通知設定
export async function POST(req: NextRequest) {
  try {
    const auth = await authenticate(req);
    if (isAuthFailure(auth)) return auth;

    const body = await req.json();
    const emailTo = String(body.email_to ?? '').trim();
    const ratio = Number(body.threshold_ratio);
    if (emailTo && !emailTo.split(',').every((e: string) => e.trim().includes('@'))) {
      return NextResponse.json({ error: '收件人格式不正確' }, { status: 400 });
    }
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
      return NextResponse.json({ error: '門檻比例須介於 0 與 1 之間' }, { status: 400 });
    }
    const users = await getUsers();
    const profile = users[auth.user] ?? { email_to: '', threshold_ratio: 0.02 };
    users[auth.user] = { ...profile, email_to: emailTo, threshold_ratio: ratio };
    await saveUsers(users);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: '儲存失敗', detail: String(err) },
      { status: 500 }
    );
  }
}
