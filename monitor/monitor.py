"""
台股盤中巨量監控（雲端無介面版・多使用者）
- 在 GitHub Actions 上每個交易日 09:00–13:30 連續執行
- TWSE / TPEx 官方即時 API 每 5 秒輪詢，興櫃股以 yfinance 備援
- 每位使用者有自己的監控清單 / 收件信箱 / 門檻比例，
  觸發「5秒成交量 ≥ 5日均量 × 門檻」時各自寄 Gmail 警報
- 透過 Upstash Redis 與管理網頁共用資料
  （未設定 Redis 時退回讀取本機 stocks.json 的單人模式）

Redis 資料結構（與 lib/storage.ts 對應）：
  twstock:users                 {username: {pw?, email_to, threshold_ratio}}
  twstock:stocks:{user}         [{name, code, market, yf_only?}]
  twstock:status                全域報價快照（門檻由網頁依各使用者比例計算）
  twstock:alerts:{user}:{date}  該使用者今日警報記錄
  twstock:alerted:{date}        {user: {code: [分鐘key]}} 防重複寄信

用法：
    python monitor.py            # 正式執行（等到開盤、收盤自動結束）
    python monitor.py --once     # 只抓一輪報價印出來，不寄信（測試用）
"""

import datetime
import json
import math
import os
import smtplib
import sys
import time
import urllib.parse
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from zoneinfo import ZoneInfo

import requests

# ══════════════════════════════════════════════════════════════
#  設定
# ══════════════════════════════════════════════════════════════
DEFAULT_RATIO    = 0.02    # 預設門檻：5日均量 × 2%（每位使用者可自訂）
CHECK_INTERVAL   = 5       # 查詢間隔（秒）
REFRESH_INTERVAL = 30      # 每隔幾秒從 Redis 重讀使用者與清單

TW_TZ        = ZoneInfo("Asia/Taipei")
MARKET_OPEN  = datetime.time(9, 0)
MARKET_CLOSE = datetime.time(13, 31)
WAIT_FROM    = datetime.time(6, 0)   # 這個時間之後啟動才願意等開盤

MIS_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Referer":    "https://mis.twse.com.tw/",
}

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
STOCKS_FILE = os.path.join(SCRIPT_DIR, "..", "stocks.json")

# Gmail（由 GitHub Secrets 注入）
GMAIL_USER         = os.environ.get("GMAIL_USER", "")
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")
NOTIFY_EMAIL       = os.environ.get("NOTIFY_EMAIL", GMAIL_USER)

# Upstash Redis REST（與 Next.js 管理網頁共用）
REDIS_URL   = os.environ.get("UPSTASH_REDIS_REST_URL", "").rstrip("/")
REDIS_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN", "")

KEY_USERS        = "twstock:users"
KEY_STOCKS_OF    = "twstock:stocks:{user}"
KEY_STATUS       = "twstock:status"
KEY_ALERTS_OF    = "twstock:alerts:{user}:{date}"
KEY_ALERTED      = "twstock:alerted:{date}"
KEY_LEGACY_STOCKS   = "twstock:stocks"
KEY_LEGACY_SETTINGS = "twstock:settings"


def log(msg: str):
    print(f"{now_tw().strftime('%H:%M:%S')}  {msg}", flush=True)


def now_tw() -> datetime.datetime:
    return datetime.datetime.now(TW_TZ)


def is_market_open() -> bool:
    t = now_tw()
    return t.weekday() < 5 and MARKET_OPEN <= t.time() <= MARKET_CLOSE


def today_str() -> str:
    return now_tw().strftime("%Y%m%d")


# ══════════════════════════════════════════════════════════════
#  Upstash Redis REST helpers
#  值一律存 JSON 字串，與 @upstash/redis（自動 JSON 序列化）相容
# ══════════════════════════════════════════════════════════════
def redis_enabled() -> bool:
    return bool(REDIS_URL and REDIS_TOKEN)


