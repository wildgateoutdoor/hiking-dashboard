// 會員系統 API（Supabase Edge Function）
//
// 會員端：{ action:'me', idToken }           → 用 LINE ID token 驗證身分，回傳自己的資料
// 後台端：{ action:'admin:*', ... } + header x-admin-pw → 驗證後台密碼後讀寫所有會員
//
// 需要設定的 secrets：
//   LINE_CHANNEL_ID  LINE Login channel 的 Channel ID（LIFF 所在的 channel）
//   ADMIN_PW_HASH    後台密碼的 SHA-256（與 index.html 的 EDIT_PW_HASH 相同）
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

function must<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new HttpError(500, res.error.message);
  return res.data;
}

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

const intOrNull = (v: unknown) => (v === "" || v == null ? null : Math.round(Number(v)));
const strOrNull = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v).trim());

// ── 會員端 ──
async function verifyLine(idToken: string) {
  const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: Deno.env.get("LINE_CHANNEL_ID")! }),
  });
  const p = await r.json();
  if (!r.ok || !p.sub) throw new HttpError(401, p.error_description || "LINE 驗證失敗");
  return p as { sub: string; name?: string; picture?: string };
}

async function memberMe(idToken: string) {
  if (!idToken) throw new HttpError(400, "missing idToken");
  const line = await verifyLine(idToken);
  // 只更新 LINE 資訊，不碰 tier 等後台欄位
  const m = must(await db.from("members").upsert({
    line_user_id: line.sub,
    line_name: line.name ?? null,
    line_picture: line.picture ?? null,
    last_login_at: new Date().toISOString(),
  }, { onConflict: "line_user_id" }).select("id,line_name,line_picture,real_name,tier,created_at").single());
  const wallet = must(await db.from("member_wallet").select("id,amount,note,txn_date")
    .eq("member_id", m.id).order("txn_date", { ascending: false }).order("created_at", { ascending: false }));
  const trips = must(await db.from("member_trips").select("id,trip_name,trip_date,trip_date_end,price,note")
    .eq("member_id", m.id).order("trip_date", { ascending: false, nullsFirst: false }));
  const balance = wallet.reduce((s, w) => s + w.amount, 0);
  return { member: m, balance, wallet, trips };
}

// ── 後台 ──
async function checkAdmin(req: Request) {
  const pw = (req.headers.get("x-admin-pw") || "").trim().normalize("NFKC");
  const want = (Deno.env.get("ADMIN_PW_HASH") || "").toLowerCase();
  if (!pw || !want || !sameStr(await sha256hex(pw), want)) throw new HttpError(401, "後台密碼錯誤");
}

const MEMBER_FIELDS = ["real_name", "phone", "tier", "note"] as const;

async function admin(action: string, b: Record<string, any>) {
  switch (action) {
    case "admin:check":
      return { ok: true };

    case "admin:list": {
      const rows = must(await db.from("members")
        .select("id,line_name,line_picture,real_name,phone,tier,note,created_at,last_login_at,member_wallet(amount),member_trips(id)")
        .order("created_at", { ascending: false }));
      return {
        members: rows.map(({ member_wallet, member_trips, ...m }: any) => ({
          ...m,
          balance: member_wallet.reduce((s: number, w: any) => s + w.amount, 0),
          trip_count: member_trips.length,
        })),
      };
    }

    case "admin:get": {
      const member = must(await db.from("members").select("*").eq("id", b.id).single());
      const wallet = must(await db.from("member_wallet").select("*").eq("member_id", b.id)
        .order("txn_date", { ascending: false }).order("created_at", { ascending: false }));
      const trips = must(await db.from("member_trips").select("*").eq("member_id", b.id)
        .order("trip_date", { ascending: false, nullsFirst: false }));
      return { member, wallet, trips, balance: wallet.reduce((s: number, w: any) => s + w.amount, 0) };
    }

    case "admin:update": {
      const f: Record<string, unknown> = {};
      for (const k of MEMBER_FIELDS) if (k in (b.fields || {})) f[k] = strOrNull(b.fields[k]);
      if ("tier" in f && !f.tier) f.tier = "一般會員";
      must(await db.from("members").update(f).eq("id", b.id));
      return { ok: true };
    }

    case "admin:addWallet": {
      const amount = intOrNull(b.amount);
      if (!amount) throw new HttpError(400, "金額不可為 0");
      must(await db.from("member_wallet").insert({
        member_id: b.member_id, amount, note: strOrNull(b.note), txn_date: b.txn_date || undefined,
      }));
      return { ok: true };
    }

    case "admin:delWallet":
      must(await db.from("member_wallet").delete().eq("id", b.id));
      return { ok: true };

    case "admin:addTrip": {
      const name = strOrNull(b.trip_name);
      if (!name) throw new HttpError(400, "請填行程名稱");
      const price = intOrNull(b.price);
      must(await db.from("member_trips").insert({
        member_id: b.member_id, trip_id: strOrNull(b.trip_id), trip_name: name,
        trip_date: b.trip_date || null, trip_date_end: b.trip_date_end || null, price, note: strOrNull(b.note),
      }));
      // 勾選「從儲值金扣款」→ 同時記一筆負的儲值紀錄
      if (b.deduct && price) {
        must(await db.from("member_wallet").insert({ member_id: b.member_id, amount: -price, note: `購買行程：${name}` }));
      }
      return { ok: true };
    }

    case "admin:delTrip":
      must(await db.from("member_trips").delete().eq("id", b.id));
      return { ok: true };
  }
  throw new HttpError(400, "unknown action");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    if (action === "me") return json(await memberMe(body.idToken));
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
