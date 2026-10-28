-- 會員金流：交易流水帳（Ledger）+ 嚴格快照
--
-- 帳戶（account）：stored＝儲值金、rebate＝入野門回饋金
-- 設計原則：
--   1. 金額一律 numeric（DECIMAL），整數元，不使用浮點數
--   2. 每筆異動都是 member_ledger 的一列，只能新增，不能修改或刪除（錯了用「沖正」反向入帳）
--   3. member_accounts 是餘額快照，只由 ledger_post() 在同一個交易內更新；
--      交易提交前由 deferred constraint trigger 驗證「快照 = 流水帳加總」，不一致整筆 Rollback
--   4. 併發：ledger_post() 以 SELECT ... FOR UPDATE 鎖住該會員該帳戶的快照列（悲觀鎖）
--   5. 冪等：每筆流水帳有唯一的 idempotency_key，重送同一個 key 會回傳第一次的結果，不會重複入帳
--   6. 所有函式只開放 service_role（member-api）呼叫，前端 anon key 無法直接呼叫

-- ── 會員期限 ──
alter table public.members add column if not exists expires_at date;

-- ── 舊的儲值表（尚無資料）改由流水帳取代 ──
drop table if exists public.member_wallet;

-- ── 購買行程：改為不可刪除，只能取消（取消時自動退款） ──
alter table public.member_trips
  alter column price type numeric(12,0),
  add column if not exists status text not null default 'active',
  add column if not exists cancelled_at timestamptz,
  add column if not exists idempotency_key text;
alter table public.member_trips
  add constraint member_trips_status_chk check (status in ('active', 'cancelled')),
  add constraint member_trips_price_chk check (price is null or price >= 0),
  add constraint member_trips_idem_key unique (idempotency_key);

-- ── 餘額快照 ──
create table public.member_accounts (
  member_id  uuid not null references public.members(id) on delete cascade,
  account    text not null check (account in ('stored', 'rebate')),
  balance    numeric(12,0) not null default 0 check (balance >= 0),
  version    bigint not null default 0,          -- = 該帳戶流水帳筆數，也是最後一筆的 seq
  updated_at timestamptz not null default now(),
  primary key (member_id, account)
);

-- ── 交易流水帳 ──
create table public.member_ledger (
  id              bigint generated always as identity primary key,   -- 流水號
  member_id       uuid not null references public.members(id) on delete restrict,
  account         text not null check (account in ('stored', 'rebate')),
  seq             bigint not null,                -- 該會員該帳戶的第幾筆，用來驗證帳鏈連續
  txn_type        text not null check (txn_type in ('topup', 'spend', 'grant', 'deduct', 'reversal')),
  amount          numeric(12,0) not null check (amount <> 0),        -- 有正負號：+ 入帳、- 出帳
  balance_before  numeric(12,0) not null,
  balance_after   numeric(12,0) not null check (balance_after >= 0),
  note            text,
  txn_date        date not null default current_date,
  trip_ref        uuid,                           -- 對應 member_trips.id（不設 FK，流水帳不可被連動修改）
  reverses_id     bigint unique references public.member_ledger(id), -- 沖正哪一筆；unique → 每筆最多被沖正一次
  idempotency_key text not null unique,
  created_at      timestamptz not null default now(),
  unique (member_id, account, seq),
  check (balance_after = balance_before + amount),
  -- 類型、帳戶、正負號必須一致
  check (
    (txn_type = 'topup'  and account = 'stored' and amount > 0) or
    (txn_type = 'spend'  and account = 'stored' and amount < 0) or
    (txn_type = 'grant'  and account = 'rebate' and amount > 0) or
    (txn_type = 'deduct' and account = 'rebate' and amount < 0) or
    (txn_type = 'reversal' and reverses_id is not null)
  )
);
create index member_ledger_member_idx on public.member_ledger(member_id, id desc);
create index member_ledger_trip_idx on public.member_ledger(trip_ref) where trip_ref is not null;

