# 團務未完成事項 → LINE 群組自動提醒 設定步驟

**每天 07:00（台灣時間）**自動檢查後台所有梯次，把還沒完成的事整理成一則訊息傳到 LINE 群組，分三段：

1. **⚠️ 已逾期**：到期日已過還沒完成的事（只列還沒出發的活動；正在進行或已結束的不列）
2. **今天要做**
3. **明天要做**

每項的到期日：

| 項目 | 有入園申請的路線 | 沒有入園申請的路線（免申請） |
| --- | --- | --- |
| 入園申請 | 申請截止日 | — |
| 訂包車／包車付款、住宿預訂／付款、餐食預訂／付款、保險／保險付款 | 申請截止日當天 | 出發前 7 天 |
| 天氣提醒 | 出發前 7、3、1 天各一次 | 同左 |
| 行前手冊發放 | 出發前 7 天 | 同左 |
| 未成團處理 | 申請截止日 | 出發前 7 天 |

- 天氣提醒、行前手冊的天數跟著後台「規則設定 → 團務提醒」；那裡新增的其他項目也會一起提醒。
  訂包車、保險的提醒日照上表，不看團務提醒裡設定的天數。
- 在後台打勾完成後就不會再提醒。已結束、倒團、未成團的梯次不提醒；三段都沒有東西的日子不傳。

**不會傳給客人**（官方帳號同時對客人開放時也安全）：
- 只會傳到「後台按過開啟」的群組。客人加好友、私訊打任何字，機器人都不理會，也不會收到團務資料。
- 機器人被拉進任何群組（包括客人自己拉的），只會記下來、**預設不提醒**；確認是團務群組後，到後台按「開啟」。

已開啟的群組可以直接打字：

| 打字 | 作用 |
| --- | --- |
| 待辦 | 已逾期、今天、明天要做的事（跟每天早上的通知一樣）|
| 全部待辦 | 14 天內的待辦清單（含已逾期）|
| 解除提醒 | 停止每日提醒（再開啟請到後台）|
| 團務說明 | 列出指令 |

後台：「規則設定 → LINE 提醒」可以看綁定了哪些群組、預覽今天的訊息、按「立即傳送到群組」。

後台程式：`supabase/functions/line-remind`。排程：`supabase/migrations/20261120000000_line_remind.sql`（pg_cron）。

## 1. 建立 LINE 官方帳號與 Messaging API（只要做一次）

> LINE Notify 已在 2025 年停止服務，所以改用 LINE 官方帳號（機器人）傳訊息到群組。

1. 到 https://manager.line.biz 用入野門的 LINE 帳號登入，建立一個新的官方帳號（建議取名「入野門團務小幫手」，跟對外的官方帳號分開）
2. 進入這個帳號 → 右上「設定」→「Messaging API」→「啟用 Messaging API」（第一次會要你建立 Provider，取名入野門即可）
3. 同一頁複製 **Channel secret**
4. 「設定 → 帳號設定」→「聊天的功能」：**允許加入群組或多人聊天室** 打開
5. 「設定 → 回應設定」：**Webhook 打開**、**自動回應訊息關閉**（不然群組會收到官方帳號的預設回覆）
6. 到 https://developers.line.biz/console/ → 選剛剛的 Provider → 這個 channel → 「Messaging API」分頁：
   - 最下面 **Channel access token (long-lived)** 按「Issue」，複製
   - **Webhook URL** 填 `https://dygxochowbhmdftstgoz.supabase.co/functions/v1/line-remind` → Update → 打開 **Use webhook**

## 2. 把金鑰存到 Supabase（只要做一次）

Supabase → Edge Functions → Secrets，新增兩個：

| 名稱 | 值 |
| --- | --- |
| `LINE_CHANNEL_ACCESS_TOKEN` | 第 1 步的 Channel access token |
| `LINE_CHANNEL_SECRET` | 第 1 步的 Channel secret |

存好後回到 LINE Developers 的 Webhook URL 按「Verify」，顯示 Success 就成功了。

> Supabase Secrets 無法設定時：金鑰也可以存在資料庫 `line_remind_config` 的 `line_token`、`line_secret` 欄位（SQL Editor 執行 `update public.line_remind_config set line_token='…', line_secret='…' where id=1;`）。
> 有值時優先於 Secrets。這張表只有後台程式讀得到，網站前端讀不到。**不要把金鑰寫進程式碼或 migration 檔。**

## 3. 把官方帳號加進團務 LINE 群組

1. 手機 LINE 搜尋官方帳號 ID（在 LINE Official Account Manager 首頁看得到，@ 開頭）→ 加好友
2. 到團務群組 →「邀請」→ 邀請這個官方帳號
3. 到後台「規則設定 → LINE 提醒」，在這個群組按「開啟」
4. 群組打「待辦」測試，或在後台按「立即傳送到群組」

## 注意

- **用對外的官方帳號（同時服務客人）時**：
  - 「回應設定」的自動回應訊息、加入好友的歡迎訊息照原本客人需要的設定即可，不用關。
  - 每月推播則數和對客人的群發訊息共用同一個額度，團務提醒每天約用掉「群組人數」則。

- **免費方案每月 200 則推播**，傳到群組是「群組人數 × 1 則」。例如群組 5 個人、每天傳 1 次 ≈ 150 則／月。
  沒有待辦的日子不傳；在群組打「待辦」是「回覆訊息」，不算在 200 則裡。群組人數多的話，可考慮升級方案或只放負責團務的人。
- 要改提醒時間：到 Supabase → Integrations → Cron → `line-remind-daily`，排程是 UTC 時間（07:00 台灣 = 前一天 23:00 UTC = `0 23 * * *`）。
- 執行結果：後台「LINE 提醒」頁面會顯示上次執行時間與失敗原因。
