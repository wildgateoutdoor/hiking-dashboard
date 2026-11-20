-- 團務未完成事項 → LINE 群組每日提醒（supabase/functions/line-remind）

-- 已綁定的 LINE 群組／聊天室／個人（只有 Edge Function 用 service role 讀寫，前端讀不到）
create table if not exists public.line_targets (
  id text primary key,                 -- LINE groupId / roomId / userId
  kind text not null default 'group',  -- group / room / user
  name text not null default '',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.line_targets enable row level security;

-- 排程呼叫用的金鑰與最後一次執行結果（單列）
create table if not exists public.line_remind_config (
  id int primary key default 1 check (id = 1),
  cron_key text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  last_run jsonb
);
alter table public.line_remind_config enable row level security;
insert into public.line_remind_config (id) values (1) on conflict (id) do nothing;

-- 每天 09:00（台灣時間 = 01:00 UTC）呼叫 line-remind
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'line-remind-daily';
select cron.schedule(
  'line-remind-daily',
  '0 1 * * *',
  $$
  select net.http_post(
    url := 'https://dygxochowbhmdftstgoz.supabase.co/functions/v1/line-remind',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-key', (select cron_key from public.line_remind_config where id = 1)
    ),
    body := '{"action":"cron"}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
