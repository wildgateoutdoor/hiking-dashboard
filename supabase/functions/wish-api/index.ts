// 許願池 API（Supabase Edge Function）
//
// 山的開團日期直接取自團務系統（trips）：名稱包含山名或別名、狀態「報名中」、未過報名截止日的活動
//
// 前台（wish.html，不用登入）：
//   { action:'list' }    → 可許願的山、開團日期、許願統計（只有數字，沒有個資）
//   { action:'wish' }    → 許願某座山（或自己填的山名）某個月份；同一座山同一個月達到門檻時寄信到內部信箱（只寄一次）
//   { action:'signup' }  → 報名已開的日期，寄信到內部信箱
//   { action:'mine' | 'mine:update' | 'mine:delete', id_token } → 用 Google 登入，查看 / 修改 / 刪除自己的許願（依登入的 Email）
// 後台（index.html 的「許願池」分頁）：{ action:'admin:*' } + header x-admin-pw
//
// 需要的 secrets（Supabase → Edge Functions → Secrets）：
//   RESEND_API_KEY   Resend 的 API key（沒設定的話功能照常，只是不寄信）
//   NOTIFY_EMAIL     內部信箱，可用逗號分隔多個
//   MAIL_FROM        寄件者，預設「入野門許願池 <onboarding@resend.dev>」
//   WISH_THRESHOLD   門檻人數，預設 3
//   WISH_ADMIN_PW_HASH  後台密碼的 SHA-256，預設與團務系統相同
//   GOOGLE_CLIENT_ID    Google 登入用的 OAuth 用戶端 ID（「我的許願」需要；沒設定的話前台會顯示尚未開放）
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

// 「我的許願」Google 登入用的 OAuth 用戶端 ID（公開資訊，可用 GOOGLE_CLIENT_ID secret 覆蓋）
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") || "22776721346-0ctm7jsjkmi0cjokhnm0r3t0cpoa0e2r.apps.googleusercontent.com";
const THRESHOLD = Math.max(1, parseInt(Deno.env.get("WISH_THRESHOLD") || "3") || 3);
const TZ_OFFSET_H = 8; // 台灣時間

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function must<T>(res: { data: T | null; error: { message: string; code?: string } | null }): NonNullable<T> {
  if (res.error) throw new HttpError(500, res.error.message);
  return res.data as NonNullable<T>;
}

