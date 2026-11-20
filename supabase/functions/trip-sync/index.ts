// 報名表 → 團務自動同步（Supabase Edge Function）
//
// 集中版 Apps Script（apps-script/trip-sync-all.gs）每天 07:50、18:00 讀取報名資料夾裡每份回覆試算表的
// 第一頁「表單回覆」，把每一列（含選的行程日期、是否被刪除線槓掉）POST 到這裡，這裡依行程日期分到各梯，更新後台 trips：
//   - 報名人數 registered
//   - 裝備租借 equipRenters / equipment（依後台「裝備費用」設定比對品項與單價）
//   - 代揹服務 porterBuyers / porter（依後台「代揹費用」設定計價）
//   - 餐食需求 diet（葷素人數、不吃的東西、過敏）
//   - 同步紀錄 sheetSync（時間、來源、無法辨識的內容）
//
// 只送姓名與上面這些欄位，身分證、電話、地址等個資不會傳過來。
// 被槓掉的列視為取消，不算人數；同一梯同名只算一人（取最後一筆）。
// 後台手動新增的租借者／代揹購買者（不在報名表裡的人）會保留。已結束的梯次不更新。
//
// 驗證：header x-sync-key 必須等於 secret TRIP_SYNC_KEY。
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 由 Supabase 自動提供。

import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

type Row = { name?: string; equip?: string; porter?: string; diet?: string | null; avoid?: string; allergy?: string;
  date?: string; ts?: string; struck?: boolean };