alter table public.member_accounts enable row level security;
alter table public.member_ledger   enable row level security;
revoke all on public.members, public.member_trips, public.member_accounts, public.member_ledger from anon, authenticated;

-- ── 流水帳只能新增 ──
create function public.member_ledger_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '流水帳不可修改或刪除，請使用沖正';
end $$;
create trigger member_ledger_no_update before update or delete on public.member_ledger
  for each row execute function public.member_ledger_immutable();
create trigger member_ledger_no_truncate before truncate on public.member_ledger
  for each statement execute function public.member_ledger_immutable();

-- ── 快照驗證：交易提交前檢查快照與流水帳一致 ──
create function public.member_accounts_verify() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_cur public.member_accounts;
  v_sum numeric(12,0);
  v_cnt bigint;
  v_last numeric(12,0);
begin
  -- deferred trigger 拿到的 NEW 是事件當下的版本；要驗證的是提交前的最終狀態，所以重新讀
  select * into v_cur from public.member_accounts
    where member_id = new.member_id and account = new.account;
  if not found then return null; end if;
  select coalesce(sum(amount), 0), count(*) into v_sum, v_cnt
    from public.member_ledger where member_id = new.member_id and account = new.account;
  select balance_after into v_last
    from public.member_ledger where member_id = new.member_id and account = new.account
    order by seq desc limit 1;
  if v_cur.balance <> v_sum or v_cur.version <> v_cnt or v_cur.balance <> coalesce(v_last, 0) then
    raise exception '帳務驗證失敗：快照與流水帳不一致（member %, account %）', new.member_id, new.account;
  end if;
  return null;
end $$;
create constraint trigger member_accounts_verify after insert or update on public.member_accounts
  deferrable initially deferred for each row execute function public.member_accounts_verify();

-- ── 核心：入帳一筆（所有金流都經過這裡） ──
create function public.ledger_post(
  p_member uuid, p_account text, p_type text, p_amount numeric,
  p_note text, p_date date, p_key text, p_trip uuid default null, p_reverses bigint default null
) returns public.member_ledger
language plpgsql set search_path = '' as $$
declare
  v_acc public.member_accounts;
  v_row public.member_ledger;
begin
  if p_key is null or length(p_key) < 8 then
    raise exception '缺少交易識別碼（idempotency key）';
  end if;
  if p_amount is null or p_amount = 0 or p_amount <> trunc(p_amount) then
    raise exception '金額必須是非 0 的整數';
  end if;

  -- 確保快照列存在，然後鎖住（同一會員同一帳戶的交易會排隊執行）
  insert into public.member_accounts (member_id, account) values (p_member, p_account)
    on conflict do nothing;
  select * into v_acc from public.member_accounts
    where member_id = p_member and account = p_account
    for update;
  if not found then
    raise exception '找不到會員';
  end if;

  -- 冪等：拿到鎖之後再檢查，避免兩個相同請求同時通過
  select * into v_row from public.member_ledger where idempotency_key = p_key;
  if found then
    if v_row.member_id <> p_member or v_row.account <> p_account or v_row.amount <> p_amount then
      raise exception '交易識別碼重複但內容不同';
    end if;
    return v_row;
  end if;

  if v_acc.balance + p_amount < 0 then
    raise exception '%餘額不足：目前 % 元，需要 % 元',
      case p_account when 'stored' then '儲值金' else '回饋金' end, v_acc.balance, -p_amount;
  end if;

  insert into public.member_ledger
    (member_id, account, seq, txn_type, amount, balance_before, balance_after,
     note, txn_date, trip_ref, reverses_id, idempotency_key)
  values
    (p_member, p_account, v_acc.version + 1, p_type, p_amount, v_acc.balance, v_acc.balance + p_amount,
     nullif(trim(p_note), ''), coalesce(p_date, current_date), p_trip, p_reverses, p_key)
  returning * into v_row;

  update public.member_accounts
    set balance = v_row.balance_after, version = v_row.seq, updated_at = now()
    where member_id = p_member and account = p_account;

  return v_row;