// ── 輸入檢查 ──
const str = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
const strOrNull = (v: unknown, max = 500) => { const s = str(v, max); return s || null; };
function reqStr(v: unknown, field: string, max = 100) {
  const s = str(v, max);
  if (!s) throw new HttpError(400, `請填寫${field}`);
  return s;
}
function email(v: unknown) {
  const s = str(v, 200).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) throw new HttpError(400, "Email 格式不正確");
  return s;
}
function phone(v: unknown, required: boolean) {
  const s = str(v, 30);
  if (!s) { if (required) throw new HttpError(400, "請填寫手機"); return null; }
  if (!/^[0-9+\-\s()#]{8,30}$/.test(s)) throw new HttpError(400, "手機格式不正確");
  return s;
}
function dateStr(v: unknown, field = "日期") {
  const s = str(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) throw new HttpError(400, `${field}格式不正確`);
  return s;
}
// 報名表單連結：只接受 Google 表單（docs.google.com/forms、forms.gle）
function formUrl(v: unknown) {
  const s = str(v, 500);
  if (!s) return null;
  let u: URL;
  try { u = new URL(s); } catch { throw new HttpError(400, "報名表單連結格式不正確"); }
  const ok = u.protocol === "https:" &&
    ((u.hostname === "docs.google.com" && u.pathname.startsWith("/forms/")) || u.hostname === "forms.gle");
  if (!ok) throw new HttpError(400, "報名表單連結請貼 Google 表單的網址（docs.google.com/forms 或 forms.gle）");
  return u.toString();
}
// 景點照片：https 網址，或網站內的圖片路徑（images/…）
function photoUrl(v: unknown) {
  const s = str(v, 500);
  if (!s) return null;
  if (/^images\/[A-Za-z0-9._\/-]+$/.test(s)) return s;
  let u: URL;
  try { u = new URL(s); } catch { throw new HttpError(400, "景點照片網址格式不正確"); }
  if (u.protocol !== "https:") throw new HttpError(400, "景點照片請用 https 開頭的網址");
  return u.toString();
}
// 景點小檔案：困難度、海拔、來回距離、總時間（都是顯示用的文字）
function facts(v: unknown) {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const f = { difficulty: str(o.difficulty, 30), altitude: str(o.altitude, 30), distance: str(o.distance, 30), duration: str(o.duration, 30) };
  return Object.values(f).some(Boolean) ? f : null;
}
const uuid = (v: unknown) => {
  const s = str(v, 40);
  if (!/^[0-9a-f-]{36}$/i.test(s)) throw new HttpError(400, "資料不正確，請重新整理");
  return s;
};
function todayTW() {
  const d = new Date(Date.now() + TZ_OFFSET_H * 3600e3);
  return d.toISOString().slice(0, 10);
}
const monthStart = (s: string) => s.slice(0, 7) + "-01";
const MAX_RANGE_DAYS = 31;
// 某段日期的每一天（YYYY-MM-DD），最多 MAX_RANGE_DAYS 天
function eachDay(start: unknown, end: unknown) {
  const s = String(start || ""), e = String(end || start || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e) || e < s) return [];
  const out: string[] = [];
  for (let d = new Date(s + "T00:00:00Z"); out.length < MAX_RANGE_DAYS; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = d.toISOString().slice(0, 10);
    if (k > e) break;
    out.push(k);
  }
  return out;
}
const monthEnd = (ym01: string) => { const [y, m] = ym01.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
function addMonths(ym01: string, n: number) {
  const [y, m] = ym01.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
}
const fmtMonth = (s: string) => `${s.slice(0, 4)} 年 ${Number(s.slice(5, 7))} 月`;
const fmtDate = (s: string | null) => s ? s.replaceAll("-", "/") : "";
// 許願者填的想出發日期：多段區間，或舊資料的單一日期
function fmtRanges(p: { preferred_ranges?: { start: string; end: string }[] | null; preferred_date?: string | null }) {
  const rs = p.preferred_ranges?.length ? p.preferred_ranges : p.preferred_date ? [{ start: p.preferred_date, end: p.preferred_date }] : [];
  if (!rs.length) return "";
  return "想出發：" + rs.map((r) => r.end && r.end !== r.start ? `${fmtDate(r.start)}~${fmtDate(r.end).slice(5)}` : fmtDate(r.start)).join("、");
}
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// ── 寄信（Resend）──
function mailConfigured() {
  return !!(Deno.env.get("RESEND_API_KEY") && Deno.env.get("NOTIFY_EMAIL"));
}
async function sendMail(subject: string, rows: [string, unknown][], intro: string, replyTo?: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  const to = (Deno.env.get("NOTIFY_EMAIL") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!key || !to.length) { console.warn("mail not configured, skip:", subject); return false; }
  const html = `<div style="font-family:-apple-system,'PingFang TC','Microsoft JhengHei',sans-serif;color:#253D33;max-width:560px">
    <div style="background:#2e3c26;color:#F3EFE6;padding:14px 18px;border-radius:8px 8px 0 0;font-weight:700">入野門許願池</div>
    <div style="border:1px solid #E2DED5;border-top:none;padding:18px;border-radius:0 0 8px 8px">
      <p style="margin:0 0 14px;font-size:15px">${esc(intro)}</p>
      <table style="border-collapse:collapse;font-size:14px;width:100%">
        ${rows.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#8A9990;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 0">${esc(v).replace(/\n/g, "<br>")}</td></tr>`).join("")}
      </table>
    </div></div>`;
  const text = intro + "\n\n" + rows.map(([k, v]) => `${k}：${v ?? ""}`).join("\n");
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: Deno.env.get("MAIL_FROM") || "入野門許願池 <onboarding@resend.dev>",
        to, subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!res.ok) { console.error("resend", res.status, await res.text()); return false; }
    return true;
  } catch (e) { console.error("resend", e); return false; }
}

// ── 團務系統連動 ──
type Trip = { id: string; name: string; date: string; dateEnd?: string; deadline?: string; status?: string; capacity?: number; registered?: number };
const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
function tripMatches(m: { name: string; aliases?: string[] | null }, t: Trip) {
  const n = norm(t.name || "");
  return [m.name, ...(m.aliases || [])].map((k) => norm(k || "")).some((k) => k && n.includes(k));
}
// 消費者可以報名的活動：報名中、還沒出發、還沒過報名截止
const tripOpen = (t: Trip, today: string) =>
  t.status === "reg" && !!t.date && t.date >= today && (!t.deadline || t.deadline >= today);
async function loadTrips(): Promise<Trip[]> {
  const rows = must(await db.from("trips").select("id,data"));
  return rows.map((r: any) => ({ ...r.data, id: r.id }));
}
const tripDate = (t: Trip) => {
  const left = (t.capacity || 0) - (t.registered || 0);
  return {
    id: t.id, start_date: t.date, end_date: t.dateEnd || null, title: t.name,
    seats: t.capacity ? Math.max(0, left) : null, full: !!t.capacity && left <= 0,
  };
};

// 同一座山、同一天出發又同一天回來的梯次只留一筆（團務列表有重複時）：留報名人數最多的那筆
function dedupeTrips(list: Trip[]) {
  const best = new Map<string, Trip>();
  for (const t of list) {
    const k = `${t.date}|${t.dateEnd || t.date}`;
    const cur = best.get(k);
    if (!cur || (t.registered || 0) > (cur.registered || 0)) best.set(k, t);
  }
  return [...best.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ── 前台 ──
async function list() {
  const today = todayTW();
  const thisMonth = monthStart(today);
  const mountains = must(await db.from("wish_mountains").select("id,name,aliases,region,elevation,sort,intro,tags,form_url,photo_url,facts")
    .eq("active", true).order("sort").order("created_at"));
  const ids = mountains.map((m: any) => m.id);
  const open = (await loadTrips()).filter((t) => tripOpen(t, today)).sort((a, b) => a.date.localeCompare(b.date));
  const wishes = must(await db.from("wishes").select("id,mountain_id,custom_name,wish_month,preferred_ranges,party_size,submission_id").gte("wish_month", thisMonth));
  // 只回傳統計數字；自填的山依名稱（不分大小寫、空白）合併
  const counts: Record<string, Record<string, number>> = {};
  const customName: Record<string, string> = {};
  for (const w of wishes as any[]) {
    let key = w.mountain_id;
    if (!key) { key = "c:" + norm(w.custom_name); customName[key] ||= w.custom_name; }
    else if (!ids.includes(key)) continue;
    const m = (counts[key] ||= {});
    const k = w.wish_month.slice(0, 7);
    m[k] = (m[k] || 0) + (w.party_size || 1);  // 以人數計算：一筆許願「預計 4 人出發」算 4 人
  }
  const sum = (o: Record<string, number> = {}) => Object.values(o).reduce((a, b) => a + b, 0);
  // 月曆：每一天有幾個人想去哪裡（只有地點、日期、人數，沒有個資）。
  // 同一次送出的許願（跨月時拆成好幾筆）先合併，把被月份切開的日期接回完整的區間
  const nameOf: Record<string, string> = Object.fromEntries(mountains.map((m: any) => [m.id, m.name]));
  const subs = new Map<string, { place: string; n: number; ranges: { start: string; end: string }[] }>();
  for (const w of wishes as any[]) {
    const place = w.mountain_id ? nameOf[w.mountain_id] : w.custom_name;
    if (!place || !Array.isArray(w.preferred_ranges)) continue;
    const key = w.submission_id || w.id;
    const s0 = subs.get(key) || { place, n: w.party_size || 1, ranges: [] as { start: string; end: string }[] };
    for (const r of w.preferred_ranges) if (r?.start) s0.ranges.push({ start: r.start, end: r.end || r.start });
    subs.set(key, s0);
  }
  const wishDays: { start: string; end: string; place: string; people: number }[] = [];
  for (const s0 of subs.values()) {
    for (const r of mergeRanges(s0.ranges)) if (r.end >= today) wishDays.push({ start: r.start, end: r.end, place: s0.place, people: s0.n });
  }
  wishDays.sort((a, b) => a.start.localeCompare(b.start) || a.place.localeCompare(b.place));
  // 舊版前台用的每日統計（人數加總）
  const cal: Record<string, Record<string, number>> = {};
  for (const w of wishDays) for (const day of eachDay(w.start, w.end)) {
    if (day < today) continue;
    const c = (cal[day] ||= {});
    c[w.place] = (c[w.place] || 0) + w.people;
  }
  const calendar = Object.fromEntries(Object.entries(cal).sort().map(([d, o]) =>
    [d, Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))]));
  return {
    threshold: THRESHOLD,
    today,
    google_client_id: GOOGLE_CLIENT_ID,
    calendar,
    wishDays,
    mountains: mountains.map(({ aliases, ...m }: any) => ({
      ...m,
      dates: dedupeTrips(open.filter((t) => tripMatches({ name: m.name, aliases }, t))).map(tripDate),
      months: counts[m.id] || {},
      total: sum(counts[m.id]),
    })),
    custom: Object.keys(customName).map((k) => ({ name: customName[k], months: counts[k], total: sum(counts[k]) }))
      .sort((a, b) => b.total - a.total),
  };
}

// 把被月份切開的日期接回完整的區間（相鄰或重疊的合併）
type Range = { start: string; end: string };
const nextDay = (d: string) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
function mergeRanges(list: Range[]) {
  const rs = [...list].sort((a, b) => a.start.localeCompare(b.start));
  const merged: Range[] = [];
  for (const r of rs) {
    const last = merged[merged.length - 1];
    if (last && r.start <= nextDay(last.end)) { if (r.end > last.end) last.end = r.end; }
    else merged.push({ ...r });
  }
  return merged;
}

async function activeMountain(id: string) {
  const { data } = await db.from("wish_mountains").select("id,name,active").eq("id", id).maybeSingle();
  if (!data || !data.active) throw new HttpError(400, "這座山目前沒有開放許願，請重新整理");
  return data;
}

// 預計幾人出發（1～30，沒填算 1 人）
function partySize(v: unknown) {
  if (v == null || v === "") return 1;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 30) throw new HttpError(400, "出發人數請填 1～30");
  return n;
}

// 想出發的日期區間（選填，最多 5 段）：[{ start, end }]
function ranges(v: unknown) {
  const arr = Array.isArray(v) ? v.slice(0, 5) : [];
  const today = todayTW();
  return arr.map((r: any) => {
    const start = dateStr(r?.start, "想出發的第一天");
    const end = r?.end ? dateStr(r.end, "想出發的最後一天") : start;
    if (start < today) throw new HttpError(400, "想出發的日期不能早於今天");
    if (end < start) throw new HttpError(400, "最後一天不能早於第一天");
    if ((Date.parse(end) - Date.parse(start)) / 864e5 + 1 > MAX_RANGE_DAYS) throw new HttpError(400, `每一段日期最多 ${MAX_RANGE_DAYS} 天`);
    return { start, end };
  });
}

// 一次可以許願多個月份：每個月份各存一筆，各自計算人數與門檻通知
async function wish(b: Record<string, any>) {
  if (b.website) return { ok: true, results: [] }; // 機器人陷阱欄位
  const custom = str(b.custom_name, 30);
  const m = b.mountain_id ? await activeMountain(uuid(b.mountain_id)) : null;
  if (!m && !custom) throw new HttpError(400, "請選擇想去的山，或直接填寫山名");
  const target = m ? m.name : custom;
  const rs = ranges(b.ranges);
  const rawMonths = Array.isArray(b.months) ? b.months : (b.month ? [b.month] : []);
  // 前台改成選日期：沒有指定月份時，由想出發的日期推出月份
  const byDates = !rawMonths.length && rs.length > 0;
  const fromDates = [...new Set(rs.flatMap((r) => eachDay(r.start, r.end).map((d) => d.slice(0, 7))))];
  const months = [...new Set((byDates ? fromDates : rawMonths).map((x: unknown) => str(x, 7)))].slice(0, 12) as string[];
  if (!months.length) throw new HttpError(400, "請選擇想出發的日期");
  const thisMonth = monthStart(todayTW());
  for (const mo of months) {
    if (!/^\d{4}-\d{2}$/.test(mo)) throw new HttpError(400, "月份格式不正確");
    const wm = mo + "-01";
    if (wm < thisMonth || wm > addMonths(thisMonth, 24)) throw new HttpError(400, "只能許願未來兩年內的月份");
  }
  const base = {
    mountain_id: m?.id ?? null, custom_name: m ? null : custom,
    name: reqStr(b.name, "姓名", 50), email: email(b.email), phone: phone(b.phone, false), note: strOrNull(b.note),
    party_size: partySize(b.party_size), submission_id: crypto.randomUUID(),
  };
  const results = await saveWishRows(base, m?.id ?? null, custom, target, rs, months, byDates);
  if (results.every((r) => r.dup)) throw new HttpError(409, `你已經許過這${months.length > 1 ? "些" : "個"}月份的${target}了，我們收到囉！`);
  return { ok: true, results, threshold: THRESHOLD };
}

// 每個月份各存一筆（用日期許願時，每筆只存落在那個月的日期，月曆才不會重複計算），並檢查門檻通知
async function saveWishRows(base: Record<string, unknown>, mountainId: string | null, custom: string, target: string,
  rs: Range[], months: string[], byDates: boolean) {
  const results: { month: string; count: number; dup: boolean }[] = [];
  for (const mo of [...months].sort()) {
    const wishMonth = mo + "-01";
    const mr = byDates
      ? rs.filter((r) => r.start <= monthEnd(wishMonth) && r.end >= wishMonth)
        .map((r) => ({ start: r.start < wishMonth ? wishMonth : r.start, end: r.end > monthEnd(wishMonth) ? monthEnd(wishMonth) : r.end }))
      : rs;
    const { error } = await db.from("wishes").insert({
      ...base, wish_month: wishMonth, preferred_ranges: mr.length ? mr : null, preferred_date: mr[0]?.start ?? null,
    });
    if (error && error.code !== "23505") throw new HttpError(500, error.message);
    const people = await wishPeople(mountainId, custom, wishMonth);
    const headcount = people.reduce((a: number, p: any) => a + (p.party_size || 1), 0);
    results.push({ month: mo, count: headcount, dup: !!error });
    if (!error && headcount >= THRESHOLD) await maybeAlert(mountainId, mountainId ? null : custom, target, wishMonth, people);
  }
  return results;
}
const monthsOf = (rs: Range[]) => [...new Set(rs.flatMap((r) => eachDay(r.start, r.end).map((d) => d.slice(0, 7))))];

// 同一座山（或同名的自填山）同一個月的許願者
async function wishPeople(mountainId: string | null, custom: string, wishMonth: string) {
  let q = db.from("wishes").select("name,email,phone,note,preferred_date,preferred_ranges,party_size,custom_name,created_at").eq("wish_month", wishMonth).order("created_at");
  q = mountainId ? q.eq("mountain_id", mountainId) : q.is("mountain_id", null);
  const rows: any[] = must(await q);
  return mountainId ? rows : rows.filter((r) => norm(r.custom_name || "") === norm(custom));
}

// 門檻通知：先搶到 wish_alerts 這一列的才寄；寄失敗就把列刪掉，下一位許願時再試
// 自填的山以正規化後的名稱（去空白、小寫）記錄，寫法不同的同名山只寄一次
async function maybeAlert(mountainId: string | null, custom: string | null, name: string, wishMonth: string, people: any[]) {
  const n = people.reduce((a: number, p: any) => a + (p.party_size || 1), 0);
  const { data, error } = await db.from("wish_alerts")
    .insert({ mountain_id: mountainId, custom_name: custom ? norm(custom) : null, wish_month: wishMonth, wish_count: n }).select("wish_month").maybeSingle();
  if (error || !data) return; // 已經寄過（23505）或其他錯誤
  const ok = await sendMail(
    `【許願池】${name}｜${fmtMonth(wishMonth)} 已有 ${n} 人許願`,
    [
      ["山", name + (custom ? "（消費者自填）" : "")], ["月份", fmtMonth(wishMonth)], ["許願人數", `${n} 人（門檻 ${THRESHOLD} 人）`],
      ...people.map((p: any, i: number) => [`#${i + 1}`, [p.name, `${p.party_size || 1} 人`, p.email, p.phone, fmtRanges(p), p.note].filter(Boolean).join("｜")] as [string, unknown]),
    ],
    `${name} 在 ${fmtMonth(wishMonth)} 的許願人數已達門檻，可以考慮開團了！`,
  );
  if (!ok) await deleteAlert(mountainId, custom, wishMonth);
}
async function deleteAlert(mountainId: string | null, custom: string | null, wishMonth: string) {
  if (mountainId) { must(await db.from("wish_alerts").delete().eq("mountain_id", mountainId).eq("wish_month", wishMonth)); return; }
  const rows: any[] = must(await db.from("wish_alerts").select("custom_name").is("mountain_id", null).eq("wish_month", wishMonth));
  const hit = rows.filter((r) => norm(r.custom_name || "") === norm(custom || "")).map((r) => r.custom_name);
  if (hit.length) must(await db.from("wish_alerts").delete().is("mountain_id", null).eq("wish_month", wishMonth).in("custom_name", hit));
}