type Trip = Record<string, any> & { id: string; name: string; date: string; dateEnd?: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
// 「無」「不挑食」「沒有」之類視為空白
const NONE_WORD = /^(無|无|沒有|没有|不挑食|都可以?|都行|都吃|全吃|什麼都吃|皆可|略|無特殊需求|無特別需求|none|no|n\/?a|x|-|—)$/i;
// 整段都是「無」「都吃」「都可以 不挑食」這類字眼
const isNone = (v: string) => v.split(/[\s,，、;；]+/).map((w) => w.replace(/[～~!！。.]+$/, "")).filter(Boolean).every((w) => NONE_WORD.test(w));
const NONE = { test: (v: string) => isNone(clean(v)) };
const meaningful = (v: unknown) => { const s = clean(v); return s && !isNone(s) ? s : ""; };
// 測試用的報名（姓名 test／測試）不算
const isTestName = (n: string) => /^(test|測試|测试)\d*$/i.test(clean(n));

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const todayTW = () => ymd(new Date(Date.now() + 8 * 3600000));
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// 名稱比對時忽略空白、「+」「＆」「&」、表情符號
const norm = (v: unknown) => clean(v).replace(/[\s+＋&＆、・|｜🌸-🫶\u2600-\u27BF\uFE0F]/gu, "");

// 試算表標題「入野門-阿里山眠月線2天1夜報名表 (回覆)」→「阿里山眠月線」
const titleRoute = (t: string) => clean(clean(t).replace(/[（(]回覆[)）]|報名表|^\d{4}|入野門[-－]?|櫻花季|\d+天\d+夜/g, ""));

// 每列要對哪條路線：先看行程日期「｜」前面的名稱（例：富士山5天4夜），再看試算表標題
function resolveRoute(names: string[], prefix: string, route: string): string | null {
  for (const cand of [prefix, route]) {
    const n = norm(cand);
    if (!n) continue;
    const exact = names.find((x) => norm(x) === n);
    if (exact) return exact;
  }
  for (const cand of [route, prefix]) {   // 後台名稱被包含在標題裡（例：「雪山主東峰」→「雪山主東」），取最長的
    const n = norm(cand);
    const hit = names.filter((x) => n && n.includes(norm(x))).sort((a, b) => b.length - a.length)[0];
    if (hit) return hit;
  }
  return null;
}

// 「合歡群峰｜2026/12/12-13 (六日)」「富士山5天4夜｜【開山梯】6/30（三）」「6/20-21」→ 出發日
// 沒寫年份：用填表時間推算（出發日不會早於填表日）
function rowDate(text: string, ts: string): string | null {
  const m = clean(text).match(/(?:(\d{4})\s*[\/.\-]\s*)?(\d{1,2})\s*[\/.]\s*(\d{1,2})/);
  if (!m) return null;
  const mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (m[1]) return `${m[1]}-${pad(mo)}-${pad(d)}`;
  const t = clean(ts).match(/(\d{4})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{1,2})/);
  let y = t ? +t[1] : +todayTW().slice(0, 4);
  const sub = t ? `${t[1]}-${pad(+t[2])}-${pad(+t[3])}` : todayTW();
  if (`${y}-${pad(mo)}-${pad(d)}` < sub) y++;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

// 同一天出發的梯次；沒有的話找日期範圍涵蓋那天的梯次（例：玉山表單寫登山日 12/25，後台 12/24 出發）
function findTrip(trips: Trip[], date: string): Trip | null {
  const same = trips.find((t) => t.date === date);
  if (same) return same;
  const cover = trips.filter((t) => t.date <= date && (t.dateEnd || t.date) >= date);
  return cover.length === 1 ? cover[0] : null;
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
  // 被槓掉的不算；同名只留最後一筆（同一人重填表單）
  const byName = new Map<string, Row & { name: string }>();
  for (const r of rows) { const name = clean(r.name); if (name && !r.struck && !isTestName(name)) byName.set(name, { ...r, name }); }
  const people = [...byName.values()];
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
    // 「無特殊需求」之類＝沒有限制，算葷食
    const k = dietKind(p.diet || "") || (p.diet != null && !meaningful(p.diet) ? "meat" : "");
    if (hasDiet) { if (k) diet[k]++; else diet.other++; }
    const avoid = meaningful(p.avoid), allergy = meaningful(p.allergy);
    // 「鍋邊素 Flexitarian」→「鍋邊素」；葷食不另外標
    const vegLabel = !hasDiet || k === "meat" ? "" : clean(p.diet).replace(/\s*[A-Za-z].*$/, "");
    if (isTestName(p.name)) continue;
    if (avoid || allergy || vegLabel) diet.notes.push({ name: p.name, diet: vegLabel, avoid, allergy });
  }

  return {
    patch: {
      registered: people.length,
      equipRenters, equipment, porterBuyers, porter, diet,
      sheetSync: { at: new Date().toISOString(), source, tab, count: people.length, removed: rows.filter((r) => r.struck).length, warnings },
    },
    warnings,
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const key = Deno.env.get("TRIP_SYNC_KEY");
  if (!key || req.headers.get("x-sync-key") !== key) return json({ error: "unauthorized" }, 401);

  let body: { route?: string; source?: string; rows?: Row[]; tabs?: unknown; dryRun?: boolean };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  // 舊版（讀日期分頁）的試算表程式：停用，避免和第一頁的資料互相覆蓋
  if (body.tabs) return json({ error: "舊版同步程式已停用，請改用集中版 apps-script/trip-sync-all.gs，並刪除這份試算表 Apps Script 的觸發條件" }, 410);
  const source = clean(body.source);
  const route = titleRoute(body.route || source);
  if (!Array.isArray(body.rows)) return json({ error: "需要 rows" }, 400);

  const { data: tripRows, error } = await db.from("trips").select("id,data");
  if (error) return json({ error: error.message }, 500);
  const all: Trip[] = (tripRows || []).map((r: any) => ({ ...r.data, id: r.id }));
  const names = [...new Set(all.map((t) => clean(t.name)).filter(Boolean))];

  const { data: settingRows } = await db.from("settings").select("key,data").in("key", ["equipPricing", "porterPricing"]);
  const setting = (k: string) => (settingRows || []).find((r: any) => r.key === k)?.data || [];
  const equipPricing = setting("equipPricing"), porterPricing = setting("porterPricing");

  // 每列分到對應梯次
  const today = todayTW();
  const groups = new Map<string, { trip: Trip; rows: Row[] }>();
  const unmatched: string[] = [];
  for (const r of body.rows) {
    if (!clean(r.name)) continue;
    const text = clean(r.date);
    const prefix = text.includes("｜") || text.includes("|") ? text.split(/[｜|]/)[0] : "";
    const name = resolveRoute(names, prefix, route);
    const date = rowDate(text.slice(prefix ? prefix.length : 0), r.ts || "");
    const trip = name && date ? findTrip(all.filter((t) => clean(t.name) === name), date) : null;
    if (!trip) { if (!r.struck && date && date >= today) unmatched.push(`${text || "（沒填日期）"}`); continue; }
    if ((trip.dateEnd || trip.date) < today) continue;   // 已結束的梯次不更新
    if (!groups.has(trip.id)) groups.set(trip.id, { trip, rows: [] });
    groups.get(trip.id)!.rows.push(r);
  }

  const results: any[] = [];
  for (const { trip, rows } of groups.values()) {
    const { patch, warnings } = buildPatch(trip, rows, source, "表單回覆", equipPricing, porterPricing);
    const before = trip.registered || 0;
    if (!body.dryRun) {
      const { error: upErr } = await db.from("trips")
        .update({ data: { ...trip, ...patch }, updated_at: new Date().toISOString() }).eq("id", trip.id);
      if (upErr) { results.push({ trip: `${trip.name} ${trip.date}`, error: upErr.message }); continue; }
    }
    results.push({
      trip: `${trip.name} ${trip.date}`, registered: `${before} → ${patch.registered}`,
      removed: rows.filter((r) => r.struck).length,
      equipment: patch.equipment.map((e: any) => `${e.item}×${e.quantity}`).join("、"),
      porter: patch.porter.weight ? `${patch.porter.weight}kg` : "", warnings,
    });
  }
  return json({ ok: true, dryRun: !!body.dryRun, route, results, unmatched: [...new Set(unmatched)] });
});
