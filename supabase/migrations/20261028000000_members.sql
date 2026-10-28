-- 會員系統：會員資料、儲值紀錄、購買行程
-- 三張表都開啟 RLS 且不開任何 policy → 前端 anon key 讀不到也寫不了，
-- 只能透過 Edge Function（member-api，用 service role）存取。

create table if not exists public.members (
  id            uuid primary key default gen_random_uuid(),
  line_user_id  text not null unique,
  line_name     text,
  line_picture  text,
  real_name     text,
  phone         text,
  tier          text not null default '一般會員',
  note          text,               -- 後台內部備註，會員看不到
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

-- 儲值金流水帳：正數＝儲值，負數＝扣款；餘額＝加總
create table if not exists public.member_wallet (
  id         uuid primary key default gen_random_uuid(),
  member_id  uuid not null references public.members(id) on delete cascade,
  amount     integer not null,
  note       text,
  txn_date   date not null default current_date,
  created_at timestamptz not null default now()
);
create index if not exists member_wallet_member_idx on public.member_wallet(member_id);

create table if not exists public.member_trips (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid not null references public.members(id) on delete cascade,
  trip_id       text,               -- 對應 trips.id（可空，手動輸入的行程沒有）
  trip_name     text not null,
  trip_date     date,
  trip_date_end date,
  price         integer,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists member_trips_member_idx on public.member_trips(member_id);

alter table public.members       enable row level security;
alter table public.member_wallet enable row level security;
alter table public.member_trips  enable row level security;