async function signup(b: Record<string, any>) {
  if (b.website) return { ok: true };
  const tripId = str(b.trip_id, 64);
  const { data: tr } = await db.from("trips").select("id,data").eq("id", tripId).maybeSingle();
  const t: Trip | null = tr ? { ...(tr as any).data, id: (tr as any).id } : null;
  if (!t || !tripOpen(t, todayTW())) throw new HttpError(400, "這個日期已經不開放報名，請重新整理");
  const mts = must(await db.from("wish_mountains").select("id,name,aliases").eq("active", true));
  const mt = mts.find((m: any) => tripMatches(m, t));
  const d = tripDate(t);
  const party = parseInt(String(b.party_size ?? "1"));
  if (!(party >= 1 && party <= 20)) throw new HttpError(400, "人數請填 1～20");
  const row = {
    trip_id: t.id, mountain_id: mt?.id ?? null, mountain_name: t.name, start_date: d.start_date, end_date: d.end_date,
    name: reqStr(b.name, "姓名", 50), email: email(b.email), phone: phone(b.phone, true)!,
    party_size: party, note: strOrNull(b.note),
  };
  const ins: any = must(await db.from("wish_signups").insert(row).select("id").single());
  const range = row.end_date && row.end_date !== row.start_date ? `${fmtDate(row.start_date)} ~ ${fmtDate(row.end_date)}` : fmtDate(row.start_date);
  const ok = await sendMail(
    `【報名${d.full ? "・候補" : ""}】${row.mountain_name} ${range}｜${row.name} ${party} 人`,
    [["行程", row.mountain_name], ["日期", range], ["名額", d.full ? "已額滿（候補）" : d.seats != null ? `報名前剩 ${d.seats} 位` : "—"],
     ["姓名", row.name], ["人數", `${party} 人`],
     ["手機", row.phone], ["Email", row.email], ["備註", row.note || "—"]],
    "有一筆新的報名：",
    row.email,
  );
  if (ok) await db.from("wish_signups").update({ mailed_at: new Date().toISOString() }).eq("id", ins.id);
  return { ok: true };
}

