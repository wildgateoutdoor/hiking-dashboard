-- 許願時可另外填「確切想出發的日期」（選填）
alter table public.wishes add column if not exists preferred_date date;
