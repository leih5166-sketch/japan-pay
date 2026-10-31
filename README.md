# 拍招牌找優惠｜日本刷哪張（免費更新版）

在日本用 GPS 定位或輸入店名，就能看到這家店的優惠券，以及刷哪張台灣信用卡或電子支付回饋最高。任何人打開網址就能使用，不需要帳號。

這個版本的**每日資料更新完全免費**：不使用任何 AI，由 GitHub 每天自動執行程式，抓取幾個固定的比較網頁，按照規則擷取最新的優惠券和回饋數字。

## 檔案說明

| 檔案 | 用途 |
| --- | --- |
| `public.html` | 公開免費版網站：GPS、店名搜尋、優惠券、刷卡排名 |
| `index.html` | 完整版：多了拍照辨識（需要另外設定，見最後一節，會產生費用） |
| `scripts/scrape.mjs` | 免費爬蟲，每天抓取網頁並更新資料 |
| `.github/workflows/update-data.yml` | 讓 GitHub 每天自動執行爬蟲 |
| `data/sources.json` | 爬蟲抓取的網頁清單，以及店名對照表 |
| `data/base.json` | 各張卡和電子支付的基本設定（名稱、條件、指定通路） |
| `data/data.json` | 網站實際讀取的資料（自動更新） |
| `data/update-log.json` | 每次更新的紀錄：哪些資料變了、哪些來源抓取失敗 |
| `worker/worker.js` | 拍照辨識用的中繼服務（選用） |

## 費用

- **網站、GPS、店名搜尋、刷卡排名、每日更新**：全部免費。
- **拍照辨識**（選用）：每辨識一張照片需付一次 Claude API 費用。不設定的話，就完全沒有任何費用。

---

## 步驟 1：把網站放上 GitHub

1. 到 https://github.com 註冊帳號。
2. 右上角 **＋ → New repository**，名稱例如 `japan-pay`，選 **Public**，按 **Create repository**。
3. 點 **uploading an existing file**，把資料夾裡的 `index.html`、`public.html`、`README.md`、`data`、`scripts`、`worker` 拖進去，按 **Commit changes**。
4. `.github` 是隱藏資料夾，通常拖不上去，請改用這個方法建立：
   - 按 **Add file → Create new file**
   - 檔名輸入 `.github/workflows/update-data.yml`
   - 打開專案中的 `update-data.yml`，把內容全部複製貼上，按 **Commit changes**

## 步驟 2：開啟網站

1. **Settings → Pages**。
2. **Source** 選 **Deploy from a branch**，Branch 選 **main**、資料夾選 **/ (root)**，按 **Save**。
3. 等 1～2 分鐘後重新整理，就會看到網址。公開版網址是：
   `https://你的帳號.github.io/japan-pay/public.html`

## 步驟 3：開啟每日自動更新

1. 點上方的 **Actions** 分頁。如果看到提示，按 **I understand my workflows, go ahead and enable them**。
2. 左側點 **每日更新優惠資料（免費爬蟲）**，右側按 **Run workflow → Run workflow**，先手動測試一次。
3. 大約 1 分鐘會跑完。點進去可以看到「更新結果」，列出這次更新了哪些資料、哪些來源抓取失敗。

之後每天台灣時間清晨 5 點會自動執行，不需要任何金鑰或設定。

---

## 爬蟲怎麼運作

| 資料 | 來源 |
| --- | --- |
| 信用卡回饋、PayPay 電子支付活動期限 | 「這就是人生」日本信用卡比較表 |
| 各店家優惠券 | 卡優新聞網日本優惠券整理 |
| 唐吉訶德優惠券 | LIVE JAPAN 官方合作頁 |

**安全機制：**
- 爬蟲只在確定解析成功時才更新數值。抓不到網頁、或解析結果明顯不對（例如只抓到幾筆）時，會保留前一天的資料，網站不會壞掉。
- 已過期的優惠券和活動會自動移除。
- 每次更新都會寫進 `data/update-log.json`，並顯示在 Actions 的執行結果頁。

**需要知道的限制：**
- 如果來源網站改版，爬蟲可能抓不到新資料。這時網站會繼續顯示最後一次成功的資料，頁尾也會顯示「部分來源暫時無法更新」。到 Actions 查看紀錄，把錯誤訊息貼給 Claude 就能協助修正。
- 每年初，來源網站常會發新文章（網址會變）。到時請修改 `data/sources.json` 裡的網址。
- 爬蟲只會更新已收錄卡片的回饋%、上限和期限。若出現全新的信用卡，需要在 `data/base.json` 新增一筆，並設定 `match` 關鍵字。
- 聯邦吉鶴卡和 PayPay 電子支付的回饋結構比較複雜，爬蟲只會自動更新它們的活動期限，回饋%維持 `base.json` 裡的設定。

---

## 選用：開啟拍照辨識（會產生費用）

拍照辨識需要 AI 看照片，所以要付費使用 Claude API。如果不需要，可以略過這一節。

1. 到 https://console.anthropic.com 註冊、儲值，並在 **Limits** 設定每月花費上限，然後建立 API 金鑰。
2. 到 https://dash.cloudflare.com 註冊，**Workers & Pages → Create → Create Worker**，按 **Deploy**。
3. 按 **Edit code**，貼上 `worker/worker.js` 的全部內容，按 **Deploy**。
4. 在這個 Worker 的 **Settings → Variables and Secrets** 新增：
   - `ANTHROPIC_API_KEY`（Secret）：你的 API 金鑰
   - `ALLOWED_ORIGIN`（Text）：`https://你的帳號.github.io`
5. 回到 GitHub 編輯 `index.html`，把 Worker 網址填進 `const WORKER_URL = '';` 的引號裡。

完成後，`index.html` 會出現拍照按鈕。`public.html` 永遠不會呼叫 API，不會產生費用。

---

## 選用：附近餐廳優惠券（Hot Pepper，免費）

開啟後，按「GPS 找附近店家」時，會同時列出附近 1 公里內**有優惠券的餐廳**（包含連鎖店），每家都有「打開優惠券」按鈕。完全免費。

1. 到 https://webservice.recruit.co.jp/register 用 Email 註冊，信箱會收到 API 金鑰。
2. 到 Cloudflare 建立一個新的 Worker（例如 `japan-pay-hotpepper`），貼上 `worker/hotpepper.js` 的全部內容，按 **Deploy**。
3. 在這個 Worker 的 **Settings → Variables and Secrets** 新增：
   - `HOTPEPPER_KEY`（Secret）：Hot Pepper 的 API 金鑰
   - `ALLOWED_ORIGIN`（Text）：`https://你的帳號.github.io`
4. 回到 GitHub，分別編輯 `public.html` 和 `index.html`，把 Worker 網址填進 `const HOTPEPPER_URL = '';` 的引號裡。

依照 Hot Pepper 的使用規定，網站上會顯示「Powered by ホットペッパー Webサービス」字樣，請不要移除。
