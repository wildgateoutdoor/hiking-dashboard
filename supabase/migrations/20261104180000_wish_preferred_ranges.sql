-- 「確切想出發的日期」改為可填多段，每段有第一天與最後一天：[{"start":"2027-02-14","end":"2027-02-16"}, …]
-- 一次許願多個月份時，每個月份各存一筆許願，日期區間相同
alter table public.wishes add column if not exists preferred_ranges jsonb;