// ── 我的許願（Google 登入）──
// 前台用 Google 登入拿到 ID token，這裡向 Google 確認是真的、是發給我們網站的，再用裡面的 Email 找許願
async function googleEmail(token: unknown) {
  const cid = GOOGLE_CLIENT_ID;
  if (!cid) throw new HttpError(503, "登入功能尚未開放");
  const t = str(token, 4000);
  if (!t) throw new HttpError(401, "請先登入");
  let info: any = null;
  try {
    const res = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(t));
    if (res.ok) info = await res.json();
  } catch (e) { console.error("tokeninfo", e); }
  const ok = info && info.aud === cid && ["accounts.google.com", "https://accounts.google.com"].includes(info.iss) &&
    String(info.email_verified) === "true" && Number(info.exp) * 1000 > Date.now() && info.email;
  if (!ok) throw new HttpError(401, "登入已過期，請重新登入");
  return String(info.email).toLowerCase();
}

// 這個 Email 還沒過期的許願（同一次送出、被月份拆開的幾筆合成一筆）
async function mine(b: Record<string, any>) {
  const me = await googleEmail(b.id_token);
  const today = todayTW();
  const rows: any[] = must(await db.from("wishes")
    .select("id,mountain_id,custom_name,wish_month,preferred_ranges,preferred_date,party_size,submission_id,name,phone,note,created_at")
    .eq("email", me).gte("wish_month", monthStart(today)).order("created_at", { ascending: false }));
  const ids = [...new Set(rows.map((r) => r.mountain_id).filter(Boolean))];
  const mts: any[] = ids.length ? must(await db.from("wish_mountains").select("id,name").in("id", ids)) : [];
  const nameOf: Record<string, string> = Object.fromEntries(mts.map((m) => [m.id, m.name]));
  const groups = new Map<string, any>();
  for (const r of rows) {
    const key = r.submission_id || r.id;
    const g = groups.get(key) || {
      key, place: r.mountain_id ? nameOf[r.mountain_id] || "（已下架的地方）" : r.custom_name, custom: !r.mountain_id,
      party_size: r.party_size || 1, name: r.name, phone: r.phone, note: r.note, created_at: r.created_at, ranges: [] as Range[], months: [] as string[],
    };
    for (const x of (r.preferred_ranges || [])) if (x?.start) g.ranges.push({ start: x.start, end: x.end || x.start });
    if (!r.preferred_ranges?.length && r.preferred_date) g.ranges.push({ start: r.preferred_date, end: r.preferred_date });
    g.months.push(r.wish_month.slice(0, 7));
    if (r.created_at < g.created_at) g.created_at = r.created_at;
    groups.set(key, g);
  }
  const wishes = [...groups.values()].map((g) => ({ ...g, ranges: mergeRanges(g.ranges), months: [...new Set(g.months)].sort() }));
  return { email: me, wishes };
}