end $$;

-- 金額字串 → numeric（只接受正整數字串，避免任何浮點轉換）
create function public.parse_amount(p text) returns numeric
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p !~ '^[0-9]{1,10}$' or p::numeric = 0 then
    raise exception '金額必須是正整數';
  end if;
  return p::numeric(12,0);
end $$;

-- ── 後台：儲值 / 扣款 / 發放回饋金 / 扣除回饋金 ──
create function public.member_txn(
  p_member uuid, p_type text, p_amount text, p_note text, p_date date, p_key text
) returns public.member_ledger
language plpgsql set search_path = '' as $$
declare
  v_amt numeric := public.parse_amount(p_amount);
begin
  if p_type = 'topup' then
    return public.ledger_post(p_member, 'stored', 'topup', v_amt, p_note, p_date, p_key);
  elsif p_type = 'spend' then
    return public.ledger_post(p_member, 'stored', 'spend', -v_amt, p_note, p_date, p_key);
  elsif p_type = 'grant' then
    return public.ledger_post(p_member, 'rebate', 'grant', v_amt, p_note, p_date, p_key);
  elsif p_type = 'deduct' then
    return public.ledger_post(p_member, 'rebate', 'deduct', -v_amt, p_note, p_date, p_key);
  end if;
  raise exception '不支援的交易類型：%', p_type;
end $$;

-- ── 後台：沖正一筆（反向入帳，原紀錄保留） ──
create function public.member_reverse(p_entry bigint, p_note text) returns public.member_ledger
language plpgsql set search_path = '' as $$
declare
  v_orig public.member_ledger;
begin
  select * into v_orig from public.member_ledger where id = p_entry;
  if not found then raise exception '找不到這筆紀錄'; end if;
  if v_orig.txn_type = 'reversal' then raise exception '沖正紀錄不能再沖正'; end if;
  -- key 由原紀錄決定 → 同一筆重複按「沖正」只會入帳一次
  return public.ledger_post(
    v_orig.member_id, v_orig.account, 'reversal', -v_orig.amount,
    coalesce(nullif(trim(p_note), ''), '沖正 #' || v_orig.id || (case when v_orig.note is not null then '：' || v_orig.note else '' end)),
    current_date, 'reverse:' || v_orig.id, v_orig.trip_ref, v_orig.id);
end $$;

-- ── 後台：新增購買行程（建立行程 + 扣款在同一個交易，任何一步失敗全部 Rollback） ──
create function public.member_purchase_trip(
  p_member uuid, p_trip_id text, p_trip_name text, p_trip_date date, p_trip_date_end date,
  p_price text, p_note text, p_pay_stored text, p_pay_rebate text, p_key text
) returns public.member_trips
language plpgsql set search_path = '' as $$
declare
  v_trip public.member_trips;
  v_price numeric := case when coalesce(p_price, '') = '' then null else public.parse_amount(p_price) end;
  v_stored numeric := case when coalesce(p_pay_stored, '') in ('', '0') then 0 else public.parse_amount(p_pay_stored) end;
  v_rebate numeric := case when coalesce(p_pay_rebate, '') in ('', '0') then 0 else public.parse_amount(p_pay_rebate) end;
