# 會員系統設定步驟

會員用 Google（Gmail）帳號登入 `member.html`，可以看到自己的會員等級、儲值金餘額、儲值紀錄、買過的行程。
後台在 `index.html` 的「會員管理」頁，可以新增會員、設定會員等級、手動新增儲值／扣款、新增購買行程。

會員資料放在 Supabase 的 `members`、`member_wallet`、`member_trips` 三張表，都開啟 RLS 且沒有開放 anon，
所以網頁上的公開 key 讀不到。會員和後台都要經過 Edge Function `member-api`：

- 會員：Google 登入後，伺服器用登入 token 裡的 email 找會員，只拿得到自己的資料
- 後台：用後台登入密碼驗證（在伺服器端檢查）

會員是用 **email** 對應的：後台可以先用 Gmail 建好會員、輸入儲值和行程，會員之後用同一個 Google 帳號登入就會看到。
沒先建的人登入後也會自動變成「一般會員」。

## 1. 建立資料表（已完成）

`supabase/migrations/20261028000000_members.sql` 已套用到 hiking-dashboard 專案。

## 2. 建立 Google OAuth 用戶端

1. 到 [Google Cloud Console](https://console.cloud.google.com/) → 建立（或選）一個專案
2. 「API 和服務」→「OAuth 同意畫面」：User Type 選「外部」，填應用程式名稱（例如：入野門會員中心）、支援 email，然後**發布應用程式**（不發布的話只有測試使用者能登入）
3. 「API 和服務」→「憑證」→「建立憑證」→「OAuth 用戶端 ID」：
   - 應用程式類型：網頁應用程式
   - 已授權的重新導向 URI：`https://dygxochowbhmdftstgoz.supabase.co/auth/v1/callback`
4. 記下 **用戶端 ID** 和 **用戶端密鑰**

## 3. 在 Supabase 開啟 Google 登入

1. Supabase → Authentication → Sign In / Providers → **Google** → 開啟，貼上步驟 2 的用戶端 ID 和密鑰
2. Authentication → URL Configuration → **Redirect URLs** 加入 `member.html` 的網址
   （例如 `https://wildgateoutdoor.github.io/hiking-dashboard/member.html`）

## 4. 部署 Edge Function（已完成）

`member-api` 已部署（verify_jwt 關閉，函式自己驗證身分）。之後修改程式後重新部署：

```bash
supabase functions deploy member-api --no-verify-jwt
```

後台密碼比對的是 `index.html` 裡的 `EDIT_PW_HASH`（函式裡有同一個值）。改後台密碼時兩邊要一起改，
或在 Supabase 設定 secret `ADMIN_PW_HASH` 覆蓋。

## 5. 給會員的連結

直接給 `member.html` 的網址。

注意：Google 不允許在 App 內建的瀏覽器登入（LINE、Facebook、Instagram 裡點開的網頁）。

- 從 **LINE** 點開：頁面會自動跳到手機的 Safari / Chrome
- 從 **FB / IG** 點開：頁面會提示會員點右上角「用瀏覽器開啟」，也可以按「複製網址」

## 使用流程

1. 後台「會員管理」→「新增會員」，輸入會員的 Gmail（也可以等會員自己登入後再出現）
2. 點會員 → 設定等級、姓名、電話
3. 收到匯款 → 新增一筆「儲值」；要扣錢 → 新增一筆「扣款」
4. 會員報名行程 → 新增行程（可從團務列表帶入），勾「同時從儲值金扣款」會自動記一筆扣款
5. 等級名稱可在「等級設定」修改（預設：一般會員、銀卡會員、金卡會員）
