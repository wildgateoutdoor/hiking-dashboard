# 會員系統設定步驟

會員用 LINE 登入 `member.html`，可以看到自己的會員等級、儲值金餘額、儲值紀錄、買過的行程。
後台在 `index.html` 的「會員管理」頁，可以設定會員等級、手動新增儲值／扣款、新增購買行程。

會員資料放在 Supabase 的 `members`、`member_wallet`、`member_trips` 三張表，都開啟 RLS 且沒有開放 anon，
所以網頁上的公開 key 讀不到。會員和後台都要經過 Edge Function `member-api`：

- 會員：用 LINE ID token 驗證，只拿得到自己的資料
- 後台：用後台登入密碼驗證（在伺服器端檢查）

## 1. 建立資料表

Supabase → SQL Editor，貼上 `supabase/migrations/20261028000000_members.sql` 的內容並執行。

## 2. 建立 LINE Login channel 與 LIFF

1. 到 [LINE Developers](https://developers.line.biz/console/) → 選 Provider → 建立 **LINE Login** channel
2. 記下 Basic settings 裡的 **Channel ID**
3. 進到 **LIFF** 分頁 → Add：
   - Size：Full
   - Endpoint URL：`member.html` 的網址（例如 `https://wildgateoutdoor.github.io/hiking-dashboard/member.html`）
   - Scopes：勾 `openid` 與 `profile`
4. 記下 **LIFF ID**（長得像 `1234567890-AbCdEfGh`）
5. 把 channel 從 Developing 改成 **Published**，否則只有開發者帳號能登入

## 3. 部署 Edge Function

需要安裝 [Supabase CLI](https://supabase.com/docs/guides/cli)，在這個資料夾執行：

```bash
supabase login
```

```bash
supabase link --project-ref dygxochowbhmdftstgoz
```

```bash
supabase secrets set LINE_CHANNEL_ID=你的ChannelID ADMIN_PW_HASH=3f7cfd02d51d09c322fc3c27bdce98e87aabb9847683262e67be13710dfb90b7
```

```bash
supabase functions deploy member-api --no-verify-jwt
```

`ADMIN_PW_HASH` 就是 `index.html` 裡的 `EDIT_PW_HASH`。之後如果改了後台密碼，這裡也要一起改。

## 4. 填入 LIFF ID

打開 `member.html`，把 `const LIFF_ID='YOUR_LIFF_ID';` 換成步驟 2 的 LIFF ID。

## 5. 給會員的連結

`https://liff.line.me/你的LIFF_ID`

可以放在官方帳號的圖文選單、自動回覆或貼文。在 LINE 裡點開會自動登入。

## 使用流程

1. 會員第一次點連結登入後，就會出現在後台「會員管理」列表
2. 後台點會員 → 設定等級、姓名、電話
3. 收到匯款 → 新增一筆「儲值」；要扣錢 → 新增一筆「扣款」
4. 會員報名行程 → 新增行程（可從團務列表帶入），勾「同時從儲值金扣款」會自動記一筆扣款
5. 等級名稱可在「等級設定」修改（預設：一般會員、銀卡會員、金卡會員）
