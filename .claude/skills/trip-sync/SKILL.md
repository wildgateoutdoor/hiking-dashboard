---
name: trip-sync
description: 入野門報名表 → 後台團務同步。使用者說「更新團務」「更新報名資料／人數」「同步報名表」「把報名表更新到團務系統」，或要調整報名表同步規則（哪些欄位、怎麼分梯、刪除線、出團日期…）時使用。規則同時寫在 supabase/functions/trip-sync（每天 07:50、18:00 自動同步用）；手動更新必須用這個 skill 的腳本跑「同一份」後端程式，不要另寫一套邏輯。
---

# 入野門報名表 → 團務同步

## 資料來源

- 報名表單資料夾（兩個都要讀）：
  - 多日付費活動（山）：`1179tJGVgcX-lPaF5aXE6Am6sjIerW8Hr`
  - 單日付費：`1qtllDwJNPkks-QKxQ1i60MHmRznKqkih`
  - 讀資料夾裡所有標題含「回覆」的試算表；標題有 ❌ 的停用表單不讀。
  - **只有表單、沒有回覆試算表＝還沒有人報名**，略過。
- 每份試算表只讀**第一頁「表單回覆」**（不是日期分頁）。表頭在前 5 列裡有「姓名」的那列。
- 後台：Supabase 專案 `dygxochowbhmdftstgoz` 的 `trips` 表（`data` jsonb）。

## 規則（每次更新都照這套）

1. **分梯日期**：
   - 該列有填「**出團日期**」欄，而且看得出日期 → **以出團日期為準**（客服換梯後改的）。
   - 出團日期空白或看不出日期（例：`0`、`2027???`）→ 用「**行程日期**」（客人報名時選的）。行程日期有好幾欄（例：富士山 2天／3天／5天各一欄）就取第一個有填的。
   - 出團日期已經是過去的日期 → 已出團，略過。
   - 出團日期是未來但對不到梯次（多半是打錯，例：`2027/12/31` 應為 2026）→ 先用行程日期，並在該梯「⚠️ 需要手動確認」提醒。
   - 沒寫年份 → 用「時間戳記」（填表時間）推算：出發日不會早於填表日。
2. **路線**：行程日期「｜」前的名稱（例：`富士山5天4夜｜…`）完全對到後台活動名稱就用它；否則用試算表標題（去掉「入野門-」「N天N夜」「報名表」「(回覆)」等，例：阿里山眠月線 → 後台名稱被包含在標題裡的「眠月線」）。比對時忽略空白、＋、＆、表情符號。
3. **對梯次**：同路線、同一天出發的梯次；沒有的話找日期範圍涵蓋那天的梯次（例：玉山表單寫登山日 12/25，後台 12/24 出發）。
4. **刪除線＝取消**：姓名被槓掉，或那列一半以上有內容的格子被槓掉 → 不算這個人。
5. **人數**：同一梯同名只算一人（取最後一筆，同一人重填表單）；姓名 `test`／`測試` 不算。
6. **已結束的梯次不更新**。之前從同一份報名表同步過、這次沒人選的梯次（全部換梯或槓掉）→ 歸零。
7. **更新的欄位**（其他欄位一律不動）：
   - `registered` 報名人數
   - `equipRenters`／`equipment` 裝備租借：依後台「裝備費用」比對品項；名稱互相包含也算（睡袋→羽絨睡袋、蛋殼睡墊→睡墊）。報名表來的標 `src:"sheet"`；後台手動加、且不在報名表的人保留。
   - `porterBuyers`／`porter` 代揹：「代背4公斤*2天」→ 4kg × 2 天；沒寫天數用行程天數；依「代揹費用」計價。
   - `diet` 餐食需求：葷／素人數、「不能吃什麼」、「過敏」。「無」「都吃」「都有」「不需要」「無特殊需求」等視為沒有。沒有葷素欄（一日行程）就只列不吃、過敏。
   - `startPoints` 出發地點：「行程費用」那題（上車地點）照原文分組，各地人數與名單；表單沒有這題就不記錄。
   - `excelLink` 報名名單連結：空白時補上這份回覆試算表的網址，手動填過的不覆蓋。
   - `sheetSync` 同步時間、來源、看不懂要人工確認的內容（`warnings`）。
