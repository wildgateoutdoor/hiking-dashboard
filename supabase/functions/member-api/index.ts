// 會員系統 API（Supabase Edge Function）
//
// 會員端：{ action:'me' } + Authorization: Bearer <Supabase Auth 的 access token>
//         → 會員用 Google 登入後，以 token 裡的 email 找到自己的資料
// 後台端：{ action:'admin:*', ... } + header x-admin-pw → 驗證後台密碼後讀寫所有會員
//
// 金流規則：所有儲值金／回饋金異動都呼叫資料庫函式（member_txn、member_purchase_trip …），
// 由資料庫在單一交易內鎖定、檢查餘額、寫流水帳、更新快照。這裡不做任何金額運算，金額一律以字串傳遞。
//
// 後台密碼：比對 SHA-256，與 index.html 的 EDIT_PW_HASH 相同（該值本來就公開在網頁裡）。
//   改密碼時兩邊要一起改；也可以用 secret ADMIN_PW_HASH 覆蓋。
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 由 Supabase 自動提供。

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-pw",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function must<T>(res: { data: T | null; error: { message: string; code?: string } | null }): NonNullable<T> {
  if (res.error) {
    // P0001 = 資料庫函式主動拒絕（餘額不足、金額錯誤…），訊息可以直接給使用者看
    if (res.error.code === "P0001") throw new HttpError(400, res.error.message);
    if (res.error.code === "23505") throw new HttpError(409, "這筆交易已經處理過了，請重新整理");
    throw new HttpError(500, res.error.message);
  }
  return res.data as NonNullable<T>;
}

// 金額只接受正整數字串，原樣交給資料庫（numeric）處理，不轉成 JS 數字
function amountStr(v: unknown, field = "金額"): string {
  const s = String(v ?? "").trim();
  if (!/^[0-9]{1,10}$/.test(s) || /^0+$/.test(s)) throw new HttpError(400, `${field}必須是正整數`);
  return s;
}
function optAmountStr(v: unknown, field: string): string | null {
  const s = String(v ?? "").trim();
  return s === "" || /^0+$/.test(s) ? null : amountStr(s, field);
}
function idemKey(v: unknown): string {
  const s = String(v ?? "");
  if (!/^[A-Za-z0-9-]{16,64}$/.test(s)) throw new HttpError(400, "缺少交易識別碼，請重新整理頁面");
  return s;
}
const dateOrNull = (v: unknown) => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, "日期格式不正確");
  return s;
};

const ledgerBalances = (accounts: { account: string; balance: number }[]) => ({
  stored: accounts.find((a) => a.account === "stored")?.balance ?? 0,
  rebate: accounts.find((a) => a.account === "rebate")?.balance ?? 0,
});

async function sha256hex(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function sameStr(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const strOrNull = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v).trim());

const normEmail = (v: unknown) => String(v ?? "").trim().toLowerCase();

// ── 會員端 ──
async function memberMe(req: Request) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data.user?.email) throw new HttpError(401, "請重新登入");
  const u = data.user;
  const meta = u.user_metadata || {};
  // 以 email 對應會員：後台先建好的會員，第一次登入就會接上；只更新 Google 資訊，不碰 tier 等後台欄位
  const m = must<any>(await db.from("members").upsert({
    email: normEmail(u.email),
    google_name: meta.full_name || meta.name || null,
    google_picture: meta.avatar_url || meta.picture || null,
    last_login_at: new Date().toISOString(),
  }, { onConflict: "email" }).select("id,email,google_name,google_picture,real_name,tier,expires_at,created_at").single());
  const accounts = must(await db.from("member_accounts").select("account,balance").eq("member_id", m.id));
  const ledger = must(await db.from("member_ledger")
    .select("id,account,txn_type,amount,balance_after,note,txn_date,reverses_id")
    .eq("member_id", m.id).order("id", { ascending: false }));
  const trips = must(await db.from("member_trips").select("id,trip_name,trip_date,trip_date_end,price,note,status")
    .eq("member_id", m.id).order("trip_date", { ascending: false, nullsFirst: false }));
  return { member: m, balances: ledgerBalances(accounts), ledger, trips };
}

// ── 後台 ──
const DEFAULT_ADMIN_PW_HASH = "3f7cfd02d51d09c322fc3c27bdce98e87aabb9847683262e67be13710dfb90b7";
async function checkAdmin(req: Request) {
  const pw = (req.headers.get("x-admin-pw") || "").trim().normalize("NFKC");
  const want = (Deno.env.get("ADMIN_PW_HASH") || DEFAULT_ADMIN_PW_HASH).toLowerCase();
  if (!pw || !want || !sameStr(await sha256hex(pw), want)) throw new HttpError(401, "後台密碼錯誤");
}

const MEMBER_FIELDS = ["real_name", "phone", "tier", "note", "expires_at"] as const;