def _redis_call(*path_parts, body: str | None = None):
    path = "/".join(urllib.parse.quote(str(p), safe="") for p in path_parts)
    r = requests.post(f"{REDIS_URL}/{path}",
                      headers={"Authorization": f"Bearer {REDIS_TOKEN}"},
                      data=(body.encode("utf-8") if body is not None else None),
                      timeout=10)
    r.raise_for_status()
    return r.json().get("result")


def redis_get_json(key: str):
    try:
        raw = _redis_call("get", key)
        return json.loads(raw) if raw is not None else None
    except Exception as e:
        log(f"⚠️ Redis 讀取失敗（{key}）：{e}")
        return None


def redis_set_json(key: str, value) -> bool:
    try:
        _redis_call("set", key, body=json.dumps(value, ensure_ascii=False))
        return True
    except Exception as e:
        log(f"⚠️ Redis 寫入失敗（{key}）：{e}")
        return False


def redis_lpush_json(key: str, value, keep: int = 200, expire_sec: int = 3 * 86400):
    try:
        _redis_call("lpush", key, body=json.dumps(value, ensure_ascii=False))
        _redis_call("ltrim", key, 0, keep - 1)
        _redis_call("expire", key, expire_sec)
    except Exception as e:
        log(f"⚠️ Redis 寫入失敗（{key}）：{e}")


def redis_expire(key: str, expire_sec: int):
    try:
        _redis_call("expire", key, expire_sec)
    except Exception:
        pass


# ══════════════════════════════════════════════════════════════
#  使用者 / 清單載入（含舊版單人資料自動遷移）
# ══════════════════════════════════════════════════════════════
def normalize_profile(p: dict | None) -> dict:
    p = p if isinstance(p, dict) else {}
    out = {
        "email_to": p.get("email_to") or NOTIFY_EMAIL,
        "threshold_ratio": DEFAULT_RATIO,
    }
    try:
        ratio = float(p.get("threshold_ratio", 0))
        if 0 < ratio < 1:
            out["threshold_ratio"] = ratio
    except (TypeError, ValueError):
        pass
    return out


