// 用「已部署的同一份」後端程式（supabase/functions/trip-sync/index.ts）在本機算出要寫進後台的資料，產生 SQL。
// 用法：node --experimental-strip-types compute.ts <sheets.json> <trips.json> <settings.json> <out.sql>
//   trips.json：[{id, data:{name,date,dateEnd,registered,equipRenters,porterBuyers,excelLink,sheetSync}}]（SKILL.md 的查詢）
//   settings.json：[{key:"equipPricing",data:[...]},{key:"porterPricing",data:[...]}]
// 會印出每一梯的變化給人檢查；out.sql 只更新同步欄位（data || patch），不動其他欄位。
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const [sheetsF, tripsF, settingsF, outF] = process.argv.slice(2);
const here = path.dirname(url.fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "../../../../supabase/functions/trip-sync/index.ts"), "utf8");

// 把 Edge Function 改成可在本機呼叫：換掉 supabase client／Deno，Deno.serve 變成匯出的 handler
const mod = src
  .replace(/^import \{ createClient \}.*$/m, "")
  .replace(/const db = createClient\([\s\S]*?\);/, "let db: any;")
  .replace("Deno.serve(async (req) => {", "export async function handler(req: any, _db: any) {\n  db = _db;")
  .replace(/\}\);\s*$/, "}\n");
const tmp = path.join(path.dirname(path.resolve(outF)), "_trip-sync-local.ts");
fs.writeFileSync(tmp, "const Deno: any = { env: { get: () => 'k' } };\n" + mod);
const { handler } = await import(url.pathToFileURL(tmp).href);

const sheets = JSON.parse(fs.readFileSync(sheetsF, "utf8"));
const trips = JSON.parse(fs.readFileSync(tripsF, "utf8"));
const settings = JSON.parse(fs.readFileSync(settingsF, "utf8"));
const KEYS = ["registered", "equipRenters", "equipment", "porterBuyers", "porter", "diet", "startPoints", "sheetSync", "excelLink"];
const updates = new Map<string, any>();
const fakeDb = {
  from: (t: string) => ({
    select: () => t === "trips" ? Promise.resolve({ data: trips }) : { in: () => Promise.resolve({ data: settings }) },
    update: (row: any) => ({ eq: (_c: string, id: string) => {
      const patch: any = {};
      for (const k of KEYS) if (k in row.data) patch[k] = row.data[k];
      const before = trips.find((x: any) => x.id === id)?.data || {};
      if (before.excelLink && patch.excelLink === before.excelLink) delete patch.excelLink;
      updates.set(id, patch);
      return Promise.resolve({ error: null });
    } }),
  }),
};
for (const s of sheets) {
  const res = await handler({ method: "POST", headers: { get: () => "k" },
    json: async () => ({ source: s.title, url: s.url, rows: s.rows }) }, fakeDb);
  const j = await res.json();
  console.log(`== ${s.title} → 路線「${j.route}」`);
  for (const r of j.results) console.log(`   ${r.trip}  人數 ${r.registered}${r.removed ? `（槓掉 ${r.removed}）` : ""}  ${r.equipment}  ${r.porter}  ${r.warnings.join("；")}`);
  if (j.unmatched?.length) console.log(`   ⚠ 對不到梯次：${j.unmatched.join(" / ")}`);
}
const sql = [...updates.entries()].map(([id, p]) =>
  `update trips set data = data || '${JSON.stringify(p).replace(/'/g, "''")}'::jsonb, updated_at = now() where id = '${id}';`).join("\n");
fs.writeFileSync(outF, sql + "\n");
fs.unlinkSync(tmp);
console.log(`\n${updates.size} 梯，SQL 寫到 ${outF}`);
