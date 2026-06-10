'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Alert, Status, Stock } from '@/lib/storage';

const KEY_STORAGE = 'twstock_login';
const POLL_MS = 5000;

interface ApiData {
  user: string;
  isAdmin: boolean;
  settings: { email_to: string; threshold_ratio: number };
  stocks: Stock[];
  status: Status | null;
  alerts: Alert[];
}

interface UserRow {
  username: string;
  email_to: string;
  threshold_ratio: number;
  created?: string;
}

interface Credentials {
  user: string;
  pass: string;
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
  const [cred, setCred] = useState<Credentials | null>(null);
  const [userInput, setUserInput] = useState('');
  const [passInput, setPassInput] = useState('');
  const [loginMsg, setLoginMsg] = useState('');
  const [data, setData] = useState<ApiData | null>(null);
  const [addCode, setAddCode] = useState('');
  const [addMsg, setAddMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [emailTo, setEmailTo] = useState('');
  const [ratioPct, setRatioPct] = useState('2');
  const [settingsMsg, setSettingsMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const settingsLoaded = useRef(false);
  // 帳號管理（admin）
  const [userList, setUserList] = useState<UserRow[]>([]);
  const [newUser, setNewUser] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [userMsg, setUserMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const api = useCallback(
    async (path: string, init: RequestInit = {}, c?: Credentials) => {
      const use = c ?? cred;
      const res = await fetch(path, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          'x-user': use?.user ?? '',
          'x-pass': use?.pass ?? '',
          ...init.headers,
        },
        cache: 'no-store',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      return json;
    },
    [cred]
  );

  const refresh = useCallback(
    async (c?: Credentials) => {
      const json = (await api('/api/status', {}, c)) as ApiData;
      setData(json);
      if (!settingsLoaded.current) {
        settingsLoaded.current = true;
        setEmailTo(json.settings.email_to);
        setRatioPct(String(Math.round(json.settings.threshold_ratio * 1000) / 10));
      }
      return json;
    },
    [api]
  );

  const refreshUsers = useCallback(
    async (c?: Credentials) => {
      try {
        const json = await api('/api/users', {}, c);
        setUserList(json.users ?? []);
      } catch {
        // 非 admin 會 403，忽略
      }
    },
    [api]
  );

  // 自動登入（localStorage 有存就直接試）
  useEffect(() => {
    const saved = localStorage.getItem(KEY_STORAGE);
    if (!saved) return;
    try {
      const c = JSON.parse(saved) as Credentials;
      refresh(c)
        .then((d) => {
          setCred(c);
          if (d.isAdmin) refreshUsers(c);
        })
        .catch(() => localStorage.removeItem(KEY_STORAGE));
    } catch {
      localStorage.removeItem(KEY_STORAGE);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 每 5 秒輪詢狀態
  useEffect(() => {
    if (!cred) return;
    const t = setInterval(() => {
      refresh().catch(() => {});
    }, POLL_MS);
    return () => clearInterval(t);
  }, [cred, refresh]);

  async function login() {
    setLoginMsg('');
    const c = { user: userInput.trim(), pass: passInput };
    try {
      const d = await refresh(c);
      localStorage.setItem(KEY_STORAGE, JSON.stringify(c));
      setCred(c);
      if (d.isAdmin) refreshUsers(c);
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
      await refresh();
    } catch (e) {
      setSettingsMsg({ text: e instanceof Error ? e.message : '儲存失敗', ok: false });
    }
  }

  async function createUser() {
    setUserMsg(null);
    try {
      const r = await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({ username: newUser, password: newPass, email_to: newEmail }),
      });
      setUserMsg({
        text: r.updated ? `已重設「${newUser.trim()}」的密碼` : `已建立帳號「${newUser.trim()}」`,
        ok: true,
      });
      setNewUser('');
      setNewPass('');
      setNewEmail('');
      await refreshUsers();
    } catch (e) {
      setUserMsg({ text: e instanceof Error ? e.message : '建立失敗', ok: false });
    }
  }

  async function removeUser(username: string) {
    if (!confirm(`確定要刪除帳號「${username}」嗎？其監控清單也會一併刪除。`)) return;
    try {
      await api(`/api/users?username=${encodeURIComponent(username)}`, { method: 'DELETE' });
      await refreshUsers();
    } catch (e) {
      alert(e instanceof Error ? e.message : '刪除失敗');
    }
  }

  function logout() {
    localStorage.removeItem(KEY_STORAGE);
    setCred(null);
    setData(null);
    setUserList([]);
    settingsLoaded.current = false;
  }

  // ── 登入畫面 ──────────────────────────────────────────────
  if (!cred) {
    return (
      <div className="login-box">
        <h1 style={{ color: '#1a3a5c' }}>📈 台股盤中巨量監控</h1>
        <input
          placeholder="帳號"
          value={userInput}
          autoCapitalize="none"
          onChange={(e) => setUserInput(e.target.value)}
        />
        <input
          type="password"
          placeholder="密碼"
          value={passInput}
          onChange={(e) => setPassInput(e.target.value)}
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
  const ratio = data?.settings.threshold_ratio ?? 0.02;
  // 每檔今日最近一次觸發時間（alerts 由新到舊）
  const lastAlertByCode = new Map<string, string>();
  for (const a of alerts) {
    if (!lastAlertByCode.has(a.code)) lastAlertByCode.set(a.code, a.time);
  }

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
          <span className="badge">👤 {data?.user}</span>
          <button className="btn-plain" style={{ fontSize: 12, padding: '4px 10px' }} onClick={logout}>
            登出
          </button>
        </div>
      </div>
      <div className="infobar">
        資料來源：證交所 / 櫃買中心即時 API｜觸發條件：5秒成交量 ≥ 5日均量 ×{' '}
        {(ratio * 100).toFixed(1)}%｜觸發時自動寄 Email
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
          <h2>我的監控清單（{stocks.length} 檔）</h2>
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
                  const threshold =
                    r?.ok && r.avg_vol
                      ? Math.round(r.avg_vol * ratio * (s.yf_only ? 12 : 1))
                      : 0;
                  const spiking =
                    monitorOn &&
                    !!status?.market_open &&
                    threshold > 0 &&
                    (r?.delta ?? 0) >= threshold;
                  const lastAlert = lastAlertByCode.get(s.code);
                  const cls =
                    r?.ok && r.change !== undefined
                      ? r.change > 0
                        ? 'up'
                        : r.change < 0
                          ? 'down'
                          : 'flat'
                      : 'flat';
                  let stText = '—';
                  if (spiking) stText = '⚠ 巨量！';
                  else if (lastAlert) stText = `⚠ 曾觸發 ${fmtTime(lastAlert)}`;
                  else if (r?.ok) stText = r.delayed ? '正常（延遲15分）' : '正常';
                  else if (monitorOn) stText = '無資料';
                  return (
                    <tr key={s.code} className={spiking ? 'spike' : ''}>
                      <td>
                        <a
                          className="stock-link"
                          href={`https://tw.stock.yahoo.com/quote/${s.code}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`開啟 ${s.name} 的 Yahoo 行情頁`}
                        >
                          <b>{s.name}</b> <span className="dim">{s.code}</span>
                        </a>
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
                      <td>{threshold > 0 ? threshold.toLocaleString() : '—'}</td>
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
          <p className="dim" style={{ marginTop: 8 }}>
            💡 點股票名稱可開啟 Yahoo 即時行情頁
          </p>
          {!monitorOn && (
            <p className="dim">
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

        {/* 通知設定 */}
        <div className="card">
          <h2>我的通知設定</h2>
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

        {/* 帳號管理（admin 專用） */}
        {data?.isAdmin && (
          <div className="card">
            <h2>帳號管理（admin）</h2>
            <div className="table-wrap" style={{ marginBottom: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th>帳號</th>
                    <th>收件人</th>
                    <th>門檻</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {userList.map((u) => (
                    <tr key={u.username}>
                      <td>
                        <b>{u.username}</b>
                      </td>
                      <td className="dim">{u.email_to || '—'}</td>
                      <td>{(u.threshold_ratio * 100).toFixed(1)}%</td>
                      <td>
                        {u.username !== 'admin' && (
                          <button className="btn-del" onClick={() => removeUser(u.username)}>
                            刪除
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row">
              <input
                style={{ width: 130 }}
                placeholder="帳號（英數）"
                value={newUser}
                autoCapitalize="none"
                onChange={(e) => setNewUser(e.target.value)}
              />
              <input
                style={{ width: 130 }}
                type="password"
                placeholder="密碼（6字以上）"
                value={newPass}
                onChange={(e) => setNewPass(e.target.value)}
              />
              <input
                style={{ flex: 1, minWidth: 180 }}
                placeholder="收件信箱（選填）"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
              />
              <button className="btn-add" onClick={createUser}>
                建立 / 重設密碼
              </button>
              {userMsg && <span className={`msg ${userMsg.ok ? 'ok' : 'err'}`}>{userMsg.text}</span>}
            </div>
            <p className="dim" style={{ marginTop: 8 }}>
              輸入已存在的帳號可重設其密碼；admin 自己的密碼在 Vercel 環境變數 ADMIN_PASSWORD 修改。
            </p>
          </div>
        )}

        <div className="footer">
          雲端監控由 GitHub Actions 於每個交易日 08:55 自動啟動、13:30 收盤結束；本頁僅供管理與查看。
        </div>
      </div>
    </>
  );
}