def _load_local_stocks() -> list:
    try:
        with open(STOCKS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def load_users() -> dict:
    """回傳 {username: profile}。無 Redis 時為單人本機模式。"""
    if not redis_enabled():
        return {"admin": normalize_profile(None)}

    users = redis_get_json(KEY_USERS)
    if isinstance(users, dict) and users:
        return {u: normalize_profile(p) for u, p in users.items()}

    # ── 第一次跑多使用者版：把舊單人資料遷移成 admin 帳號 ──
    legacy_settings = redis_get_json(KEY_LEGACY_SETTINGS)
    admin = normalize_profile(legacy_settings)
    redis_set_json(KEY_USERS, {"admin": {**admin, "created": now_tw().isoformat()}})

    legacy_stocks = redis_get_json(KEY_LEGACY_STOCKS)
    if isinstance(legacy_stocks, list) and legacy_stocks:
        if redis_get_json(KEY_STOCKS_OF.format(user="admin")) is None:
            redis_set_json(KEY_STOCKS_OF.format(user="admin"), legacy_stocks)
        log(f"🔁 已將舊版監控清單（{len(legacy_stocks)} 檔）遷移給 admin 帳號")
    log("🔁 已建立多使用者結構（admin）")
    return {"admin": admin}


def load_stocks_of(user: str) -> list:
    if not redis_enabled():
        return _load_local_stocks()
    data = redis_get_json(KEY_STOCKS_OF.format(user=user))
    if isinstance(data, list):
        return data
    if user == "admin":
        seed = _load_local_stocks()
        if seed:
            redis_set_json(KEY_STOCKS_OF.format(user="admin"), seed)
            log(f"📋 已用 stocks.json 初始化 admin 監控清單（{len(seed)} 檔）")
        return seed
    return []


def save_stocks_of(user: str, stocks: list):
    if redis_enabled():
        redis_set_json(KEY_STOCKS_OF.format(user=user), stocks)


# ══════════════════════════════════════════════════════════════
#  行情查詢（邏輯移植自桌面版）
# ══════════════════════════════════════════════════════════════
def lookup_stock(code: str) -> dict | None:
    """自動偵測股票名稱與市場（上市 tse / 上櫃 otc / 興櫃 emerging）"""
    for market in ["tse", "otc", "emerging"]:
        try:
            r = requests.get(MIS_URL,
                params={"ex_ch": f"{market}_{code}.tw", "json": "1", "delay": "0"},
                headers=HEADERS, timeout=8)
            msgs = r.json().get("msgArray", [])
            if msgs:
                m    = msgs[0]
                name = m.get("n", "").strip()
                if not name:
                    continue
                has_price = bool(m.get("y", "-") not in ("", "-"))
                info = {"name": name, "code": code, "market": market}
                if not has_price:
                    info["yf_only"] = True   # 有掛牌但 MIS 不提供行情，改走 yfinance
                return info
        except Exception:
            pass
    return None


def lookup_stock_yf(code: str) -> dict | None:
    import yfinance as yf
    for suffix, mkt in [(".TWO", "otc"), (".TW", "tse")]:
        try:
            df = yf.download(code + suffix, period="5d", interval="1d",
                             progress=False, auto_adjust=True)
            if df is not None and not df.empty:
                try:
                    name = yf.Ticker(code + suffix).info.get("shortName", "").strip()
                except Exception:
                    name = ""
                return {"name": name or code, "code": code,
                        "market": mkt, "yf_only": True}
        except Exception:
            pass
    return None


def get_avg_volume(code: str, market: str) -> float:
    """yfinance 取5日均量（單位：張）"""
    import pandas as pd
    import yfinance as yf
    suffix = ".TW" if market == "tse" else ".TWO"
    try:
        df = yf.download(code + suffix, period="7d", interval="1d",
                         progress=False, auto_adjust=True)
        if df is None or df.empty:
            return 0.0
        vol = df["Volume"]
        if isinstance(vol, pd.DataFrame):
            vol = vol.iloc[:, 0]
        vol = vol.dropna()
        if len(vol) > 5:
            vol = vol.iloc[-5:]
        result = float(vol.mean()) / 1000
        return 0.0 if math.isnan(result) else result
    except Exception:
        return 0.0


def fetch_quotes(stocks: list) -> dict:
    """TWSE MIS API 即時報價，回傳 {code: {...}}"""
    if not stocks:
        return {}
    ex_ch = "|".join(f"{s['market']}_{s['code']}.tw" for s in stocks if s.get("market"))
    if not ex_ch:
        return {}
    try:
        r = requests.get(MIS_URL,
                         params={"ex_ch": ex_ch, "json": "1", "delay": "0"},
                         headers=HEADERS, timeout=8)
        result = {}
        for msg in r.json().get("msgArray", []):
            code  = msg.get("c", "")
            z_raw = msg.get("z", "-")
            z_ok  = bool(z_raw and z_raw != "-")
            b_ok  = False
            if z_ok:
                price = z_raw
            else:
                # z 無值時：優先用最佳買進價（b1），比開盤價更即時
                b_raw = msg.get("b", "")
                b1    = b_raw.split("_")[0] if b_raw else ""
                try:
                    b1_val = float(b1) if b1 else 0.0
                except ValueError:
                    b1_val = 0.0
                if b1_val > 0:
                    price = b1
                    b_ok  = True
                else:
                    price = msg.get("o", "-")
                    if not price or price == "-":
                        price = msg.get("y", "0")
            result[code] = {
                "price":   float(price or 0),
                "prev":    float(msg.get("y", 0) or 0),
                "vol_lot": float(msg.get("v", 0) or 0),
                "z_ok":    z_ok,
                "b_ok":    b_ok,
            }
        return result
    except Exception as e:
        log(f"⚠️ MIS 查詢失敗：{e}")
        return {}


def fetch_yf_prev_close(code: str, market: str) -> float:
    """抓前一交易日收盤價（每日一次）。收盤後日線已含今日，須排除。"""
    import pandas as pd
    import yfinance as yf
    suffix = ".TW" if market == "tse" else ".TWO"
    today = now_tw().date()
    try:
        df = yf.download(code + suffix, period="7d", interval="1d",
                         progress=False, auto_adjust=True)
        if df is None or df.empty:
            return 0.0
        close = df["Close"]
        if isinstance(close, pd.DataFrame):
            close = close.iloc[:, 0]
        close = close.dropna()
        if len(close) == 0:
            return 0.0
        last_date = close.index[-1]
        if hasattr(last_date, "date"):
            last_date = last_date.date()
        if last_date >= today and len(close) >= 2:
            val = float(close.iloc[-2])
        else:
            val = float(close.iloc[-1])
        return 0.0 if math.isnan(val) else val
    except Exception:
        return 0.0


def fetch_yf_quote(code: str, market: str, prev: float) -> dict | None:
    """yfinance 即時報價：1 分 K（量為每分鐘更新）"""
    import pandas as pd
    import yfinance as yf
    suffix = ".TW" if market == "tse" else ".TWO"
    try:
        df1m = yf.download(code + suffix, period="1d", interval="1m",
                           progress=False, auto_adjust=True)
        if df1m is None or df1m.empty:
            return None
        close_1m = df1m["Close"]
        if isinstance(close_1m, pd.DataFrame):
            close_1m = close_1m.iloc[:, 0]
        close_1m = close_1m.dropna()
        if len(close_1m) == 0:
            return None
        curr = float(close_1m.iloc[-1])
        v = df1m["Volume"]
        if isinstance(v, pd.DataFrame):
            v = v.iloc[:, 0]
        vol_lot = float(v.dropna().sum()) / 1000
        if math.isnan(curr) or curr == 0 or math.isnan(prev) or prev == 0:
            return None
        return {"price": curr, "prev": prev, "vol_lot": vol_lot, "delayed": True}
    except Exception:
        return None


# ══════════════════════════════════════════════════════════════
#  Email
# ══════════════════════════════════════════════════════════════
def send_email(name: str, code: str, price: float, change_pct: float,
               delta: float, threshold: float, email_to: str) -> bool:
    subject = f"[台股巨量警報] {name}({code}) 盤中瞬間巨量！"
    body = f"""<html><body>
<h2 style="color:#cc2200">⚠️ 台股盤中瞬間巨量偵測</h2>
<table border="1" cellpadding="8" style="border-collapse:collapse;font-size:14px">
  <tr><th>股票</th><td><b>{name}（{code}）</b></td></tr>
  <tr><th>偵測時間</th><td>{now_tw().strftime('%Y-%m-%d %H:%M:%S')}</td></tr>
  <tr><th>現價</th><td>{price:.2f} 元</td></tr>
  <tr><th>當日漲幅</th><td style="color:{'#cc2200' if change_pct >= 0 else '#007733'}">{change_pct:+.2f}%</td></tr>
  <tr><th>5秒成交量</th><td><b>{delta:,.0f} 張</b></td></tr>
  <tr><th>觸發門檻</th><td>{threshold:,.0f} 張</td></tr>
  <tr><th>倍率</th><td>{delta / threshold:.1f} 倍</td></tr>
</table>
<p style="color:gray;font-size:11px">此通知由「台股盤中監控（雲端版）」自動發送</p>
</body></html>"""
    recipients = [e.strip() for e in email_to.split(",") if e.strip()]
    if not (GMAIL_USER and GMAIL_APP_PASSWORD and recipients):
        log("⚠️ Email 未設定（GMAIL_USER / GMAIL_APP_PASSWORD / 收件人），略過寄信")
        return False
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"]    = GMAIL_USER
        msg["To"]      = ", ".join(recipients)
        msg.attach(MIMEText(body, "html", "utf-8"))
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=30) as sv:
            sv.starttls()
            sv.login(GMAIL_USER, GMAIL_APP_PASSWORD)
            sv.sendmail(GMAIL_USER, recipients, msg.as_string())
        return True
    except Exception as e:
        log(f"⚠️ Email 寄送失敗：{e}")
        return False