begin
  if p_key is null or length(p_key) < 8 then raise exception '缺少交易識別碼（idempotency key）'; end if;
  if coalesce(trim(p_trip_name), '') = '' then raise exception '請填行程名稱'; end if;
  if v_price is not null and v_stored + v_rebate > v_price then
    raise exception '支付金額（儲值金 % + 回饋金 %）超過行程金額 %', v_stored, v_rebate, v_price;
  end if;

  -- 冪等：同一個 key 已建立過就直接回傳
  select * into v_trip from public.member_trips where idempotency_key = p_key;
  if found then return v_trip; end if;

  insert into public.member_trips
    (member_id, trip_id, trip_name, trip_date, trip_date_end, price, note, idempotency_key)
  values
    (p_member, nullif(p_trip_id, ''), trim(p_trip_name), p_trip_date, p_trip_date_end, v_price,
     nullif(trim(p_note), ''), p_key)
  returning * into v_trip;

  -- 固定先儲值金後回饋金，鎖的順序一致，避免死結
  if v_stored > 0 then
    perform public.ledger_post(p_member, 'stored', 'spend', -v_stored,
      '購買行程：' || v_trip.trip_name, current_date, p_key || ':stored', v_trip.id);
  end if;
  if v_rebate > 0 then
    perform public.ledger_post(p_member, 'rebate', 'deduct', -v_rebate,
      '折抵行程：' || v_trip.trip_name, current_date, p_key || ':rebate', v_trip.id);
  end if;
  return v_trip;
end $$;

-- ── 後台：取消行程（自動沖正這個行程的所有扣款 = 退回） ──
create function public.member_cancel_trip(p_trip uuid) returns public.member_trips
language plpgsql set search_path = '' as $$
declare
  v_trip public.member_trips;
  v_e public.member_ledger;
begin
  select * into v_trip from public.member_trips where id = p_trip for update;
  if not found then raise exception '找不到這個行程'; end if;
  if v_trip.status = 'cancelled' then return v_trip; end if;

  for v_e in
    select l.* from public.member_ledger l
    where l.trip_ref = p_trip and l.txn_type <> 'reversal'
      and not exists (select 1 from public.member_ledger r where r.reverses_id = l.id)
    order by case l.account when 'stored' then 0 else 1 end, l.id
  loop
    perform public.member_reverse(v_e.id, '取消行程退回：' || v_trip.trip_name);
  end loop;

  update public.member_trips set status = 'cancelled', cancelled_at = now()
    where id = p_trip returning * into v_trip;
  return v_trip;
end $$;

-- ── 對帳：列出快照與流水帳不一致的帳戶（正常應為空） ──
create function public.member_ledger_audit()
returns table (member_id uuid, account text, snapshot numeric, ledger_sum numeric, last_after numeric, broken_chain boolean)
language sql stable set search_path = '' as $$
  with s as (
    select a.member_id, a.account, a.balance,
      coalesce((select sum(l.amount) from public.member_ledger l
                where l.member_id = a.member_id and l.account = a.account), 0) as ledger_sum,
      coalesce((select l.balance_after from public.member_ledger l
                where l.member_id = a.member_id and l.account = a.account order by l.seq desc limit 1), 0) as last_after,
      exists (
        select 1 from public.member_ledger l
        join public.member_ledger p on p.member_id = l.member_id and p.account = l.account and p.seq = l.seq - 1
        where l.member_id = a.member_id and l.account = a.account and p.balance_after <> l.balance_before
      ) as broken
    from public.member_accounts a
  )
  select member_id, account, balance, ledger_sum, last_after, broken from s
  where balance <> ledger_sum or balance <> last_after or broken;
$$;

-- ── 權限：只有 service_role（member-api）可以呼叫 ──
revoke all on function
  public.member_ledger_immutable(), public.member_accounts_verify(),
  public.ledger_post(uuid, text, text, numeric, text, date, text, uuid, bigint),
  public.parse_amount(text),
  public.member_txn(uuid, text, text, text, date, text),
  public.member_reverse(bigint, text),
  public.member_purchase_trip(uuid, text, text, date, date, text, text, text, text, text),
  public.member_cancel_trip(uuid),
  public.member_ledger_audit()
  from public, anon, authenticated;
grant execute on function
  public.ledger_post(uuid, text, text, numeric, text, date, text, uuid, bigint),
  public.parse_amount(text),
  public.member_txn(uuid, text, text, text, date, text),
  public.member_reverse(bigint, text),
  public.member_purchase_trip(uuid, text, text, date, date, text, text, text, text, text),
  public.member_cancel_trip(uuid),
  public.member_ledger_audit()
  to service_role;
