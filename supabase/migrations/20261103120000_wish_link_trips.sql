-- 許願池改為直接連動團務系統（trips）：
-- 開團日期不再另外維護，改用團務系統中名稱符合、狀態為「報名中」的活動
-- wish_dates 尚無資料，直接移除

alter table public.wish_mountains add column if not exists aliases text[] not null default '{}';  -- 其他對應的團務活動名稱關鍵字

alter table public.wish_signups add column if not exists trip_id text;  -- 對應 trips.id
alter table public.wish_signups drop column if exists date_id;
drop table if exists public.wish_dates;
