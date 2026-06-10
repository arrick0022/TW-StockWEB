import { NextRequest, NextResponse } from 'next/server';
import { authenticate, hashPassword, isAuthFailure } from '@/lib/auth';
import { deleteUser, getUsers, saveUsers } from '@/lib/storage';

export const dynamic = 'force-dynamic';

async function requireAdmin(req: NextRequest) {
  const auth = await authenticate(req);
  if (isAuthFailure(auth)) return auth;
  if (!auth.isAdmin) {
    return NextResponse.json({ error: '只有 admin 可以管理帳號' }, { status: 403 });
  }
  return auth;
}

// 帳號列表（admin 專用）
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (isAuthFailure(auth)) return auth;
    const users = await getUsers();
    const list = Object.entries(users).map(([username, p]) => ({
      username,
      email_to: p.email_to,
      threshold_ratio: p.threshold_ratio,
      created: p.created,
    }));
    return NextResponse.json({ users: list });
  } catch (err) {
    return NextResponse.json({ error: '讀取失敗', detail: String(err) }, { status: 500 });
  }
}

// 建立帳號或重設密碼（admin 專用）
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (isAuthFailure(auth)) return auth;

    const body = await req.json();
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    const emailTo = String(body.email_to ?? '').trim();

    if (!/^[a-zA-Z0-9_-]{2,20}$/.test(username)) {
      return NextResponse.json(
        { error: '帳號限 2~20 字的英數、底線、連字號' },
        { status: 400 }
      );
    }
    if (username === 'admin') {
      return NextResponse.json(
        { error: 'admin 的密碼在 Vercel 環境變數 ADMIN_PASSWORD 修改' },
        { status: 400 }
      );
    }
    if (password.length < 6) {
      return NextResponse.json({ error: '密碼至少 6 個字' }, { status: 400 });
    }

    const users = await getUsers();
    const existed = !!users[username];
    const prev = users[username];
    users[username] = {
      pw: hashPassword(username, password),
      email_to: emailTo || prev?.email_to || '',
      threshold_ratio: prev?.threshold_ratio ?? 0.02,
      created: prev?.created ?? new Date().toISOString(),
    };
    await saveUsers(users);
    return NextResponse.json({ ok: true, updated: existed });
  } catch (err) {
    return NextResponse.json({ error: '儲存失敗', detail: String(err) }, { status: 500 });
  }
}

// 刪除帳號（admin 專用）
export async function DELETE(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (isAuthFailure(auth)) return auth;

    const username = req.nextUrl.searchParams.get('username') ?? '';
    if (username === 'admin') {
      return NextResponse.json({ error: '不能刪除 admin' }, { status: 400 });
    }
    const users = await getUsers();
    if (!users[username]) {
      return NextResponse.json({ error: '帳號不存在' }, { status: 404 });
    }
    await deleteUser(username);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: '刪除失敗', detail: String(err) }, { status: 500 });
  }
}
