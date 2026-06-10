'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Alert, Settings, Status, Stock } from '@/lib/storage';

const KEY_STORAGE = 'twstock_admin_key';
const POLL_MS = 5000;

interface ApiData {
  stocks: Stock[];
  status: Status | null;
  settings: Settings;
  alerts: Alert[];
}

const MKT_LABEL: Record<string, string> = {
  tse: '上市',
  otc: '上櫃',
  emerging: '興櫃',
  '': '偵測中',
};

function fmtTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-TW', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Taipei',
  });
}

export default function Home() {
  const [adminKey, setAdminKey] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [authed, setAuthed] = useState(false);
  const [loginMsg, setLoginMsg] = useState('');
  const [data, setData] = useState<ApiData | null>(null);
  const [addCode, setAddCode] = useState('');
  const [addMsg, setAddMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [emailTo, setEmailTo] = useState('');
  const [ratioPct, setRatioPct] = useState('2');
  const [settingsMsg, setSettingsMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const settingsLoaded = useRef(false);

  const api = useCallback(
    async (path: string, init: RequestInit = {}, key?: string) => {
      const res = await fetch(path, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': key ?? adminKey,
          ...init.headers,
        },
        cache: 'no-store',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      return json;
    },
    [adminKey]
  );

  const refresh = useCallback(
    async (key?: string) => {
      const json = (await api('/api/status', {}, key)) as ApiData;
      setData(json);
      if (!settingsLoaded.current) {
        settingsLoaded.current = true;
        setEmailTo(json.settings.email_to);
        setRatioPct(String(json.settings.threshold_ratio * 100));
      }
      return json;
    },
    [api]
  );

  // 自動登入（localStorage 有存密碼就直接試）
  useEffect(() => {
    const saved = localStorage.getItem(KEY_STORAGE);
    if (!saved) return;
    refresh(saved)
      .then(() => {
        setAdminKey(saved);
        setAuthed(true);
      })
      .catch(() => localStorage.removeItem(KEY_STORAGE));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 每 5 秒輪詢狀態
  useEffect(() => {
    if (!authed) return;
    const t = setInterval(() => {
      refresh().catch(() => {});
    }, POLL_MS);
    return () => clearInterval(t);
  }, [authed, refresh]);

  async function login() {
    setLoginMsg('');
    try {
      await refresh(keyInput);
      localStorage.setItem(KEY_STORAGE, keyInput);
      setAdminKey(keyInput);
      setAuthed(true);
    } catch (e) {
      setLoginMsg(e instanceof Error ? e.message : '登入失敗');
    }
  }

  async function addStock() {
    const code = addCode.trim();
    if (!/^\d{4,6}$/.test(code)) {
      setAddMsg({ text: '請輸入 4~6 位數字的股票代號', ok: false });
      return;
    }
    setBusy(true);
    setAddMsg(null);
    try {
      const r = await api('/api/stocks', { method: 'POST', body: JSON.stringify({ code }) });
      setAddMsg({
        text: r.pendingLookup
          ? `已加入 ${code}，名稱與市場將由雲端監控自動偵測`
          : `已加入「${r.stock.name}」（${code}）`,
        ok: true,
      });
      setAddCode('');
      await refresh();
    } catch (e) {
      setAddMsg({ text: e instanceof Error ? e.message : '新增失敗', ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function removeStock(stock: Stock) {
    if (!confirm(`確定要移除「${stock.name}」（${stock.code}）的監控嗎？`)) return;
    try {
      await api(`/api/stocks?code=${stock.code}`, { method: 'DELETE' });
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : '移除失敗');
    }
  }

  async function saveSettings() {
    setSettingsMsg(null);
    const ratio = Number(ratioPct) / 100;
    try {
      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ email_to: emailTo, threshold_ratio: ratio }),
      });
      setSettingsMsg({ text: '已儲存（監控端 30 秒內生效）', ok: true });
    } catch (e) {
      setSettingsMsg({ text: e instanceof Error ? e.message : '儲存失敗', ok: false });
    }
  }

  function logout() {
    localStorage.removeItem(KEY_STORAGE);
    setAuthed(false);
    setAdminKey('');
    setData(null);
    settingsLoaded.current = false;
  }

  // ── 登入畫面 ──────────────────────────────────────────────
  if (!authed) {
    return (
      <div className="login-box">
        <h1 style={{ color: '#1a3a5c' }}>📈 台股盤中巨量監控</h1>
        <input
          type="password"
          placeholder="管理密碼"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && login()}
        />
        <button onClick={login}>登入</button>
        {loginMsg && <p className="msg err" style={{ marginTop: 8 }}>{loginMsg}</p>}
      </div>
    );
  }

  // ── 主畫面 ────────────────────────────────────────────────
  const status = data?.status ?? null;
  const fresh =
    !!status?.updated && Date.now() - new Date(status.updated).getTime() < 60_000;
  const monitorOn = !!status?.running && fresh;
  const rowByCode = new Map((status?.rows ?? []).map((r) => [r.code, r]));
  const stocks = data?.stocks ?? [];
  const alerts = data?.alerts ?? [];

  return (
    <>
      <div className="header">
        <h1>📈 台股盤中巨量監控</h1>
        <div className="row">
          <span className={`badge ${monitorOn ? 'on' : 'off'}`}>
            {monitorOn
              ? `● 雲端監控執行中（${fmtTime(status?.updated)} 更新）`
              : '○ 監控未執行（交易日 08:55 雲端自動啟動）'}
          </span>
          <button className="btn-plain" style={{ fontSize: 12, padding: '4px 10px' }} onClick={logout}>
            登出
          </button>
        </div>
      </div>
      <div className="infobar">
        資料來源：證交所 / 櫃買中心即時 API｜觸發條件：5秒成交量 ≥ 5日均量 ×{' '}
        {(Number(status?.threshold_ratio ?? data?.settings.threshold_ratio ?? 0.02) * 100).toFixed(1)}
        %｜觸發時自動寄 Email
      </div>

      <div className="container">
        {/* 新增股票 */}
        <div className="card">
          <div className="row">
            <span style={{ fontSize: 14 }}>股票代號：</span>
            <input
              style={{ width: 110 }}
              value={addCode}
              inputMode="numeric"
              placeholder="例：2330"
              onChange={(e) => setAddCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addStock()}
            />
            <button className="btn-add" onClick={addStock} disabled={busy}>
              {busy ? '查詢中…' : '＋ 新增監控'}
            </button>
            {addMsg && <span className={`msg ${addMsg.ok ? 'ok' : 'err'}`}>{addMsg.text}</span>}
          </div>
        </div>

        {/* 監控清單 */}
        <div className="card">
          <h2>監控清單（{stocks.length} 檔）</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>股票</th>
                  <th>市場</th>
                  <th>現價</th>
                  <th>漲跌</th>
                  <th>漲幅</th>
                  <th>5秒量(張)</th>
                  <th>門檻(張)</th>
                  <th>狀態</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {stocks.map((s) => {
                  const r = rowByCode.get(s.code);
                  const cls =
                    r?.ok && r.change !== undefined
                      ? r.change > 0
                        ? 'up'
                        : r.change < 0
                          ? 'down'
                          : 'flat'
                      : 'flat';
                  let stText = '—';
                  if (r?.spike) stText = '⚠ 巨量！';
                  else if (r?.last_spike) stText = `⚠ 曾觸發 ${fmtTime(r.last_spike)}`;
                  else if (r?.ok) stText = r.delayed ? '正常（延遲15分）' : '正常';
                  else if (monitorOn) stText = '無資料';
                  return (
                    <tr key={s.code} className={r?.spike ? 'spike' : ''}>
                      <td>
                        <b>{s.name}</b> <span className="dim">{s.code}</span>
                      </td>
                      <td className="dim">{MKT_LABEL[s.market] ?? s.market}</td>
                      <td className={cls}>{r?.ok ? r.price?.toFixed(2) : '—'}</td>
                      <td className={cls}>
                        {r?.ok && r.change !== undefined
                          ? `${r.change > 0 ? '+' : ''}${r.change.toFixed(2)}`
                          : '—'}
                      </td>
                      <td className={cls}>
                        {r?.ok && r.pct !== undefined
                          ? `${r.pct > 0 ? '+' : ''}${r.pct.toFixed(2)}%`
                          : '—'}
                      </td>
                      <td>{r?.ok && r.delta ? r.delta.toLocaleString() : '—'}</td>
                      <td>{r?.ok && r.threshold ? r.threshold.toLocaleString() : '—'}</td>
                      <td style={{ fontSize: 12 }}>{stText}</td>
                      <td>
                        <button className="btn-del" onClick={() => removeStock(s)}>
                          移除
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {stocks.length === 0 && (
                  <tr>
                    <td colSpan={9} className="dim">
                      尚無監控股票，輸入代號新增
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {!monitorOn && (
            <p className="dim" style={{ marginTop: 8 }}>
              非監控時段，報價為最後一次更新的內容；清單修改隨時都會儲存。
            </p>
          )}
        </div>

        {/* 今日警報 */}
        <div className="card">
          <h2>今日警報記錄（{alerts.length} 筆）</h2>
          {alerts.length === 0 && <p className="dim">今天還沒有巨量警報</p>}
          {alerts.map((a, i) => (
            <div className="alert-item" key={`${a.code}-${a.time}-${i}`}>
              <b>{fmtTime(a.time)}</b>　{a.name}（{a.code}）巨量觸發！ 現價 {a.price}（
              {a.pct > 0 ? '+' : ''}
              {a.pct}%）｜5秒量 {a.delta.toLocaleString()} 張｜門檻{' '}
              {a.threshold.toLocaleString()} 張｜{a.emailed ? '✉ 已寄信' : '✗ 寄信失敗'}
            </div>
          ))}
        </div>

        {/* 設定 */}
        <div className="card">
          <h2>通知設定</h2>
          <div className="row" style={{ marginBottom: 8 }}>
            <span style={{ fontSize: 14 }}>收件人（逗號分隔多個）：</span>
            <input
              style={{ flex: 1, minWidth: 220 }}
              value={emailTo}
              placeholder="aaa@gmail.com, bbb@gmail.com"
              onChange={(e) => setEmailTo(e.target.value)}
            />
          </div>
          <div className="row">
            <span style={{ fontSize: 14 }}>觸發門檻（5日均量 ×）：</span>
            <input
              style={{ width: 70 }}
              value={ratioPct}
              inputMode="decimal"
              onChange={(e) => setRatioPct(e.target.value)}
            />
            <span style={{ fontSize: 14 }}>%</span>
            <button className="btn-save" onClick={saveSettings}>
              儲存設定
            </button>
            {settingsMsg && (
              <span className={`msg ${settingsMsg.ok ? 'ok' : 'err'}`}>{settingsMsg.text}</span>
            )}
          </div>
        </div>

        <div className="footer">
          雲端監控由 GitHub Actions 於每個交易日 08:55 自動啟動、13:30 收盤結束；本頁僅供管理與查看。
        </div>
      </div>
    </>
  );
}