async function myRows(me: string, key: unknown) {
  const k = uuid(key);
  const rows: any[] = must(await db.from("wishes").select("id,mountain_id,custom_name,wish_month,submission_id")
    .eq("email", me).or(`submission_id.eq.${k},id.eq.${k}`));
  if (!rows.length) throw new HttpError(404, "找不到這筆許願，請重新整理");
  return { k, rows };
}

async function mineUpdate(b: Record<string, any>) {
  const me = await googleEmail(b.id_token);
  const { k, rows } = await myRows(me, b.key);
  const mountainId: string | null = rows[0].mountain_id;
  const custom: string = rows[0].custom_name || "";
  const m = mountainId ? await activeMountain(mountainId) : null;
  const target = m ? m.name : custom;
  const rs = ranges(b.ranges);
  if (!rs.length) throw new HttpError(400, "請選擇想出發的日期");
  const months = monthsOf(rs);
  const thisMonth = monthStart(todayTW());
  if (months.some((mo) => mo + "-01" > addMonths(thisMonth, 24))) throw new HttpError(400, "只能許願未來兩年內的月份");
  const base = {
    mountain_id: mountainId, custom_name: mountainId ? null : custom,
    name: reqStr(b.name, "姓名", 50), email: me, phone: phone(b.phone, false), note: strOrNull(b.note),
    party_size: partySize(b.party_size), submission_id: rows[0].submission_id || k,
  };
  // 同一個地方、同一個月份，每個 Email 只能有一筆：先確認不會跟自己另一筆許願撞到
  const own = new Set(rows.map((r) => r.id));
  let q = db.from("wishes").select("id,wish_month,custom_name").eq("email", me).in("wish_month", months.map((x) => x + "-01"));
  q = mountainId ? q.eq("mountain_id", mountainId) : q.is("mountain_id", null);
  const clash = (must(await q) as any[]).filter((r) => !own.has(r.id) && (mountainId || norm(r.custom_name || "") === norm(custom)));
  if (clash.length) {
    const ym = clash.map((r) => fmtMonth(r.wish_month)).join("、");
    throw new HttpError(409, `你在 ${ym} 已經有另一筆${target}的許願，請改那一筆，或換別的日期`);
  }
  must(await db.from("wishes").delete().in("id", rows.map((r) => r.id)));
  await saveWishRows(base, mountainId, custom, target, rs, months, true);
  return { ok: true };
}

