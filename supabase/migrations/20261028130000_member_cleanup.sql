-- 收尾：移除已由 member_ledger 取代的舊儲值表（無資料），行程金額改為 DECIMAL
drop table if exists public.member_wallet;
alter table public.member_trips alter column price type numeric(12,0);
