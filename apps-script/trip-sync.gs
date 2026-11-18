/**
 * 入野門｜報名表 → 後台團務自動同步
 *
 * 放在「每條路線的報名回覆試算表」裡（擴充功能 → Apps Script），設定步驟見 TRIP_SYNC_SETUP.md。
 *
 * 會讀取名稱是日期的分頁（例：11/21-22、12/12-13），第一個「表單回覆」分頁不會讀。
 * 每個分頁的報名資料會更新後台同一路線、同一出發日的梯次：
 *   報名人數、裝備租借、代揹服務（加購）、餐食需求（葷素、不吃、過敏）。
 * 只送出姓名和上述欄位；身分證、電話、地址等個資不會送出。
 */

// ── 每份試算表要改的設定 ──
const ROUTE_NAME = '合歡群峰';   // 要和後台「活動名稱」完全一樣
const SYNC_KEY = '貼上同步金鑰';  // 和 Supabase secret TRIP_SYNC_KEY 相同

const SYNC_URL = 'https://dygxochowbhmdftstgoz.supabase.co/functions/v1/trip-sync';

// 依表頭關鍵字找欄位（欄位順序變了也沒關係）
const COLUMNS = {
  name:    ['姓名'],
  equip:   ['租借'],
  porter:  ['代背', '代揹'],
  diet:    ['葷/素', '葷素'],
  avoid:   ['不能吃'],
  allergy: ['過敏'],
};

function syncTrips(dryRun) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tabs = [];
  ss.getSheets().forEach(function (sh) {
    const tab = sh.getName().trim();
    if (!/^\d{1,2}\s*[\/.]\s*\d{1,2}/.test(tab)) return;   // 只讀日期分頁
    const values = sh.getDataRange().getDisplayValues();
    if (!values.length) { tabs.push({ tab: tab, rows: [] }); return; }
    const header = values[0];
    const col = {};
    Object.keys(COLUMNS).forEach(function (k) {
      col[k] = header.findIndex(function (h) {
        return COLUMNS[k].some(function (kw) { return String(h).indexOf(kw) >= 0; });
      });
    });
    if (col.name < 0) return;   // 沒有姓名欄，不是報名名單
    const rows = values.slice(1)
      .filter(function (r) { return String(r[col.name]).trim(); })
      .map(function (r) {
        const o = {};
        Object.keys(col).forEach(function (k) { o[k] = col[k] >= 0 ? String(r[col[k]]) : ''; });
        return o;
      });
    tabs.push({ tab: tab, rows: rows });
  });

  const res = UrlFetchApp.fetch(SYNC_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-sync-key': SYNC_KEY },
    payload: JSON.stringify({ route: ROUTE_NAME, source: ss.getName(), tabs: tabs, dryRun: !!dryRun }),
    muteHttpExceptions: true,
  });
  Logger.log(res.getResponseCode() + ' ' + res.getContentText());
  if (res.getResponseCode() !== 200) throw new Error('同步失敗：' + res.getContentText());
  return JSON.parse(res.getContentText());
}

/** 先試跑：只看結果、不寫入後台 */
function testSync() { syncTrips(true); }

/** 立即同步一次 */
function runSync() { syncTrips(false); }

/** 執行一次就好：之後每 15 分鐘自動同步，另外有新的表單回覆時也會同步 */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runSync').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('runSync').forSpreadsheet(SpreadsheetApp.getActive()).onFormSubmit().create();
  runSync();
}

/** 試算表上方加一個「團務同步」選單，可以手動按 */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('團務同步')
    .addItem('立即同步到後台', 'runSync')
    .addToUi();
}
