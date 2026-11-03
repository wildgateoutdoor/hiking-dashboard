-- 許願池：可許願的山、已開的日期、許願、報名、門檻通知紀錄
-- 全部開啟 RLS 且不開 policy → 前端 anon key 讀寫不到，一律經過 Edge Function wish-api（service role）。
-- 公開頁面只拿得到統計數字，拿不到許願者個資。

create table if not exists public.wish_mountains (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  region      text,                    -- 例：南投縣仁愛鄉
  elevation   integer,                 -- 海拔（公尺），只用來顯示
  sort        integer not null default 0,
  active      boolean not null default true,   -- 關閉後前台看不到、不能許願
  created_at  timestamptz not null default now()
);

-- 我們已經開好的日期（點了直接進報名表單）
create table if not exists public.wish_dates (
  id           uuid primary key default gen_random_uuid(),
  mountain_id  uuid not null references public.wish_mountains(id) on delete cascade,
  start_date   date not null,
  end_date     date,
  note         text,                   -- 例：兩天一夜、山屋
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  check (end_date is null or end_date >= start_date)
);
create index if not exists wish_dates_mountain_idx on public.wish_dates(mountain_id, start_date);

-- 許願：某座山、某個月份（存該月 1 號）
create table if not exists public.wishes (
  id           uuid primary key default gen_random_uuid(),
  mountain_id  uuid not null references public.wish_mountains(id) on delete cascade,
  wish_month   date not null check (extract(day from wish_month) = 1),
  name         text not null,
  email        text not null,          -- 一律小寫
  phone        text,
  note         text,
  created_at   timestamptz not null default now()
);
-- 同一個人對同一座山同一個月只算一次
create unique index if not exists wishes_once_idx on public.wishes(mountain_id, wish_month, email);
create index if not exists wishes_month_idx on public.wishes(mountain_id, wish_month);

-- 報名表單
create table if not exists public.wish_signups (
  id           uuid primary key default gen_random_uuid(),
  date_id      uuid references public.wish_dates(id) on delete set null,
  mountain_id  uuid references public.wish_mountains(id) on delete set null,
  mountain_name text not null,         -- 保留報名當下的山名與日期，日期刪掉也看得到
  start_date   date,
  end_date     date,
  name         text not null,
  email        text not null,
  phone        text not null,
  party_size   integer not null default 1 check (party_size between 1 and 20),
  note         text,
  mailed_at    timestamptz,            -- 通知信寄出時間（空＝沒寄成功）
  created_at   timestamptz not null default now()
);
create index if not exists wish_signups_created_idx on public.wish_signups(created_at desc);

-- 門檻通知：同一座山同一個月份只寄一次
create table if not exists public.wish_alerts (
  mountain_id  uuid not null references public.wish_mountains(id) on delete cascade,
  wish_month   date not null,
  wish_count   integer not null,
  sent_at      timestamptz not null default now(),
  primary key (mountain_id, wish_month)
);

alter table public.wish_mountains enable row level security;
alter table public.wish_dates     enable row level security;
alter table public.wishes         enable row level security;
alter table public.wish_signups   enable row level security;
alter table public.wish_alerts    enable row level security;
