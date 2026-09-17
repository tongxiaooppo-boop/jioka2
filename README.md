# 揪咖 JioKa2 🎉（Firebase 版）

> 跟一代 [jioka](../jioka) 同一套玩法：一群人用**月曆勾選**方便的日期時段、**票選地點**、留言提建議，即時統計哪個方案最熱門。
> 一代用 Google 試算表當後端，人多／資料多時讀寫明顯變慢；這個版本把後端換成 **Firebase（Firestore + Authentication）**，改善回應速度，一樣完全免費、不用綁信用卡。

**目前狀態：已上線** — https://tongxiaooppo-boop.github.io/jioka2/ （GitHub repo：https://github.com/tongxiaooppo-boop/jioka2）

> 📘 完整部署教學 + 使用手冊，也有網頁版：[`docs/guide.html`](docs/guide.html)（部署到 GitHub Pages 後可透過 `.../guide.html` 開啟，或直接看 https://tongxiaooppo-boop.github.io/jioka2/guide.html ）。

這是**獨立的新專案**（新 GitHub repo `jioka2`），舊版 `jioka`（試算表版）原封不動、繼續運作，兩者資料庫互不相通。

## ✨ 功能特色

跟一代完全相同的功能（月曆投票、地點票選、留言、主揪/次管理者、再揪一次、我的揪咖紀錄、結果卡、管理後台、CSV 匯出），差別只在後端架構與同步速度，另外上線後又補了幾個細節：

- ⚡ **即時同步**：改用 Firestore `onSnapshot` 即時推送，不用像一代等 10 秒輪詢
- 🚀 **回應更快**：Firestore 讀寫遠快於 Google 試算表 API
- 🔓 **登入更簡單**：Firebase Authentication 內建處理 Google 登入與 token 驗證，不用像一代那樣另外申請 OAuth 用戶端、也不用發布「正式版」
- 📅 **月曆改成滾動週視窗**：固定顯示「這週日～往後 5 週」，今天以前一律擋掉不能選；上方「‹ 往前一週 / 往後一週 ›」一週一週捲動看更遠的日期，不是整批跳一個月
- ⏰ **截止時間**：建立活動時預設帶入「7 天後晚上 8 點」，也擋掉選到過去的時間點（前端 `min` 限制 + 後端 `createEvent` 再擋一次）

## 🏗️ 系統架構

```
[前端：靜態網頁 Vanilla JS（docs/），部署於 GitHub Pages]
        │  Firebase JS SDK（直接讀寫，無中間 API 伺服器）
        ▼
[Firebase Authentication：Google 登入]
[Firestore：資料庫 + 安全規則 firestore.rules 作為唯一權限邊界]
```

- 前端無框架、無建置步驟，改完推上 GitHub 即生效
- **沒有後端伺服器**：所有權限判斷（誰是主揪/次管理者、投票時間是否截止、暱稱唯一性…）都寫在 [`firestore.rules`](firestore.rules) 裡，這是整個系統唯一的安全邊界
- 投票用「doc id = 使用者 uid」設計，改票直接覆寫整份文件，天然不需要像一代 GAS 版那樣用全域鎖保護，人多時也不會卡住
- Email 只存在私有子集合（`private/roles`、`participantsPrivate`），公開資料一律只有暱稱，訪客與其他參與者看不到別人的 Email

## 📁 專案結構

```
jioka2/
├── docs/                  # 前端靜態網頁（GitHub Pages 指到這個資料夾）
│   ├── index.html
│   ├── style.css          # 與一代共用，外觀一致
│   ├── config.js          # 【部署前必改】Firebase 設定 + Google Client ID
│   ├── firebase-init.js   # Firebase App / Auth / Firestore 初始化
│   ├── data.js            # 資料存取層（取代一代 Code.gs 的 API）
│   ├── app.js             # 前端主程式（UI 邏輯與一代幾乎相同）
│   └── guide.html         # 網頁版部署手冊
├── firestore.rules        # 【部署前必上傳到 Firebase】安全規則
├── firebase.json          # 方便用 `firebase deploy --only firestore:rules`
└── README.md
```

## 🚀 部署（6 步驟，約 15～20 分鐘）

1. **建立 Firebase 專案**：[console.firebase.google.com](https://console.firebase.google.com) → 新增專案 → 專案設定 → 新增網頁應用程式，複製 `firebaseConfig`
2. **啟用 Authentication**：左側「Authentication」→ Sign-in method → 啟用 Google → 複製「網路用戶端 ID」
3. **⚠️ 容易漏掉：Google Cloud Console 補一個已授權的 JavaScript 來源**：[console.cloud.google.com](https://console.cloud.google.com) → 同一個專案 →「API 和服務」→「憑證」→ 找到跟步驟 2 同一組 OAuth Client → 「已授權的 JavaScript 來源」加上 `https://<你的帳號>.github.io`（只到 `.io`，不加路徑）。這跟 Firebase 的「已授權網域」是兩份不同清單，漏了這步登入會出現 `origin_mismatch` 錯誤
4. **建立 Firestore + 部署規則**：左側「Firestore Database」→ 建立資料庫（新版介面若出現「選取版本」，選 Standard 版；正式版模式啟動）→「規則」分頁貼上整份 [`firestore.rules`](firestore.rules) → 發布
5. **設定前端**：編輯 `docs/config.js`，填入步驟 1 的 `firebaseConfig` 與步驟 2 的 Client ID
6. **部署到 GitHub Pages**：推到新的 GitHub repo → Settings → Pages → Branch 選 `main`、資料夾選 `/docs`

詳細每一步的畫面說明、驗收測試清單、資料模型、FAQ，見 [`docs/guide.html`](docs/guide.html)。

## ⚠️ 安全規則是唯一防線

因為前端直接讀寫 Firestore（沒有後端伺服器把關），`firestore.rules` 的正確性等同於整個系統的安全性。修改資料模型或新增功能時：

- 一定要同步更新規則，不要只改 `docs/data.js` 就上線
- 改完規則先用 Firebase Console 的「規則playground」或本機模擬器（`firebase emulators:start`）測過權限邊界（例如次管理者不能刪主揪的選項、投票截止後不能再投）再部署
- 不要把任何 Email 欄位加進公開可讀的集合（`events`、`options`、`votes`、`comments`、`participants`），Email 只能放進 `private/roles` 或 `participantsPrivate`

上線前這三個檔案（`firestore.rules` / `docs/data.js` / `docs/app.js`）已經過兩輪獨立審查並修掉找到的問題（XSS、權限繞過、暱稱唯一性沒綁定等），細節沒有另外存檔，之後要再動這幾個檔案，建議重新走一次審查而不是憑印象。
