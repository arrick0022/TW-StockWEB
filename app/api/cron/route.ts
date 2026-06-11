import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Vercel Cron 備援觸發器（交易日台灣 08:25）：
// GitHub 的 schedule 不保證執行（新 repo 第一天尤其常見），
// 由這裡主動呼叫 GitHub API 啟動監控 workflow。
// 監控腳本自己有防重複機制（已在跑就直接退出），雙重觸發無害。
export async function GET(req: NextRequest) {
  // Vercel Cron 會自動帶 Authorization: Bearer ${CRON_SECRET}
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const pat = process.env.GITHUB_PAT;
  const repo = process.env.GITHUB_REPO ?? 'arrick0022/TW-StockWEB';
  if (!pat) {
    return NextResponse.json(
      { error: '未設定 GITHUB_PAT 環境變數，備援觸發未啟用' },
      { status: 500 }
    );
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/monitor.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'twstock-monitor-cron',
        },
        body: JSON.stringify({ ref: 'main', inputs: { mode: 'normal' } }),
      }
    );
    if (res.status === 204) {
      return NextResponse.json({ ok: true, triggered: true });
    }
    const detail = await res.text();
    return NextResponse.json(
      { error: `GitHub API 回應 ${res.status}`, detail },
      { status: 500 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: '觸發失敗', detail: String(err) },
      { status: 500 }
    );
  }
}