# ══════════════════════════════════════════════════════════════
#  主監控
# ══════════════════════════════════════════════════════════════
class Monitor:
    def __init__(self):
        self.users: dict[str, dict] = {}        # username -> profile
        self.user_stocks: dict[str, list] = {}  # username -> 清單
        self.stock_info: dict[str, dict] = {}   # code -> {name, market, yf_only}（聯集）
        # 全域 per-code 狀態
        self.avg_vol: dict[str, float] = {}
        self.prev_vol: dict[str, float | None] = {}
        self.last_price: dict[str, float] = {}
        self.yf_prev_close: dict[str, float] = {}
        # 防重複寄信：{user: {code: [分鐘key]}}
        self.alerted: dict[str, dict[str, list]] = {}
        self._last_refresh = 0.0

    # ── 初始化 ────────────────────────────────────────────────
    def setup(self):
        self._load_users_and_lists(initial=True)
        n_codes = len(self.stock_info)
        log(f"👥 使用者 {len(self.users)} 位｜監控股票聯集 {n_codes} 檔")

        # 載入今日已寄信記錄（備援 run 重啟時不重複寄）
        if redis_enabled():
            data = redis_get_json(KEY_ALERTED.format(date=today_str()))
            if isinstance(data, dict):
                self.alerted = {
                    u: {c: list(v) for c, v in (codes or {}).items()}
                    for u, codes in data.items()
                }
                total = sum(len(v) for codes in self.alerted.values() for v in codes.values())
                if total:
                    log(f"📨 已載入今日寄信記錄（{total} 筆）")

        self._init_codes(list(self.stock_info.keys()))
        log("✅ 初始化完成，開始監控")

    def _load_users_and_lists(self, initial: bool = False):
        """讀取所有使用者與其清單，偵測缺漏的市場欄位並回寫，重建聯集"""
        self.users = load_users()
        new_user_stocks: dict[str, list] = {}
        for user in self.users:
            stocks = load_stocks_of(user)
            changed = False
            for s in stocks:
                if not s.get("market"):
                    info = lookup_stock(s["code"]) or lookup_stock_yf(s["code"])
                    if info:
                        s.update(info)
                        log(f"🔍 [{user}] {s['name']}（{s['code']}）偵測為 {info['market']}")
                    else:
                        s["market"] = "otc"
                        log(f"⚠️ [{user}] {s['code']} 無法偵測市場，先當作上櫃")
                    changed = True
            if changed:
                save_stocks_of(user, stocks)
            new_user_stocks[user] = stocks
        self.user_stocks = new_user_stocks

        info: dict[str, dict] = {}
        for stocks in self.user_stocks.values():
            for s in stocks:
                if s.get("market") and s["code"] not in info:
                    info[s["code"]] = s
        self.stock_info = info

    def _init_codes(self, codes: list):
        """載入均量與昨收（新加入的股票也走這裡）"""
        for code in codes:
            s = self.stock_info.get(code)
            if not s:
                continue
            self.prev_vol.setdefault(code, None)
            avg = get_avg_volume(code, s["market"])
            self.avg_vol[code] = avg
            mkt_label = {"tse": "上市", "otc": "上櫃", "emerging": "興櫃"}.get(s["market"], s["market"])
            log(f"   {s['name']}（{mkt_label}）5日均量 {avg:,.0f} 張")
            if s.get("yf_only"):
                prev = fetch_yf_prev_close(code, s["market"])
                if prev:
                    self.yf_prev_close[code] = prev

    # ── 清單 / 設定即時同步（網頁端改了會在 30 秒內生效）────────
    def refresh(self):
        if not redis_enabled():
            return
        if time.time() - self._last_refresh < REFRESH_INTERVAL:
            return
        self._last_refresh = time.time()

        old_codes = set(self.stock_info.keys())
        self._load_users_and_lists()
        new_codes = set(self.stock_info.keys())

        for code in old_codes - new_codes:
            for d in (self.avg_vol, self.prev_vol, self.last_price, self.yf_prev_close):
                d.pop(code, None)
            log(f"➖ 已無人監控，移除：{code}")

        added = sorted(new_codes - old_codes)
        if added:
            for code in added:
                s = self.stock_info[code]
                log(f"➕ 新增監控：{s.get('name', code)}（{code}）")
            self._init_codes(added)

    # ── 每 5 秒一輪 ───────────────────────────────────────────
    def tick(self, send_alerts: bool = True) -> list:
        ready      = [s for s in self.stock_info.values() if s.get("market")]
        mis_stocks = [s for s in ready if not s.get("yf_only")]
        data = fetch_quotes(mis_stocks)
        now  = now_tw()
        mkt  = is_market_open()
        rows = []

        for s in ready:
            code, name = s["code"], s["name"]
            d = data.get(code)

            if not d or s.get("yf_only"):
                prev = self.yf_prev_close.get(code, 0.0)
                if not prev:
                    prev = fetch_yf_prev_close(code, s["market"])
                    if prev:
                        self.yf_prev_close[code] = prev
                d = fetch_yf_quote(code, s["market"], prev) if prev else None
            if not d:
                rows.append({"code": code, "name": name, "ok": False})
                continue

            # 即時價快取：z/b1 都無值時沿用最後已知價，避免退回昨收
            if d.get("z_ok") or d.get("b_ok") or "z_ok" not in d:
                self.last_price[code] = d["price"]
            elif code in self.last_price:
                d = dict(d)
                d["price"] = self.last_price[code]

            price, prev, vol_lot = d["price"], d["prev"], d["vol_lot"]
            if not prev or math.isnan(price) or math.isnan(prev):
                rows.append({"code": code, "name": name, "ok": False})
                continue
            change     = price - prev
            change_pct = change / prev * 100

            pv    = self.prev_vol.get(code)
            delta = (vol_lot - pv) if (pv is not None and vol_lot >= pv) else 0.0
            self.prev_vol[code] = vol_lot

            avg = self.avg_vol.get(code, 0)

            if mkt and send_alerts and avg > 0 and delta > 0:
                self._check_user_alerts(s, price, change_pct, delta, avg, now)

            rows.append({
                "code": code, "name": name, "market": s["market"],
                "yf_only": bool(s.get("yf_only")), "ok": True,
                "price": round(price, 2), "change": round(change, 2),
                "pct": round(change_pct, 2),
                "delta": round(delta), "avg_vol": round(avg),
                "delayed": bool(d.get("delayed")),
            })
        return rows

    def _check_user_alerts(self, s: dict, price: float, change_pct: float,
                           delta: float, avg: float, now: datetime.datetime):
        """對每位有監控這檔的使用者，依各自門檻判斷並寄信"""
        code, name = s["code"], s["name"]
        minute_key = now.strftime("%Y%m%d%H%M")
        dirty = False
        for user, profile in self.users.items():
            if not any(x["code"] == code for x in self.user_stocks.get(user, [])):
                continue
            ratio = profile["threshold_ratio"]
            # yfinance 股 delta 為 1 分鐘量，門檻等比放大維持相同靈敏度
            t_ratio   = ratio * 12 if s.get("yf_only") else ratio
            threshold = avg * t_ratio
            if threshold <= 0 or delta < threshold:
                continue
            user_alerted = self.alerted.setdefault(user, {}).setdefault(code, [])
            if minute_key in user_alerted:
                continue
            user_alerted.append(minute_key)
            dirty = True
            ok = send_email(name, code, price, change_pct, delta, threshold,
                            profile["email_to"])
            tag = "✉ Email 已寄出" if ok else "✗ Email 失敗"
            log(f"⚠️ [{user}] {name}（{code}）巨量觸發！"
                f"5秒量={delta:,.0f}張 門檻={threshold:,.0f}張 {tag}")
            if redis_enabled():
                redis_lpush_json(KEY_ALERTS_OF.format(user=user, date=today_str()), {
                    "time": now.isoformat(), "code": code, "name": name,
                    "price": round(price, 2), "pct": round(change_pct, 2),
                    "delta": round(delta), "threshold": round(threshold),
                    "emailed": ok,
                })
        if dirty and redis_enabled():
            key = KEY_ALERTED.format(date=today_str())
            redis_set_json(key, self.alerted)
            redis_expire(key, 3 * 86400)

    def publish_status(self, rows: list, running: bool):
        if not redis_enabled():
            return
        redis_set_json(KEY_STATUS, {
            "updated": now_tw().isoformat(),
            "running": running,
            "market_open": is_market_open(),
            "rows": rows,
        })


