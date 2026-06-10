import { NextRequest, NextResponse } from 'next/server';

// 所有 API 都要帶 x-admin-key（網頁登入後存在 localStorage 自動附上）
export function checkAuth(req: NextRequest): NextResponse | null {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return NextResponse.json(
      { error: '伺服器未設定 ADMIN_PASSWORD 環境變數' },
      { status: 500 }
    );
  }
  if (req.headers.get('x-admin-key') !== expected) {
    return NextResponse.json({ error: '密碼錯誤' }, { status: 401 });
  }
  return null;
}