async function admin(action: string, b: Record<string, any>) {
  switch (action) {
    case "admin:check":
      return { ok: true };

    case "admin:list": {
      const rows = must(await db.from("members")
        .select("id,email,google_name,google_picture,real_name,phone,tier,note,expires_at,created_at,last_login_at,member_accounts(account,balance),member_trips(status)")
        .order("created_at", { ascending: false }));
      return {
        members: rows.map(({ member_accounts, member_trips, ...m }: any) => ({
          ...m,
          balances: ledgerBalances(member_accounts),
          trip_count: member_trips.filter((t: any) => t.status === "active").length,
        })),
      };
    }

    case "admin:get": {
      const member = must(await db.from("members").select("*").eq("id", b.id).single());
      const accounts = must(await db.from("member_accounts").select("account,balance,version").eq("member_id", b.id));
      const ledger = must(await db.from("member_ledger").select("*").eq("member_id", b.id).order("id", { ascending: false }));
      const trips = must(await db.from("member_trips").select("*").eq("member_id", b.id)
        .order("trip_date", { ascending: false, nullsFirst: false }));
      // 對帳：快照必須等於流水帳最後一筆的交易後餘額，且筆數一致
      const verified = (["stored", "rebate"] as const).every((acc) => {
        const a = accounts.find((x: any) => x.account === acc);
        const rows = ledger.filter((l: any) => l.account === acc);
        return a ? rows.length === a.version && (rows[0]?.balance_after ?? 0) === a.balance : rows.length === 0;
      });
      return { member, balances: ledgerBalances(accounts), ledger, trips, verified };
    }

    case "admin:create": {
      const email = normEmail(b.email);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Email 格式不正確");
      const { data, error } = await db.from("members").insert({
        email, real_name: strOrNull(b.real_name), tier: strOrNull(b.tier) || "一般會員",
      }).select("id").single();
      if (error?.code === "23505") throw new HttpError(400, "這個 Email 已經是會員了");
      if (error) throw new HttpError(500, error.message);
      return { id: data.id };
    }

    case "admin:delete": {
      const { count } = await db.from("member_ledger").select("id", { count: "exact", head: true }).eq("member_id", b.id);
      if (count) throw new HttpError(400, "這位會員已有儲值金或回饋金紀錄，為了保留帳務紀錄不能刪除");
      must(await db.from("members").delete().eq("id", b.id));
      return { ok: true };
    }

    case "admin:update": {
      const f: Record<string, unknown> = {};
      for (const k of MEMBER_FIELDS) if (k in (b.fields || {})) f[k] = strOrNull(b.fields[k]);
      if ("expires_at" in f) f.expires_at = dateOrNull(f.expires_at);
      if ("tier" in f && !f.tier) f.tier = "一般會員";
      must(await db.from("members").update(f).eq("id", b.id));
      return { ok: true };
    }

    // 儲值 / 儲值金扣款 / 發放回饋金 / 扣除回饋金
    case "admin:txn": {
      if (!["topup", "spend", "grant", "deduct"].includes(b.type)) throw new HttpError(400, "不支援的交易類型");
      const entry = must(await db.rpc("member_txn", {
        p_member: b.member_id, p_type: b.type, p_amount: amountStr(b.amount),
        p_note: strOrNull(b.note), p_date: dateOrNull(b.txn_date), p_key: idemKey(b.key),
      }));
      return { entry };
    }

    // 沖正（反向入帳）：同一筆只能沖正一次
    case "admin:reverse": {
      const entry = must(await db.rpc("member_reverse", { p_entry: Number(b.id), p_note: strOrNull(b.note) }));
      return { entry };
    }

    // 新增購買行程：建立行程與扣款在同一個資料庫交易
    case "admin:addTrip": {
      const trip = must(await db.rpc("member_purchase_trip", {
        p_member: b.member_id, p_trip_id: strOrNull(b.trip_id), p_trip_name: strOrNull(b.trip_name),
        p_trip_date: dateOrNull(b.trip_date), p_trip_date_end: dateOrNull(b.trip_date_end),
        p_price: optAmountStr(b.price, "行程金額"), p_note: strOrNull(b.note),
        p_pay_stored: optAmountStr(b.pay_stored, "儲值金支付金額"),
        p_pay_rebate: optAmountStr(b.pay_rebate, "回饋金折抵金額"),
        p_key: idemKey(b.key),
      }));
      return { trip };
    }

    // 取消行程：自動沖正這個行程的扣款（退回儲值金／回饋金）
    case "admin:cancelTrip": {
      const trip = must(await db.rpc("member_cancel_trip", { p_trip: b.id }));
      return { trip };
    }

    // 全體對帳：回傳快照與流水帳不一致的帳戶（正常為空）
    case "admin:audit": {
      const mismatches = must(await db.rpc("member_ledger_audit"));
      return { mismatches };
    }
  }
  throw new HttpError(400, "unknown action");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    if (action === "me") return json(await memberMe(req));
    if (action.startsWith("admin:")) {
      await checkAdmin(req);
      return json(await admin(action, body));
    }
    throw new HttpError(400, "unknown action");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});