# ══════════════════════════════════════════════════════════════
def another_run_alive() -> bool:
    """備援 run 啟動時，若主 run 仍在更新狀態就直接退出"""
    if not redis_enabled():
        return False
    status = redis_get_json(KEY_STATUS)
    if not isinstance(status, dict) or not status.get("running"):
        return False
    try:
        updated = datetime.datetime.fromisoformat(status["updated"])
        return (now_tw() - updated).total_seconds() < 90
    except Exception:
        return False


def main():
    once = "--once" in sys.argv
    log(f"🚀 台股盤中巨量監控（雲端版・多使用者）啟動  "
        f"Redis={'ON' if redis_enabled() else 'OFF（本機模式）'}")

    if once:
        m = Monitor()
        m.setup()
        rows = m.tick(send_alerts=False)
        m.publish_status(rows, running=False)
        log("── 測試抓取結果 ──")
        for r in rows:
            if r.get("ok"):
                log(f"   {r['name']}({r['code']}) 價={r['price']} "
                    f"漲跌={r['pct']:+.2f}% 5日均量={r['avg_vol']:,}")
            else:
                log(f"   {r['name']}({r['code']}) ❌ 無資料")
        return

    t = now_tw()
    if t.weekday() >= 5:
        log("📅 週末非交易日，結束")
        return
    if t.time() >= MARKET_CLOSE:
        log("📅 已過收盤時間，結束（可能是備援排程）")
        return
    if t.time() < WAIT_FROM:
        log("📅 啟動時間過早，結束")
        return
    if another_run_alive():
        log("👥 偵測到另一個監控正在執行中，本次結束")
        return

    # 等到開盤前 3 分鐘再初始化（抓均量約需 1–2 分鐘）
    warmup = datetime.datetime.combine(t.date(), datetime.time(8, 57), tzinfo=TW_TZ)
    if t < warmup:
        wait = (warmup - t).total_seconds()
        log(f"⏳ 等待開盤中（{wait / 60:.0f} 分鐘後開始初始化）…")
        time.sleep(wait)

    m = Monitor()
    m.setup()

    while True:
        loop_start = time.time()
        t = now_tw()
        if t.time() >= MARKET_CLOSE:
            rows = m.tick(send_alerts=False)
            m.publish_status(rows, running=False)
            log("🏁 收盤，今日監控結束")
            break
        try:
            m.refresh()
            rows = m.tick()
            m.publish_status(rows, running=True)
        except Exception as e:
            log(f"⚠️ 本輪更新異常：{e}")
        time.sleep(max(0.5, CHECK_INTERVAL - (time.time() - loop_start)))


if __name__ == "__main__":
    main()
