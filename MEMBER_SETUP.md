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

## 金流設計（儲值金與回饋金）

會員有兩個帳戶：**儲值金**、**入野門回饋金**。所有異動都記在 `member_ledger` 流水帳，`member_accounts` 是餘額快照。

- **金額**：資料庫一律 `numeric(12,0)`（整數元），前端以字串傳送，不經過浮點數；加減與餘額檢查全部在資料庫函式內完成
- **流水帳只能新增**：每筆記錄流水號、會員、帳戶、類型、金額、交易前餘額、交易後餘額、時間。
  觸發器禁止 UPDATE / DELETE / TRUNCATE，記錯請用「沖正」新增一筆反向紀錄（每筆只能沖正一次）
- **交易（ACID）**：`member_purchase_trip` 在同一個資料庫交易內建立行程、扣儲值金、扣回饋金，任一步失敗（例如餘額不足）全部 Rollback；
  `member_cancel_trip` 取消行程並自動沖正該行程的扣款
- **併發**：`ledger_post` 以 `SELECT … FOR UPDATE` 鎖住該會員該帳戶的快照列（悲觀鎖），同一帳戶的交易排隊執行，不會超扣
- **冪等**：每筆請求帶唯一識別碼（後台送出時產生，重試沿用同一個），`idempotency_key` 有 unique 限制，重送只會入帳一次
- **快照驗證**：交易提交前，deferred constraint trigger 檢查「快照 = 流水帳加總 = 最後一筆交易後餘額」，不一致整筆 Rollback；
  後台「對帳檢查」會全體重新核對一次
- 函式只開放 `service_role`（member-api）呼叫，前端 anon key 無法直接呼叫

已有金流紀錄的會員不能刪除（保留帳務）。

### 尚未執行的收尾 migration

`supabase/migrations/20261028130000_member_cleanup.sql`：刪除已不用的空表 `member_wallet`、把 `member_trips.price` 改為 `numeric`。
這步需要在 Supabase 確認，不影響功能，有空再執行。