8. **個資**：只讀時間戳記、出團日期、行程日期、姓名、出發地點、租借、代揹、葷素、不吃、過敏。身分證、電話、地址、護照等不讀、不送、不印出來。

## 手動更新步驟

1. **列出試算表**：Google Drive `search_files`，兩個資料夾各查一次（`parentId = '<資料夾 id>'`），挑出標題含「回覆」、沒有 ❌ 的試算表。
2. **下載**：每份用 `download_file_content`，`exportMimeType` = `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`（要 xlsx 才讀得到刪除線）。工具會回報存檔路徑。
3. **寫 manifest**（scratchpad）：`[{"title": "試算表標題", "id": "檔案 id", "file": "下載的 xlsx 路徑"}, …]`
4. **解析**：`python3 -I .claude/skills/trip-sync/scripts/readxl.py manifest.json > sheets.json`
5. **取後台現況**（只取同步需要的欄位；手動加的租借者／代揹才需要，報名表來的會重算）：
   ```sql
   select json_agg(json_build_object('id',id,'data',jsonb_strip_nulls(jsonb_build_object(
     'name',data->'name','date',data->'date','dateEnd',data->'dateEnd','registered',data->'registered','excelLink',data->'excelLink',
     'sheetSync',case when data ? 'sheetSync' then jsonb_build_object('source',data->'sheetSync'->'source') end,
     'equipRenters',(select jsonb_agg(r) from jsonb_array_elements(case when jsonb_typeof(data->'equipRenters')='array' then data->'equipRenters' else '[]' end) r where r->>'src' is distinct from 'sheet'),
     'porterBuyers',(select jsonb_agg(b) from jsonb_array_elements(case when jsonb_typeof(data->'porterBuyers')='array' then data->'porterBuyers' else '[]' end) b where b->>'src' is distinct from 'sheet')))))
   from trips where coalesce(data->>'dateEnd', data->>'date') >= to_char(now() at time zone 'Asia/Taipei','YYYY-MM-DD');
   ```
   存成 `trips.json`；`settings` 表 `equipPricing`、`porterPricing` 存成 `settings.json`（`[{key,data}]`）。
6. **計算**：`node --experimental-strip-types .claude/skills/trip-sync/scripts/compute.ts sheets.json trips.json settings.json update.sql`
   - 用的是 `supabase/functions/trip-sync/index.ts` 本身，規則和自動同步完全一致。
   - 會印出每梯「人數 舊 → 新」、租借、代揹、警告、對不到的列。
7. **檢查再寫入**（使用者在線時）：人數變化大的（例如差很多、整梯歸零）先跟使用者確認；有測試資料、打錯的日期要提出來。沒問題就用 `execute_sql` 執行**整份** `update.sql`（人數沒變的梯次也要寫，這樣後台「已從報名表同步（時間）」才會顯示最後一次檢查的時間），再查一次人數確認。
   **排程自動執行時（每天早晚各一次，沒人在線）**：直接寫入整份 `update.sql`（沒變的梯次也寫，更新同步時間），但遇到下面情況那一梯先**不寫**，留到回報裡請使用者確認：
   - 人數比後台少一半以上，而且後台原本 ≥ 3 人（可能讀錯或大量取消）。
   - 整份試算表讀不到任何列，或對不到梯次的列很多（表單格式可能變了）。
8. **回報**：列出有變動的梯次（舊 → 新）、被槓掉移除的人數、需要手動確認的項目。

## 改規則時

規則只寫在 `supabase/functions/trip-sync/index.ts`（後端）＋ `apps-script/trip-sync-all.gs`（讀哪些欄位）。改完要：
1. 部署 Edge Function `trip-sync`（`verify_jwt: false`）。
2. 更新本檔「規則」與 `TRIP_SYNC_SETUP.md`。
3. 開 PR 並合併上線（使用者要求：不要漏掉 merge）。
4. 如果 Apps Script 有改，提醒使用者重新複製貼上 `apps-script/trip-sync-all.gs`。
