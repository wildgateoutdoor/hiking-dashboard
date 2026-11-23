// 團務未完成事項 → LINE 群組自動提醒（Supabase Edge Function）
//
// 每天 09:00（台灣時間）由 pg_cron 呼叫一次，讀取後台 trips 與 settings，
// 只列「今天」「明天」到期、還沒完成的事（入園申請、住宿／餐食、團務提醒項目、未成團處理），推播到已開啟的 LINE 群組。
// 沒有到期事項的日子不傳。群組打「全部待辦」可看跟後台「時程提醒」一樣的 7天內／14天內清單。
//
// 三種呼叫方式：
//   1. pg_cron：{ action:'cron' } + header x-cron-key（= line_remind_config.cron_key，migration 自動產生）
//   2. LINE webhook：header x-line-signature（用 LINE_CHANNEL_SECRET 驗證）
//        - 只處理群組；客人私訊、加好友不理會
//        - 機器人被加進群組 → 記下來但預設不提醒，要在後台開啟
//        - 已開啟的群組打「待辦」→ 今明兩天的待辦；「全部待辦」→ 14 天內清單（回覆訊息不計入每月推播則數）；打「解除提醒」→ 停止
//   3. 後台（index.html → 規則設定 → LINE 提醒）：{ action:'admin:*' } + header x-admin-pw
//
// LINE 金鑰：Secrets LINE_CHANNEL_ACCESS_TOKEN、LINE_CHANNEL_SECRET，或存在 line_remind_config.line_token／line_secret（優先）
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 由 Supabase 自動提供。

