# 📈 台股盤中巨量監控（雲端版）

不用開電腦的台股盤中巨量監控：

- **GitHub Actions**：每個交易日早上自動在雲端啟動，09:00–13:30 連續監控，
  每 5 秒檢查一次成交量，「5 秒量 ≥ 5 日均量 × 門檻」時自動寄 Gmail 警報
- **Next.js 管理網頁（Vercel）**：手機隨時打開就能新增/移除監控股票、
  看即時報價與今日警報記錄、改收件人與門檻
- **Upstash Redis**：兩邊共用的資料庫（監控清單、即時狀態、警報記錄）

```
GitHub Actions（交易日 08:20 自動啟動）
   └─ monitor/monitor.py  每5秒抓報價 → 爆量寄 Gmail
            ↕ 讀清單 / 寫狀態
        Upstash Redis
            ↕ 讀狀態 / 改清單
   Next.js 網頁（Vercel）← 你的手機 / 電腦隨時打開
```

全部使用免費方案：GitHub Actions（公開 repo 免費不限時數）、
Vercel Hobby、Upstash Free。

---

## 安裝步驟

### 第 0 步：撤銷舊的 Gmail 應用程式密碼（重要！）

舊版桌面程式把應用程式密碼寫在程式碼裡，上雲端前先換一組新的：

1. 打開 https://myaccount.google.com/apppasswords
2. **刪除**舊的應用程式密碼
3. 建立一個新的（名稱隨意，例如「台股監控雲端」），記下 16 位密碼

### 第 1 步：Upstash Redis

可以**直接沿用 Hermes 監控那顆資料庫**（本專案的 key 都有 `twstock:` 前綴，
不會跟 `hermes:` 衝突），把它的 REST URL 和 Token 抄下來即可。

想分開的話：到 https://console.upstash.com → Create Database →
Regional（ap-northeast-1 東京）→ 建立後抄下 **REST API** 區的
`UPSTASH_REDIS_REST_URL` 與 `UPSTASH_REDIS_REST_TOKEN`。

### 第 2 步：上傳到 GitHub（公開 repo）

1. 到 https://github.com 建立 **public** repository（名稱如 `twstock-monitor`）
   - 必須是 public：公開 repo 的 Actions 免費不限時數；
     私人 repo 每月只有 2,000 分鐘，盤中監控一個月約用 6,000 分鐘會爆掉
2. 在本資料夾執行：

```bash
git remote add origin https://github.com/你的帳號/twstock-monitor.git
git push -u origin main
```

3. 到 repo 的 **Settings → Secrets and variables → Actions → New repository secret**，
   新增以下 5 個 Secrets（機密只存在這裡，不會出現在公開程式碼中）：

| Secret 名稱 | 內容 |
|---|---|
| `UPSTASH_REDIS_REST_URL` | 第 1 步的 REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | 第 1 步的 REST Token |
| `GMAIL_USER` | 你的 Gmail 地址 |
| `GMAIL_APP_PASSWORD` | 第 0 步新建的 16 位應用程式密碼 |
| `NOTIFY_EMAIL` | 預設收件人（多個用逗號分隔；之後可在網頁上改） |

### 第 3 步：部署管理網頁到 Vercel

1. 到 https://vercel.com（用 GitHub 帳號登入）→ Add New Project → 選 `twstock-monitor`
2. **Environment Variables** 加入 3 個：
   - `UPSTASH_REDIS_REST_URL`（同上）
   - `UPSTASH_REDIS_REST_TOKEN`（同上）
   - `ADMIN_PASSWORD`（自訂一組網頁登入密碼）
3. 按 Deploy，完成後網址形如 `https://twstock-monitor.vercel.app`，
   加到手機主畫面書籤最方便

### 第 4 步：測試

1. **測雲端抓報價**：GitHub repo → Actions → Taiwan Stock Monitor →
   Run workflow → mode 選 `once` → 執行後點進去看 log，
   應該會列出所有股票的 5 日均量和現價
   （這一步同時驗證 GitHub 國外主機連證交所 API 是否正常）
2. **測網頁**：打開 Vercel 網址 → 輸入 ADMIN_PASSWORD →
   應該看到監控清單（第一次執行過 once 之後就有報價快照）
3. 之後每個交易日早上會自動啟動，不需要做任何事

---

## 日常使用（多使用者）

- **登入**：帳號 `admin` ＋ Vercel 環境變數 `ADMIN_PASSWORD` 的密碼；
  其他帳號由 admin 在網頁最下方「帳號管理」建立（自由設定帳號、密碼、收件信箱）
- **每位使用者各自獨立**：自己的監控清單、收件信箱、門檻比例，
  爆量時各自寄信給各自的收件人；雲端監控會同時看所有人的清單
- **加/減監控股票**：開網頁輸入代號按「＋新增監控」即可，
  盤中修改 30 秒內生效（名稱與市場會自動偵測；每人上限 30 檔）
- **改收件人 / 門檻**：網頁「我的通知設定」
- **看今天有沒有爆量**：網頁「今日警報記錄」，或直接看 Gmail
- **盤中即時狀態**：監控執行中時網頁每 5 秒自動更新
- **忘記密碼**：admin 在帳號管理輸入同帳號＋新密碼即可重設；
  admin 自己的密碼到 Vercel → Settings → Environment Variables 改 `ADMIN_PASSWORD`（改完 Redeploy）

舊版單人資料會在升級後第一次使用時自動變成 admin 帳號的清單與設定。

## 設計細節與已知限制

- **排程提早到 08:20**：GitHub 排程尖峰常遲到 5–15 分鐘，
  腳本啟動後會自己等到 08:57 才初始化、09:00 開始監控；
  另外排了 09:05 / 11:00 兩個備援時段，主程序沒起來或中途掛掉會自動接手，
  且接手時會讀取「今日已寄信記錄」，不會重複寄信
- **國定假日**：腳本照常啟動但整天抓不到新成交量，不會誤發警報
  （公開 repo 的 Actions 免費，空跑沒有費用問題）
- **興櫃股**：證交所 MIS 不提供行情的股票自動改用 yfinance
  （延遲約 15 分鐘、成交量每分鐘更新，門檻自動 ×12 維持相同靈敏度）
- **網頁顯示「監控未執行」**：非交易時段是正常的；
  交易時段看到則代表雲端監控掛了，可到 GitHub Actions 頁面手動 Run workflow（mode 選 normal）

## 本機備援執行

雲端壞掉時，本機也能直接跑（讀 repo 裡的 `stocks.json`，不需 Redis）：

```bash
pip install -r monitor/requirements.txt
set GMAIL_USER=你的Gmail
set GMAIL_APP_PASSWORD=應用程式密碼
set NOTIFY_EMAIL=收件人
python monitor/monitor.py
```

## 網頁本機開發

```bash
npm install
copy .env.local.example .env.local   # 填入 Upstash 與 ADMIN_PASSWORD
npm run dev
```
