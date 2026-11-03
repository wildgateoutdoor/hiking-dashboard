-- 許願池：山的介紹與體驗分類（「我想探索看看」用），以及「找不到想去的山」自填許願

alter table public.wish_mountains
  add column if not exists intro text,                              -- 前台介紹文字
  add column if not exists tags  text[] not null default '{}';      -- 體驗分類：親子同樂、迷霧森林…

-- 許願可以是清單裡的山（mountain_id），或自己填的山名（custom_name），二擇一
alter table public.wishes alter column mountain_id drop not null;
alter table public.wishes add column if not exists custom_name text;
alter table public.wishes drop constraint if exists wishes_target_chk;
alter table public.wishes add constraint wishes_target_chk check ((mountain_id is null) <> (custom_name is null));
create unique index if not exists wishes_custom_once_idx on public.wishes(lower(custom_name), wish_month, email) where mountain_id is null;

-- 門檻通知也要能記錄自填的山
alter table public.wish_alerts drop constraint if exists wish_alerts_pkey;
alter table public.wish_alerts alter column mountain_id drop not null;
alter table public.wish_alerts add column if not exists custom_name text;
create unique index if not exists wish_alerts_once_idx
  on public.wish_alerts((coalesce(mountain_id::text, 'c:' || lower(custom_name))), wish_month);
