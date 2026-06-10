"""
台股盤中巨量監控（雲端無介面版）
- 在 GitHub Actions 上每個交易日 09:00–13:30 連續執行
- TWSE / TPEx 官方即時 API 每 5 秒輪詢，興櫃股以 yfinance 備援
- 觸發「5秒成交量 ≥ 5日均量 × 門檻」時寄 Gmail 警報
- 監控清單 / 即時狀態 / 警報記錄 透過 Upstash Redis 與管理網頁共用
  （未設定 Redis 時退回讀取本機 stocks.json，可在自己電腦單機執行）

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
THRESHOLD_RATIO = 0.02     # 觸發門檻：5日均量 × 2%（可被網頁設定覆蓋）
CHECK_INTERVAL  = 5        # 查詢間隔（秒）
WATCHLIST_REFRESH = 30     # 每隔幾秒從 Redis 重讀監控清單

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

KEY_STOCKS   = "twstock:stocks"
KEY_STATUS   = "twstock:status"
KEY_SETTINGS = "twstock:settings"
KEY_ALERTS   = "twstock:alerts:{date}"
KEY_ALERTED  = "twstock:alerted:{date}"


def log(msg: str):
    print(f"{now_tw().strftime('%H:%M:%S')}  {msg}", flush=True)


def now_tw() -> datetime.datetime:
    return datetime.datetime.now(TW_TZ)


def is_market_open() -> bool:
    t = now_tw()
    return t.weekday() < 5 and MARKET_OPEN <= t.time() <= MARKET_CLOSE


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
#  監控清單 / 設定
# ══════════════════════════════════════════════════════════════
def load_watchlist() -> list:
    """優先讀 Redis（網頁可即時增減）；沒有 Redis 時讀本機 stocks.json"""
    if redis_enabled():
        data = redis_get_json(KEY_STOCKS)
        if isinstance(data, list):
            return data
        # Redis 還沒有清單：用 repo 內的 stocks.json 當種子寫入
        seed = _load_local_stocks()
        if seed:
            redis_set_json(KEY_STOCKS, seed)
            log(f"📋 已用 stocks.json 初始化 Redis 監控清單（{len(seed)} 檔）")
        return seed
    return _load_local_stocks()


def _load_local_stocks() -> list:
    try:
        with open(STOCKS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def save_watchlist(stocks: list):
    if redis_enabled():
        redis_set_json(KEY_STOCKS, stocks)


def load_settings() -> dict:
    s = {"email_to": NOTIFY_EMAIL, "threshold_ratio": THRESHOLD_RATIO}
    if redis_enabled():
        data = redis_get_json(KEY_SETTINGS)
        if isinstance(data, dict):
            if data.get("email_to"):
                s["email_to"] = data["email_to"]
            try:
                ratio = float(data.get("threshold_ratio", 0))
                if 0 < ratio < 1:
                    s["threshold_ratio"] = ratio
            except (TypeError, ValueError):
                pass
    return s


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
        self.stocks: list = []
        self.avg_vol: dict[str, float] = {}
        self.prev_vol: dict[str, float | None] = {}
        self.last_price: dict[str, float] = {}
        self.yf_prev_close: dict[str, float] = {}
        self.last_spike: dict[str, str] = {}      # code -> ISO 時間
        self.alerted: dict[str, list] = {}        # code -> [分鐘 key]（防重複寄信）
        self.settings = load_settings()
        self._last_refresh = 0.0
        self._last_settings = 0.0

    # ── 初始化 ────────────────────────────────────────────────
    def setup(self):
        self.stocks = load_watchlist()
        log(f"📋 監控清單：{len(self.stocks)} 檔")

        # 載入今日已寄信記錄（備援 run 重啟時不重複寄）
        if redis_enabled():
            key = KEY_ALERTED.format(date=now_tw().strftime("%Y%m%d"))
            data = redis_get_json(key)
            if isinstance(data, dict):
                self.alerted = {c: list(v) for c, v in data.items()}
                if self.alerted:
                    log(f"📨 已載入今日寄信記錄（{sum(len(v) for v in self.alerted.values())} 筆）")

        changed = False
        for s in self.stocks:
            if not s.get("market"):
                info = lookup_stock(s["code"]) or lookup_stock_yf(s["code"])
                if info:
                    s.update(info)
                    log(f"🔍 {s['name']}（{s['code']}）偵測為 {info['market']}")
                else:
                    s["market"] = "otc"
                    log(f"⚠️ {s['code']} 無法偵測市場，先當作上櫃")
                changed = True
        if changed:
            save_watchlist(self.stocks)

        self._init_stock_state(self.stocks)
        log("✅ 初始化完成，開始監控")

    def _init_stock_state(self, stocks: list):
        """載入均量與昨收（新加入的股票也走這裡）"""
        today = now_tw().strftime("%Y%m%d")
        ratio = self.settings["threshold_ratio"]
        for s in stocks:
            code = s["code"]
            self.prev_vol.setdefault(code, None)
            self.alerted.setdefault(code, [])
            avg = get_avg_volume(code, s["market"])
            self.avg_vol[code] = avg
            mkt_label = {"tse": "上市", "otc": "上櫃", "emerging": "興櫃"}.get(s["market"], s["market"])
            log(f"   {s['name']}（{mkt_label}）5日均量 {avg:,.0f} 張｜門檻 {avg * ratio:,.0f} 張")
            if s.get("yf_only"):
                prev = fetch_yf_prev_close(code, s["market"])
                if prev:
                    self.yf_prev_close[code] = prev

    # ── 清單 / 設定即時同步（網頁端改了會在 30 秒內生效）────────
    def refresh_watchlist(self):
        if not redis_enabled():
            return
        if time.time() - self._last_refresh < WATCHLIST_REFRESH:
            return
        self._last_refresh = time.time()

        data = redis_get_json(KEY_STOCKS)
        if not isinstance(data, list):
            return
        old_codes = {s["code"] for s in self.stocks}
        new_codes = {s["code"] for s in data}

        removed = old_codes - new_codes
        for code in removed:
            for d in (self.avg_vol, self.prev_vol, self.last_price,
                      self.yf_prev_close, self.last_spike):
                d.pop(code, None)
            log(f"➖ 已移除監控：{code}")

        added = [s for s in data if s["code"] not in old_codes]
        changed = False
        for s in added:
            if not s.get("market"):
                info = lookup_stock(s["code"]) or lookup_stock_yf(s["code"])
                if info:
                    s.update(info)
                else:
                    s["market"] = "otc"
                changed = True
            log(f"➕ 新增監控：{s.get('name', s['code'])}（{s['code']}）")

        self.stocks = data
        if changed:
            save_watchlist(self.stocks)
        if added:
            self._init_stock_state(added)

        self.settings = load_settings()

    # ── 每 5 秒一輪 ───────────────────────────────────────────
    def tick(self, send_alerts: bool = True) -> list:
        ready      = [s for s in self.stocks if s.get("market")]
        mis_stocks = [s for s in ready if not s.get("yf_only")]
        data = fetch_quotes(mis_stocks)
        now  = now_tw()
        mkt  = is_market_open()
        ratio = self.settings["threshold_ratio"]
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
            # yfinance 股 delta 為 1 分鐘量，門檻等比放大維持相同靈敏度
            t_ratio   = ratio * 12 if s.get("yf_only") else ratio
            threshold = avg * t_ratio
            is_spike  = mkt and threshold > 0 and delta >= threshold

            if is_spike and send_alerts:
                key = now.strftime("%Y%m%d%H%M")
                if key not in self.alerted.setdefault(code, []):
                    self.alerted[code].append(key)
                    self.last_spike[code] = now.isoformat()
                    self._record_alert(name, code, price, change_pct, delta, threshold)

            rows.append({
                "code": code, "name": name, "market": s["market"],
                "yf_only": bool(s.get("yf_only")), "ok": True,
                "price": round(price, 2), "change": round(change, 2),
                "pct": round(change_pct, 2),
                "delta": round(delta), "threshold": round(threshold),
                "spike": is_spike,
                "last_spike": self.last_spike.get(code),
                "delayed": bool(d.get("delayed")),
            })
        return rows

    def _record_alert(self, name, code, price, change_pct, delta, threshold):
        now = now_tw()
        ok = send_email(name, code, price, change_pct, delta, threshold,
                        self.settings["email_to"])
        tag = "✉ Email 已寄出" if ok else "✗ Email 失敗"
        log(f"⚠️ {name}（{code}）巨量觸發！5秒量={delta:,.0f}張 門檻={threshold:,.0f}張 {tag}")
        if redis_enabled():
            today = now.strftime("%Y%m%d")
            redis_lpush_json(KEY_ALERTS.format(date=today), {
                "time": now.isoformat(), "code": code, "name": name,
                "price": round(price, 2), "pct": round(change_pct, 2),
                "delta": round(delta), "threshold": round(threshold),
                "emailed": ok,
            })
            redis_set_json(KEY_ALERTED.format(date=today), self.alerted)
            redis_expire(KEY_ALERTED.format(date=today), 3 * 86400)

    def publish_status(self, rows: list, running: bool):
        if not redis_enabled():
            return
        redis_set_json(KEY_STATUS, {
            "updated": now_tw().isoformat(),
            "running": running,
            "market_open": is_market_open(),
            "threshold_ratio": self.settings["threshold_ratio"],
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
    log(f"🚀 台股盤中巨量監控（雲端版）啟動  Redis={'ON' if redis_enabled() else 'OFF（本機模式）'}")

    if once:
        m = Monitor()
        m.setup()
        rows = m.tick(send_alerts=False)
        m.publish_status(rows, running=False)
        log("── 測試抓取結果 ──")
        for r in rows:
            if r.get("ok"):
                log(f"   {r['name']}({r['code']}) 價={r['price']} "
                    f"漲跌={r['pct']:+.2f}% 量(張)累計可用 門檻={r['threshold']:,}")
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
            m.refresh_watchlist()
            rows = m.tick()
            m.publish_status(rows, running=True)
        except Exception as e:
            log(f"⚠️ 本輪更新異常：{e}")
        time.sleep(max(0.5, CHECK_INTERVAL - (time.time() - loop_start)))


if __name__ == "__main__":
    main()
