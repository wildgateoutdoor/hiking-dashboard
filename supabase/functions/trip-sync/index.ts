// 報名表 → 團務自動同步（Supabase Edge Function）
//
// 每條路線的 Google 報名回覆試算表裡放一段 Apps Script（apps-script/trip-sync.gs），
// 定時把「日期分頁」（例：12/12-13）的報名資料 POST 到這裡，這裡再更新後台 trips：
//   - 報名人數 registered
//   - 裝備租借 equipRenters / equipment（依後台「裝備費用」設定比對品項與單價）
//   - 代揹服務 porterBuyers / porter（依後台「代揹費用」設定計價）
//   - 餐食需求 diet（葷素人數、不吃的東西、過敏）
//   - 同步紀錄 sheetSync（時間、來源、無法辨識的內容）
//
// 只送姓名與上面這些欄位，身分證、電話、地址等個資不會傳過來。
// 後台手動新增的租借者／代揹購買者（不在報名表裡的人）會保留。
//
// 驗證：header x-sync-key 必須等於 secret TRIP_SYNC_KEY。
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 由 Supabase 自動提供。

import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

type Row = { name?: string; equip?: string; porter?: string; diet?: string | null; avoid?: string; allergy?: string };
type Tab = { tab: string; rows: Row[] };
type Trip = Record<string, any> & { id: string; name: string; date: string; dateEnd?: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
// 「無」「不挑食」「沒有」之類視為空白
const NONE = /^(無|无|沒有|没有|不挑食|都可以?|都行|皆可|none|no|n\/?a|x|-|—)$/i;
const meaningful = (v: unknown) => { const s = clean(v); return s && !NONE.test(s) ? s : ""; };

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const todayTW = () => ymd(new Date(Date.now() + 8 * 3600000));
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// 分頁名稱裡的出發日：「12/12-13」「戒茂斯10/24-26」「2027/01/22-24」「9/12-13公關團」
function tabDate(tab: string): { year: number | null; md: string } | null {
  const m = clean(tab).match(/(?:(\d{4})\s*[\/.\-]\s*)?(\d{1,2})\s*[\/.]\s*(\d{1,2})/);
  if (!m) return null;
  const mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { year: m[1] ? +m[1] : null, md: `${pad(mo)}-${pad(d)}` };
}

// 同月日（有寫年份就同年）、還沒結束的梯次裡，挑離今天最近的那一梯
function pickTrip(trips: Trip[], when: { year: number | null; md: string }) {
  const today = todayTW();
  const same = trips.filter((t) => typeof t.date === "string" && t.date.slice(5) === when.md &&
    (!when.year || t.date.startsWith(String(when.year))));
  if (!same.length) return { trip: null, ended: false };
  const open = same.filter((t) => (t.dateEnd || t.date) >= today);
  if (!open.length) return { trip: null, ended: true };
  return { trip: open.sort((a, b) => daysBetween(today, a.date) - daysBetween(today, b.date))[0], ended: false };
}

// 「登山杖一對 150元 Trekking Poles, 頭燈 150元 (含電池) Headlamp」→ [{item:'登山杖',qty:1},{item:'頭燈',qty:1}]
function parseEquip(text: string, priceItems: string[]) {
  const rentals: { item: string; qty: number }[] = [];
  const unknown: string[] = [];
  const s = meaningful(text);
  if (!s) return { rentals, unknown };
  // 依長度由長到短比對，避免「睡袋」先吃掉「羽絨睡袋」
  const items = [...priceItems].sort((a, b) => b.length - a.length);
  for (const part of s.split(/[,，、;；\n]+/).map(clean).filter(Boolean)) {
    if (NONE.test(part)) continue;
    // 「睡袋 350元」對「羽絨睡袋」、「蛋殼睡墊」對「睡墊」：名稱互相包含就算
    const word = part.match(/^[^\s\d(（]+/)?.[0] || part;
    const item = items.find((it) => part.includes(it)) || items.find((it) => word.length >= 2 && it.includes(word));
    if (!item) { unknown.push(part); continue; }
    const q = part.match(/(?:[x×*]\s*(\d+)|(\d+)\s*(?:個|組|支|件|份))/i);
    const qty = q ? +(q[1] || q[2]) : 1;
    const hit = rentals.find((r) => r.item === item);
    if (hit) hit.qty += qty; else rentals.push({ item, qty });
  }
  return { rentals, unknown };
}

// 「代背4公斤*2天 2000元」→ {kg:4, days:2}；「3公斤」→ {kg:3}；沒寫公斤數但不是「無」→ 無法辨識
function parsePorter(text: string): { kg: number; days: number | null } | null | "unknown" {
  const s = clean(text).split(/[,，、]/).map(clean).filter((x) => x && !NONE.test(x)).join(" ");
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(公斤|kg|ＫＧ|KG|Kg|k)/i);
  if (!m) return "unknown";
  const d = s.match(/(\d+)\s*天/);
  return { kg: +m[1], days: d ? +d[1] : null };
}

function dietKind(text: string): "veg" | "meat" | "" {
  const s = clean(text);
  if (/素|veg/i.test(s)) return "veg";
  if (/葷|meat/i.test(s)) return "meat";
  return "";
}

function porterPrice(weight: number, pricing: { kg: number; price: number }[]) {
  if (!pricing.length) return 0;
  const sorted = [...pricing].sort((a, b) => a.kg - b.kg);
  return (sorted.find((r) => weight <= r.kg) || sorted[sorted.length - 1]).price;
}

function buildPatch(trip: Trip, rows: Row[], source: string, tab: string,
  equipPricing: { item: string; price: number }[], porterPricing: { kg: number; price: number }[]) {
  const people = rows.map((r) => ({ ...r, name: clean(r.name) })).filter((r) => r.name);
  const names = new Set(people.map((p) => p.name));
  const warnings: string[] = [];
  const tripDays = trip.dateEnd && trip.dateEnd > trip.date ? daysBetween(trip.date, trip.dateEnd) + 1 : 1;
  const priceOf = (item: string) => equipPricing.find((p) => p.item === item)?.price || 0;

  // 裝備租借：報名表的人整批換新；後台手動加、且不在報名表的人保留
  const keepRenters = (trip.equipRenters || []).filter((r: any) => r.src !== "sheet" && !names.has(clean(r.name)));
  const sheetRenters: any[] = [];
  for (const p of people) {
    const { rentals, unknown } = parseEquip(p.equip || "", equipPricing.map((e) => e.item));
    if (rentals.length) sheetRenters.push({ name: p.name, rentals, src: "sheet" });
    for (const u of unknown) warnings.push(`${p.name} 的租借「${u}」對不到後台裝備費用設定`);
  }
  const equipRenters = [...keepRenters, ...sheetRenters];
  const eqMap: Record<string, number> = {};
  equipRenters.forEach((r: any) => (r.rentals || []).forEach((ri: any) => { eqMap[ri.item] = (eqMap[ri.item] || 0) + (ri.qty || 0); }));
  const equipment = Object.entries(eqMap).map(([item, qty]) => ({ item, quantity: qty, totalCost: qty * priceOf(item) }));

  // 代揹（加購服務）
  const keepBuyers = (trip.porterBuyers || []).filter((b: any) => b.src !== "sheet" && !names.has(clean(b.name)));
  const sheetBuyers: any[] = [];
  for (const p of people) {
    const pt = parsePorter(p.porter || "");
    if (pt === "unknown") { warnings.push(`${p.name} 的代揹「${clean(p.porter)}」看不出公斤數`); continue; }
    if (pt) sheetBuyers.push({ name: p.name, weight: pt.kg, days: pt.days || tripDays, src: "sheet" });
  }
  const porterBuyers = [...keepBuyers, ...sheetBuyers].map((b: any) => ({
    ...b, cost: Math.round(b.weight * porterPrice(b.weight, porterPricing) * (b.days || 1)),
  }));
  const porter = {
    weight: porterBuyers.reduce((s, b) => s + (b.weight || 0), 0),
    totalCost: porterBuyers.reduce((s, b) => s + (b.cost || 0), 0),
  };

  // 餐食需求（一日行程的報名表沒有葷素欄：diet 為 null，不統計葷素）
  const hasDiet = people.some((p) => p.diet != null);
  const diet = { meat: 0, veg: 0, other: 0, noDietCol: !hasDiet, notes: [] as { name: string; diet: string; avoid: string; allergy: string }[] };
  for (const p of people) {
    const k = dietKind(p.diet || "");
    if (hasDiet) { if (k) diet[k]++; else diet.other++; }
    const avoid = meaningful(p.avoid), allergy = meaningful(p.allergy);
    // 「鍋邊素 Flexitarian」→「鍋邊素」；葷食不另外標
    const vegLabel = !hasDiet || k === "meat" ? "" : clean(p.diet).replace(/\s*[A-Za-z].*$/, "");
    if (avoid || allergy || vegLabel) diet.notes.push({ name: p.name, diet: vegLabel, avoid, allergy });
  }

  return {
    patch: {
      registered: people.length,
      equipRenters, equipment, porterBuyers, porter, diet,
      sheetSync: { at: new Date().toISOString(), source, tab, count: people.length, warnings },
    },
    warnings,
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const key = Deno.env.get("TRIP_SYNC_KEY");
  if (!key || req.headers.get("x-sync-key") !== key) return json({ error: "unauthorized" }, 401);

  let body: { route?: string; source?: string; tabs?: Tab[]; dryRun?: boolean };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const route = clean(body.route);
  if (!route || !Array.isArray(body.tabs)) return json({ error: "需要 route 與 tabs" }, 400);
  const source = clean(body.source) || route;

  const { data: tripRows, error } = await db.from("trips").select("id,data");
  if (error) return json({ error: error.message }, 500);
  const trips: Trip[] = (tripRows || []).map((r: any) => ({ ...r.data, id: r.id }))
    .filter((t: Trip) => clean(t.name) === route);

  const { data: settingRows } = await db.from("settings").select("key,data").in("key", ["equipPricing", "porterPricing"]);
  const setting = (k: string) => (settingRows || []).find((r: any) => r.key === k)?.data || [];
  const equipPricing = setting("equipPricing"), porterPricing = setting("porterPricing");

  const results: any[] = [];
  for (const t of body.tabs) {
    const when = tabDate(t.tab);
    if (!when) { results.push({ tab: t.tab, skipped: "分頁名稱裡沒有日期" }); continue; }
    const { trip, ended } = pickTrip(trips, when);
    if (ended) { results.push({ tab: t.tab, skipped: "這梯已經結束，不更新" }); continue; }
    if (!trip) { results.push({ tab: t.tab, skipped: `後台找不到「${route}」${when.year ? when.year + "-" : ""}${when.md} 出發的梯次` }); continue; }
    const { patch, warnings } = buildPatch(trip, t.rows || [], source, t.tab, equipPricing, porterPricing);
    const before = trip.registered || 0;
    if (!body.dryRun) {
      const { error: upErr } = await db.from("trips")
        .update({ data: { ...trip, ...patch }, updated_at: new Date().toISOString() }).eq("id", trip.id);
      if (upErr) { results.push({ tab: t.tab, trip: trip.date, error: upErr.message }); continue; }
    }
    results.push({
      tab: t.tab, trip: trip.date, registered: `${before} → ${patch.registered}`,
      equipment: patch.equipment, porter: patch.porter,
      diet: { meat: patch.diet.meat, veg: patch.diet.veg, other: patch.diet.other, notes: patch.diet.notes.length },
      warnings,
    });
  }
  return json({ ok: true, dryRun: !!body.dryRun, route, results });
});