async function mineDelete(b: Record<string, any>) {
  const me = await googleEmail(b.id_token);
  const { rows } = await myRows(me, b.key);
  must(await db.from("wishes").delete().in("id", rows.map((r) => r.id)));
  return { ok: true };
}

// ── 後台 ──
const DEFAULT_ADMIN_PW_HASH = "3f7cfd02d51d09c322fc3c27bdce98e87aabb9847683262e67be13710dfb90b7";
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
async function checkAdmin(req: Request) {
  const pw = (req.headers.get("x-admin-pw") || "").trim().normalize("NFKC");
  const want = (Deno.env.get("WISH_ADMIN_PW_HASH") || DEFAULT_ADMIN_PW_HASH).toLowerCase();
  if (!pw || !sameStr(await sha256hex(pw), want)) throw new HttpError(401, "後台密碼錯誤");
}

async function admin(action: string, b: Record<string, any>) {
  switch (action) {
    case "admin:check":
      return { ok: true };

    case "admin:list": {
      const mountains = must(await db.from("wish_mountains").select("*").order("sort").order("created_at"));
      const wishes = must(await db.from("wishes").select("*").order("created_at", { ascending: false }));
      const signups = must(await db.from("wish_signups").select("*").order("created_at", { ascending: false }).limit(500));
      const alerts = must(await db.from("wish_alerts").select("*"));
      return { threshold: THRESHOLD, mail: mailConfigured(), today: todayTW(), mountains, wishes, signups, alerts };
    }

    case "admin:saveMountain": {
      const f = {
        name: reqStr(b.name, "山的名稱", 50), region: strOrNull(b.region, 50),
        aliases: (Array.isArray(b.aliases) ? b.aliases : String(b.aliases ?? "").split(/[、,，\n]/))
          .map((x: unknown) => str(x, 50)).filter(Boolean).slice(0, 20),
        elevation: b.elevation === "" || b.elevation == null ? null : Math.round(Number(b.elevation)) || null,
        sort: Math.round(Number(b.sort)) || 0, active: b.active !== false,
        intro: strOrNull(b.intro, 1000),
        form_url: formUrl(b.form_url),
        photo_url: photoUrl(b.photo_url),
        facts: facts(b.facts),
        tags: (Array.isArray(b.tags) ? b.tags : []).map((x: unknown) => str(x, 20)).filter(Boolean).slice(0, 20),
      };
      if (b.id) must(await db.from("wish_mountains").update(f).eq("id", uuid(b.id)));
      else must(await db.from("wish_mountains").insert(f));
      return { ok: true };
    }
    case "admin:deleteMountain": {
      const id = uuid(b.id);
      const { count } = await db.from("wishes").select("id", { count: "exact", head: true }).eq("mountain_id", id);
      if (count && !b.force) throw new HttpError(400, `這座山已有 ${count} 筆許願，刪除會一起刪掉。建議改成「不開放」就好`);
      must(await db.from("wish_mountains").delete().eq("id", id));
      return { ok: true };
    }

    case "admin:deleteWish":
      must(await db.from("wishes").delete().eq("id", uuid(b.id)));
      return { ok: true };
    case "admin:deleteSignup":
      must(await db.from("wish_signups").delete().eq("id", uuid(b.id)));
      return { ok: true };

    // 重新開放某山某月的門檻通知（例如開團後又想再收一次通知）
    case "admin:resetAlert":
      await deleteAlert(b.mountain_id ? uuid(b.mountain_id) : null, str(b.custom_name, 30) || null, dateStr(b.wish_month));
      return { ok: true };

    case "admin:testMail": {
      if (!mailConfigured()) throw new HttpError(400, "還沒設定 RESEND_API_KEY 或 NOTIFY_EMAIL");
      const ok = await sendMail("【許願池】測試信", [["時間", new Date().toISOString()]], "這是一封測試信，收到代表自動通知設定成功。");
      if (!ok) throw new HttpError(500, "寄送失敗，請到 Supabase 的 Edge Function 紀錄查看原因");
      return { ok: true };
    }
  }
  throw new HttpError(400, "unknown action");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    if (action === "list") return json(await list());
    if (action === "wish") return json(await wish(body));
    if (action === "signup") return json(await signup(body));
    if (action === "mine") return json(await mine(body));
    if (action === "mine:update") return json(await mineUpdate(body));
    if (action === "mine:delete") return json(await mineDelete(body));
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
