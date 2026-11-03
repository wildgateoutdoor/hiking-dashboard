# 許願池設定步驟

許願池和入野門團務系統（`index.html`）**完全分開**：

| 頁面 | 給誰 | 說明 |
|---|---|---|
| `wish.html` | 消費者 | 看許願統計圖、點已開的日期報名、許願想去的月份 |
| `wish-admin.html` | 內部 | 設定山的名稱、開團日期，看許願統計、許願名單、報名名單 |

資料放在 Supabase 的 `wish_mountains`、`wish_dates`、`wishes`、`wish_signups`、`wish_alerts`，
都開啟 RLS 且沒有開放 anon，前台只拿得到統計數字。所有讀寫都經過 Edge Function `wish-api`。

## 流程

1. 後台「山與日期」新增山（例如：合歡山北峰），再替它加上開團日期
2. 消費者在 `wish.html`：
   - 點**已開的日期**（或許願時點到綠色的月份）→ 直接跳到**報名表單** → 送出後寄信到內部信箱
   - 點**沒有日期的月份**許願 → 進入許願池
3. 同一座山、同一個月份的許願**達到 3 人**（例如 2027 年 2 月有 3 位許願合歡山）→ 自動寄信到內部信箱，信裡附上許願者名單。
   同一座山同一個月只寄一次；開團後如果想再收一次通知，到「許願名單」篩選那座山與月份 → 「重新開放門檻通知」
4. 同一個 Email 對同一座山同一個月只能許願一次（避免灌票）

## 1. 資料表（已完成）

`supabase/migrations/20261103000000_wish_pool.sql` 已套用。

## 2. Edge Function（已完成）

`wish-api` 已部署（verify_jwt 關閉，前台公開、後台自己驗證密碼）。修改後重新部署：

```bash
supabase functions deploy wish-api --no-verify-jwt
```

## 3. 設定寄信（需要你做）

寄信用 [Resend](https://resend.com)（免費方案每月 3,000 封）。

1. 用**要收通知的那個信箱**註冊 Resend → API Keys → Create API Key
2. Supabase → Edge Functions → **Secrets**，新增：

| 名稱 | 值 |
|---|---|
| `RESEND_API_KEY` | 上一步的 key（`re_` 開頭） |
| `NOTIFY_EMAIL` | 內部信箱，多個用逗號分隔 |

3. 後台「許願統計」→「寄測試信」，收到就完成了

> 沒驗證網域時，Resend 只能寄到**註冊 Resend 的那個信箱**，寄件者是 `onboarding@resend.dev`。
> 想寄到其他信箱或用自己的寄件地址：在 Resend 驗證網域後，再加 secret
> `MAIL_FROM` = `入野門許願池 <notify@你的網域>`。

沒設定的話，許願和報名照常運作，只是不寄信（後台報名名單會顯示「未寄」）。

## 其他設定（選填，都是 Supabase Edge Function secrets）

| 名稱 | 預設 | 說明 |
|---|---|---|
| `WISH_THRESHOLD` | `3` | 同一座山同一個月達幾人寄信 |
| `WISH_ADMIN_PW_HASH` | 與團務系統相同 | 許願池後台密碼的 SHA-256，想用不同密碼時設定 |

## 網址

- 前台：`https://wildgateoutdoor.github.io/hiking-dashboard/wish.html`
- 後台：`https://wildgateoutdoor.github.io/hiking-dashboard/wish-admin.html`
