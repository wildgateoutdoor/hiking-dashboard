-- 許願人數：一筆許願可以代表好幾個人（例如「預計 4 人出發」），統計與門檻都以人數計算
-- submission_id：同一次送出的許願（日期跨月時會拆成好幾筆）共用一個 id，月曆可以還原完整的日期區間
alter table public.wishes add column if not exists party_size integer not null default 1 check (party_size between 1 and 30);
alter table public.wishes add column if not exists submission_id uuid;