import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
// LINE 金鑰：line_remind_config.line_token／line_secret 有值就用資料庫的，否則用 Edge Function secrets
// 貼金鑰時常多帶空白或換行，一律去掉
const strip = (v: unknown) => String(v ?? "").replace(/\s+/g, "");
let LINE_TOKEN = strip(Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN"));
let LINE_SECRET = strip(Deno.env.get("LINE_CHANNEL_SECRET"));
async function loadCreds() {
  const { data } = await db.from("line_remind_config").select("line_token,line_secret").eq("id", 1).maybeSingle();
  if (data?.line_token) LINE_TOKEN = strip(data.line_token);
  if (data?.line_secret) LINE_SECRET = strip(data.line_secret);
}
const DASHBOARD_URL = "https://admin.wildgateoutdoor.com";
// 與 wish-api 相同的後台密碼
const DEFAULT_ADMIN_PW_HASH = "3f7cfd02d51d09c322fc3c27bdce98e87aabb9847683262e67be13710dfb90b7";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-pw",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ───────── 日期（一律用台灣日期，存成 UTC 午夜） ─────────
const DAYS = ["日", "一", "二", "三", "四", "五", "六"];
const pad = (n: number) => String(n).padStart(2, "0");
const todayStr = () => { const d = new Date(Date.now() + 8 * 3600000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const parseD = (s: string) => new Date(s + "T00:00:00Z");
const dateStr = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const fmtShort = (s: string) => { const d = parseD(s); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const fmtDate = (s: string) => `${fmtShort(s)}（${DAYS[parseD(s).getUTCDay()]}）`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };

type Trip = Record<string, any> & { id: string; name: string; date: string; dateEnd?: string };
type Rule = { names: string[]; months?: number; days?: number; minPax?: number };
type TaskRem = { id: string; name: string; daysBefore: number[] };
type Reason = { icon: string; text: string };

const DEF_TASK_REMINDERS: TaskRem[] = [
  { id: "tr1", name: "訂包車時間", daysBefore: [14] },
  { id: "tr2", name: "保險處理", daysBefore: [2] },
  { id: "tr3", name: "天氣提醒", daysBefore: [7, 3, 1] },
  { id: "tr4", name: "行前手冊發放", daysBefore: [14] },
];

// settings 沒有 minGroupRules 時，後台用這組預設值（同 index.html DEF_MINGROUP）
const DEF_MINGROUP: Rule[] = [
  { minPax: 3, names: ["合歡群峰", "戒茂斯上嘉明湖", "高島縱走", "加里山", "水漾森林", "郡大山", "玉山", "嘉明湖", "北大武", "奇萊南華", "眠月線", "大小霸", "雪山主東"] },
];

// ───────── 待辦事項（與 index.html renderTimeReminders 相同的規則） ─────────
function buildReminders(trips: Trip[], s: Record<string, any>) {
  const now = parseD(todayStr());
  const daysUntil = (ds: string) => Math.ceil((parseD(ds).getTime() - now.getTime()) / 864e5);
  const applyRules: Rule[] = s.applyRules || [];
  const lodgeRules: Rule[] = s.lodgeRules || [];
  const mealRules: Rule[] = s.mealRules || [];
  const minGroupRules: Rule[] = s.minGroupRules || DEF_MINGROUP;
  const taskReminders: TaskRem[] = s.taskReminders || DEF_TASK_REMINDERS;

  function matchRuleIn(rules: Rule[], name: string): Rule | null {
    if (!name) return null; const n = name.trim();
    let best: Rule | null = null, bestLen = -1;
    for (const r of rules) for (const rn of r.names || []) if (rn && n.includes(rn) && rn.length > bestLen) { best = r; bestLen = rn.length; }
    if (best) return best;
    let fb: Rule | null = null, fbLen = Infinity;
    for (const r of rules) for (const rn of r.names || []) if (rn && rn.includes(n) && rn.length < fbLen) { fb = r; fbLen = rn.length; }
    return fb;
  }
  function calcDateBefore(tripDate: string, months = 0, days = 0) {
    const d = parseD(tripDate); d.setUTCMonth(d.getUTCMonth() - (months || 0)); d.setUTCDate(d.getUTCDate() - (days || 0)); return d;
  }
  function ruleInfo(rules: Rule[], t: Trip) {
    const r = matchRuleIn(rules, t.name);
    if (!r) return { state: "unset" as const };
    if ((r.months || 0) < 0) return { state: "none" as const };
    const d = calcDateBefore(t.date, r.months, r.days);
    return { state: "dated" as const, ds: dateStr(d), days: Math.ceil((d.getTime() - now.getTime()) / 864e5) };
  }
  const nightsOf = (t: Trip) => !t.dateEnd || t.dateEnd === t.date ? 0 : Math.max(0, Math.round((parseD(t.dateEnd).getTime() - parseD(t.date).getTime()) / 864e5));
  const lodgeUnbooked = (t: Trip) => { const n = nightsOf(t); const L = t.lodging || []; for (let i = 0; i < n; i++) { const e = L[i]; if (!e || e.book === "no") return true; } return false; };
  const lodgeUnpaid = (t: Trip) => { const n = nightsOf(t); const L = t.lodging || []; for (let i = 0; i < n; i++) { const e = L[i]; if (e && e.book === "yes" && e.pay !== "yes") return true; } return false; };
  const meal = (t: Trip) => t.meal || { book: "no", pay: "no" };
  const getMinGroup = (t: Trip) => matchRuleIn(minGroupRules, t.name)?.minPax ?? null;
  const taskDueDates = (t: Trip, tr: TaskRem) => tr.daysBefore.slice().sort((a, b) => b - a).map((db) => addDays(parseD(t.date), -db));
  const taskDueLabel = (t: Trip, tr: TaskRem) => {
    const ds = taskDueDates(t, tr);
    return ds.length <= 1 ? `需於 ${fmtShort(dateStr(ds[0]))} 前完成` : `請於 ${ds.map((d) => fmtShort(dateStr(d))).join("、")} 完成`;
  };

  function collectReasons(t: Trip, endDate: Date): Reason[] {
    const reasons: Reason[] = [];
    const tripInWin = parseD(t.date) <= endDate;
    const ai = ruleInfo(applyRules, t);
    if (ai.state === "dated" && t.applyStatus !== "applied" && t.applyStatus !== "waitlist") {
      const dd = parseD(ai.ds);
      if (dd <= endDate || dd < now) {
        reasons.push({ icon: "📋", text: ai.days < 0 ? `入園申請已逾期（${fmtShort(ai.ds)}）` : `入園申請截止 ${fmtShort(ai.ds)}（剩 ${ai.days} 天）` });
      }
    }
    const dl = (info: ReturnType<typeof ruleInfo>) => {
      if (info.state === "dated") { const d = parseD(info.ds); if (d <= endDate || d < now || tripInWin) return info.days >= 0 ? `需於 ${fmtShort(info.ds)} 前完成` : "已逾期"; return null; }
      // 沒有住宿／餐食規則：以入園申請截止日為期限，再沒有就以出發日為期限；期限在區間內（或已逾期）才提醒
      // （後台畫面不看區間，但 LINE 只提醒近期要做的事，避免幾個月後的行程每天洗版）
      if (ai.state === "dated") { const d = parseD(ai.ds); if (d <= endDate || d < now) return ai.days >= 0 ? `需於 ${fmtShort(ai.ds)} 前完成` : "已逾期"; return null; }
      return tripInWin ? `出發日 ${fmtShort(t.date)}` : null;
    };
    const li = ruleInfo(lodgeRules, t), mi = ruleInfo(mealRules, t);
    let x: string | null;
    if (lodgeUnbooked(t) && (x = dl(li))) reasons.push({ icon: "🏨", text: `住宿尚未預訂（${x}）` });
    if (lodgeUnpaid(t) && (x = dl(li))) reasons.push({ icon: "🏨", text: `住宿未付款（${x}）` });
    if (meal(t).book === "no" && (x = dl(mi))) reasons.push({ icon: "🍽", text: `餐食尚未預訂（${x}）` });
    if (meal(t).book === "yes" && meal(t).pay !== "yes" && (x = dl(mi))) reasons.push({ icon: "🍽", text: `餐食未付款（${x}）` });
    const ch = t.charter || {}, ins = t.insurance || {};
    for (const tr of taskReminders) {
      if (!tr.daysBefore?.length) continue;
      const isDone = (tr.name === "訂包車時間" && ch.book === "yes" && ch.pay === "yes") ||
        (tr.name === "保險處理" && ins.done === "yes" && ins.pay === "yes") ||
        (tr.name === "天氣提醒" && t.weatherDone === "yes") ||
        (tr.name === "行前手冊發放" && t.preNoticeDone === "yes");
      if (isDone) continue;
      let label = tr.name;
      if (tr.name === "保險處理" && ins.done === "yes" && ins.pay !== "yes") label = "保險付款";
      if (tr.name === "訂包車時間" && ch.book === "yes" && ch.pay !== "yes") label = "包車付款";
      const dd = addDays(parseD(t.date), -Math.max(...tr.daysBefore));
      if (dd <= endDate || dd < now || tripInWin) reasons.push({ icon: "⚡", text: `${label}（${taskDueLabel(t, tr)}）` });
    }
    return reasons;
  }
  function applyMinGroup(t: Trip, reasons: Reason[]): Reason[] {
    const mg = getMinGroup(t);
    if (!mg || (t.registered || 0) >= mg) return reasons;
    if ((t.registered || 0) === 0) return [];
    const ai = ruleInfo(applyRules, t);
    if (ai.state === "dated") { if (ai.days >= 0) return []; }
    else if (daysUntil(t.date) > 7) return [];
    return [{ icon: "⚠️", text: `未達最低 ${mg} 人成團，處理未成團後續事項` }];
  }

  // 每項待辦的到期日（給每日 LINE 提醒用：只列今天、明天到期的）
  type Due = { icon: string; text: string; dates: string[] };
  function dueItems(t: Trip): Due[] {
    const ai = ruleInfo(applyRules, t);
    const mg = getMinGroup(t), reg = t.registered || 0;
    if (mg && reg < mg) {
      if (reg === 0) return [];
      // 未達最低成團：入園申請截止日（沒有的話出發前 7 天）起要處理未成團後續
      const d = ai.state === "dated" ? ai.ds : dateStr(addDays(parseD(t.date), -7));
      return [{ icon: "⚠️", text: `未達最低 ${mg} 人成團，處理未成團後續事項`, dates: [d] }];
    }
    const out: Due[] = [];
    if (ai.state === "dated" && t.applyStatus !== "applied" && t.applyStatus !== "waitlist") out.push({ icon: "📋", text: "入園申請截止", dates: [ai.ds] });
    // 住宿／餐食期限：自己的規則 → 入園申請截止日 → 出發日
    const dueOf = (info: ReturnType<typeof ruleInfo>) => info.state === "dated" ? info.ds : ai.state === "dated" ? ai.ds : t.date;
    const li = ruleInfo(lodgeRules, t), mi = ruleInfo(mealRules, t);
    if (lodgeUnbooked(t)) out.push({ icon: "🏨", text: "住宿預訂", dates: [dueOf(li)] });
    if (lodgeUnpaid(t)) out.push({ icon: "🏨", text: "住宿付款", dates: [dueOf(li)] });
    if (meal(t).book === "no") out.push({ icon: "🍽", text: "餐食預訂", dates: [dueOf(mi)] });
    if (meal(t).book === "yes" && meal(t).pay !== "yes") out.push({ icon: "🍽", text: "餐食付款", dates: [dueOf(mi)] });
    const ch = t.charter || {}, ins = t.insurance || {};
    for (const tr of taskReminders) {
      if (!tr.daysBefore?.length) continue;
      const isDone = (tr.name === "訂包車時間" && ch.book === "yes" && ch.pay === "yes") ||
        (tr.name === "保險處理" && ins.done === "yes" && ins.pay === "yes") ||
        (tr.name === "天氣提醒" && t.weatherDone === "yes") ||
        (tr.name === "行前手冊發放" && t.preNoticeDone === "yes");
      if (isDone) continue;
      let label = tr.name === "訂包車時間" ? "訂包車" : tr.name;
      if (tr.name === "保險處理" && ins.done === "yes" && ins.pay !== "yes") label = "保險付款";
      if (tr.name === "訂包車時間" && ch.book === "yes" && ch.pay !== "yes") label = "包車付款";
      out.push({ icon: "⚡", text: label, dates: tr.daysBefore.map((db) => dateStr(addDays(parseD(t.date), -db))) });
    }
    return out;
  }

  // 已結束／倒團／未成團的梯次不提醒
  const future = trips.filter((t) => t.date && daysUntil(t.date) >= 0 && !["done", "collapsed", "notFormed"].includes(t.status));
  const win7 = addDays(now, 6), win14 = addDays(now, 13);
  function section(end: Date, prev: Date | null) {
    const cards: { t: Trip; reasons: Reason[]; days: number }[] = [];
    for (const t of future) {
      let reasons = collectReasons(t, end);
      if (prev) { const seen = new Set(collectReasons(t, prev).map((r) => r.text)); reasons = reasons.filter((r) => !seen.has(r.text)); }
      reasons = applyMinGroup(t, reasons);
      if (reasons.length) cards.push({ t, reasons, days: daysUntil(t.date) });
    }
    return cards.sort((a, b) => a.days - b.days);
  }
  function daily(day: string) {
    const cards: { t: Trip; reasons: Reason[]; days: number }[] = [];
    for (const t of future) {
      const reasons = dueItems(t).filter((x) => x.dates.includes(day)).map((x) => ({ icon: x.icon, text: x.text }));
      if (reasons.length) cards.push({ t, reasons, days: daysUntil(t.date) });
    }
    return cards.sort((a, b) => a.days - b.days);
  }
  const today = todayStr(), tomorrow = dateStr(addDays(now, 1));
  return {
    today, tomorrow,
    week: section(win7, null), fortnight: section(win14, win7),
    dueToday: daily(today), dueTomorrow: daily(tomorrow),
  };
}

function formatMessage(r: ReturnType<typeof buildReminders>, header = "⛰ 入野門團務提醒"): string | null {
  if (!r.week.length && !r.fortnight.length) return null;
  const card = (c: { t: Trip; reasons: Reason[]; days: number }) => {
    const t = c.t;
    const range = t.dateEnd && t.dateEnd !== t.date ? `${fmtShort(t.date)}~${fmtShort(t.dateEnd)}` : fmtDate(t.date);
    const when = c.days === 0 ? "今天出發" : `${c.days} 天後出發`;
    return `▍${t.name} ${range}（${when}）\n` + c.reasons.map((x) => `　${x.icon} ${x.text}`).join("\n");
  };
  const parts = [`${header}｜${fmtDate(r.today)}`];
  if (r.week.length) parts.push(`【7天內待辦事項】\n` + r.week.map(card).join("\n\n"));
  if (r.fortnight.length) parts.push(`【14天內待辦事項】\n` + r.fortnight.map(card).join("\n\n"));
  parts.push(`完成後請到後台打勾 👉 ${DASHBOARD_URL}`);
  let text = parts.join("\n\n");
  if (text.length > 4900) text = text.slice(0, 4850) + `\n…（太長了，其餘請看後台）\n${DASHBOARD_URL}`;
  return text;
}

type Rem = ReturnType<typeof buildReminders>;
// 每日提醒：只列「今天」「明天」到期的事
function formatDaily(r: Rem, header = "⛰ 入野門團務提醒"): string | null {
  if (!r.dueToday.length && !r.dueTomorrow.length) return null;
  const card = (c: { t: Trip; reasons: Reason[]; days: number }) => {
    const t = c.t;
    const range = t.dateEnd && t.dateEnd !== t.date ? `${fmtShort(t.date)}~${fmtShort(t.dateEnd)}` : fmtShort(t.date);
    return `▍${t.name} ${range} 出發\n` + c.reasons.map((x) => `　${x.icon} ${x.text}`).join("\n");
  };
  const parts = [`${header}｜${fmtDate(r.today)}`];
  if (r.dueToday.length) parts.push(`【今天要做】\n` + r.dueToday.map(card).join("\n\n"));
  if (r.dueTomorrow.length) parts.push(`【明天要做】${fmtDate(r.tomorrow)}\n` + r.dueTomorrow.map(card).join("\n\n"));
  parts.push(`完成後請到後台打勾 👉 ${DASHBOARD_URL}`);
  let text = parts.join("\n\n");
  if (text.length > 4900) text = text.slice(0, 4850) + `\n…（太長了，其餘請看後台）\n${DASHBOARD_URL}`;
  return text;
}

async function loadReminders(): Promise<Rem> {
  const [{ data: tripRows, error: e1 }, { data: setRows, error: e2 }] = await Promise.all([
    db.from("trips").select("id,data"),
    db.from("settings").select("key,data"),
  ]);
  if (e1 || e2) throw new Error((e1 || e2)!.message);
  const trips = (tripRows || []).map((r: any) => ({ id: r.id, ...r.data })) as Trip[];
  const s: Record<string, any> = {};
  for (const r of setRows || []) s[(r as any).key] = (r as any).data;
  return buildReminders(trips, s);
}
// mode daily：今天＋明天（每日推播、群組打「待辦」）；all：7天內／14天內（群組打「全部待辦」）
async function currentMessage(mode: "daily" | "all" = "daily", header?: string) {
  const rem = await loadReminders();
  return mode === "daily"
    ? { text: formatDaily(rem, header), count: rem.dueToday.length + rem.dueTomorrow.length }
    : { text: formatMessage(rem, header), count: rem.week.length + rem.fortnight.length };
}

// ───────── LINE API ─────────
async function lineApi(path: string, body?: unknown) {
  const res = await fetch(`https://api.line.me${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${LINE_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`LINE ${res.status}: ${txt.slice(0, 300)}`);
  return txt ? JSON.parse(txt) : {};
}
const push = (to: string, text: string) => lineApi("/v2/bot/message/push", { to, messages: [{ type: "text", text }] });
const reply = (token: string, text: string) => lineApi("/v2/bot/message/reply", { replyToken: token, messages: [{ type: "text", text }] });

async function targetName(src: any): Promise<string> {
  try {
    if (src.type === "group") return (await lineApi(`/v2/bot/group/${src.groupId}/summary`)).groupName || "";
  } catch (e) { console.error(e); }
  return "";
}

async function setEnabled(id: string, enabled: boolean) {
  const { error } = await db.from("line_targets").update({ enabled, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

async function sendAll() {
  const { text, count } = await currentMessage();
  const { data: targets, error } = await db.from("line_targets").select("id,name").eq("enabled", true).eq("kind", "group");
  if (error) throw new Error(error.message);
  const results: { id: string; name: string; ok: boolean; error?: string }[] = [];
  if (text) {
    for (const t of targets || []) {
      try { await push(t.id, text); results.push({ id: t.id, name: t.name, ok: true }); }
      catch (e) { results.push({ id: t.id, name: t.name, ok: false, error: String((e as Error).message || e) }); }
    }
  }
  const result = { at: new Date().toISOString(), trips: count, sent: !!text, targets: results };
  await db.from("line_remind_config").update({ last_run: result }).eq("id", 1);
  return result;
}

// ───────── 驗證 ─────────
async function sha256hex(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function sameStr(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function lineSignatureOk(body: string, sig: string) {
  if (!LINE_SECRET || !sig) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(LINE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return sameStr(btoa(String.fromCharCode(...mac)), sig);
}

// ───────── LINE webhook ─────────
// 這個官方帳號也對客人開放，所以：
//   - 只處理「群組」；客人的一對一私訊、加好友一律不理會，也不綁定
//   - 機器人被拉進任何群組只會記下來、預設「不提醒」，要在後台「LINE 提醒」按開啟（避免客人把機器人拉進自己的群組就收到團務資料）
//   - 「待辦」「解除提醒」只在已開啟的群組有作用
const HELP = "可用指令：\n・待辦：今天、明天要做的事\n・全部待辦：14 天內的待辦清單\n・解除提醒：停止每日提醒（要再開啟請到後台「規則設定 → LINE 提醒」）";
async function onLineEvent(ev: any) {
  const src = ev.source || {};
  if (src.type !== "group" || !src.groupId) return;
  const id = src.groupId;
  if (ev.type === "join") {
    const { data: row } = await db.from("line_targets").select("id").eq("id", id).maybeSingle();
    if (!row) {
      const { error } = await db.from("line_targets").insert({ id, kind: "group", name: await targetName(src), enabled: false });
      if (error) throw new Error(error.message);
    }
    return;
  }
  if (ev.type === "leave") { await setEnabled(id, false); return; }
  if (ev.type !== "message" || ev.message?.type !== "text") return;
  const { data: row } = await db.from("line_targets").select("id,name,enabled").eq("id", id).maybeSingle();
  if (!row?.enabled) return;
  if (!row.name) { const name = await targetName(src); if (name) await db.from("line_targets").update({ name }).eq("id", id); }
  const msg = String(ev.message.text || "").trim();
  if (/^(待辦|待办)$/.test(msg)) {
    const { text } = await currentMessage("daily", "📋 今明兩天待辦");
    await reply(ev.replyToken, text || "🎉 今天和明天沒有到期的待辦事項\n（打「全部待辦」看 14 天內的清單）");
  } else if (/^(全部待辦|全部待办)$/.test(msg)) {
    const { text } = await currentMessage("all", "📋 14 天內待辦事項");
    await reply(ev.replyToken, text || "🎉 目前 14 天內沒有待辦事項");
  } else if (/^(解除|關閉|关闭|停止)提醒$/.test(msg)) {
    await setEnabled(id, false);
    await reply(ev.replyToken, "已停止每日提醒。要再開啟請到後台「規則設定 → LINE 提醒」。");
  } else if (/^(團務說明|團務指令)$/.test(msg)) {
    await reply(ev.replyToken, HELP);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const raw = await req.text();
  try {
    await loadCreds();
    // LINE webhook
    const sig = req.headers.get("x-line-signature");
    if (sig !== null) {
      if (!(await lineSignatureOk(raw, sig))) return json({ error: "bad signature" }, 401);
      const body = JSON.parse(raw || "{}");
      for (const ev of body.events || []) {
        try { await onLineEvent(ev); } catch (e) { console.error("line event", e); }
      }
      return json({ ok: true });
    }

    const b = JSON.parse(raw || "{}");
    const action = String(b.action || "");

    if (action === "cron") {
      const { data: cfg } = await db.from("line_remind_config").select("cron_key").eq("id", 1).single();
      const key = req.headers.get("x-cron-key") || "";
      if (!cfg?.cron_key || !sameStr(key, cfg.cron_key)) return json({ error: "bad key" }, 401);
      if (!LINE_TOKEN) return json({ error: "LINE_CHANNEL_ACCESS_TOKEN 未設定" }, 500);
      return json(await sendAll());
    }

    if (action.startsWith("admin:")) {
      const pw = (req.headers.get("x-admin-pw") || "").trim().normalize("NFKC");
      const want = (Deno.env.get("WISH_ADMIN_PW_HASH") || DEFAULT_ADMIN_PW_HASH).toLowerCase();
      if (!pw || !sameStr(await sha256hex(pw), want)) return json({ error: "後台密碼錯誤" }, 401);
      switch (action) {
        case "admin:status": {
          const { data: targets } = await db.from("line_targets").select("id,kind,name,enabled,updated_at").order("created_at");
          const { data: cfg } = await db.from("line_remind_config").select("last_run").eq("id", 1).single();
          const { text } = await currentMessage();
          return json({ configured: !!(LINE_TOKEN && LINE_SECRET), targets: targets || [], lastRun: cfg?.last_run || null, preview: text });
        }
        case "admin:send":
          if (!LINE_TOKEN) return json({ error: "還沒設定 LINE_CHANNEL_ACCESS_TOKEN" }, 400);
          return json(await sendAll());
        case "admin:toggle":
          await setEnabled(String(b.id || ""), !!b.enabled);
          return json({ ok: true });
        case "admin:remove": {
          const { error } = await db.from("line_targets").delete().eq("id", String(b.id || ""));
          if (error) throw new Error(error.message);
          return json({ ok: true });
        }
      }
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
