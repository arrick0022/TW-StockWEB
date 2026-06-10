import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getUsers, type UserProfile } from './storage';

export interface AuthInfo {
  user: string;
  isAdmin: boolean;
  profile: UserProfile;
}

export function hashPassword(username: string, password: string): string {
  return createHash('sha256').update(`${username}:${password}`).digest('hex');
}

/**
 * 驗證 x-user / x-pass header（網頁登入後存在 localStorage 自動附上）。
 * admin 用環境變數 ADMIN_PASSWORD 驗證；其他帳號比對 Redis 中的密碼雜湊。
 * 回傳 AuthInfo，或失敗時回傳可直接 return 的 NextResponse。
 */
export async function authenticate(req: NextRequest): Promise<AuthInfo | NextResponse> {
  const user = (req.headers.get('x-user') ?? '').trim();
  const pass = req.headers.get('x-pass') ?? '';
  if (!user || !pass) {
    return NextResponse.json({ error: '請輸入帳號與密碼' }, { status: 401 });
  }

  const users = await getUsers();

  if (user === 'admin') {
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) {
      return NextResponse.json(
        { error: '伺服器未設定 ADMIN_PASSWORD 環境變數' },
        { status: 500 }
      );
    }
    if (pass !== expected) {
      return NextResponse.json({ error: '帳號或密碼錯誤' }, { status: 401 });
    }
    const profile = users.admin ?? { email_to: '', threshold_ratio: 0.02 };
    return { user: 'admin', isAdmin: true, profile };
  }

  const profile = users[user];
  if (!profile?.pw || profile.pw !== hashPassword(user, pass)) {
    return NextResponse.json({ error: '帳號或密碼錯誤' }, { status: 401 });
  }
  return { user, isAdmin: false, profile };
}

export function isAuthFailure(r: AuthInfo | NextResponse): r is NextResponse {
  return r instanceof NextResponse;
}
