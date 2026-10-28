-- 回饋金改稱「點數」（單位：點，1 點折抵 1 元）。帳戶代碼仍為 rebate，只改顯示文字。

create or replace function public.ledger_post(
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
    if p_account = 'stored' then
      raise exception '儲值金餘額不足：目前 % 元，需要 % 元', v_acc.balance, -p_amount;
    else
      raise exception '點數不足：目前 % 點，需要 % 點', v_acc.balance, -p_amount;
    end if;
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

create or replace function public.member_purchase_trip(
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
    raise exception '支付金額（儲值金 % 元 + 點數 % 點）超過行程金額 % 元', v_stored, v_rebate, v_price;
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
      '點數折抵行程：' || v_trip.trip_name, current_date, p_key || ':rebate', v_trip.id);
  end if;
  return v_trip;
end $$;
