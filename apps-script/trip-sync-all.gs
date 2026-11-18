/**
 * 入野門｜所有報名表 → 後台團務自動同步（集中版，只要裝一次）
 *
 * 到 https://script.google.com 建一個新專案，貼上這整份，設定步驟見 TRIP_SYNC_SETUP.md。
 * 每 15 分鐘依序讀取下面清單裡的每份報名回覆試算表，把「名稱裡有日期的分頁」
 * 同步到後台同一路線、同一出發日的梯次：報名人數、裝備租借、代揹服務、餐食需求。
 * 已經結束的梯次不會更新；只送出姓名和上述欄位，身分證、電話、地址等個資不會送出。
 */

const SYNC_KEY = '貼上同步金鑰';  // 和 Supabase secret TRIP_SYNC_KEY 相同

// ── 要同步的試算表：網址裡 /d/ 和 /edit 中間那段是 id；route 要和後台「活動名稱」完全一樣 ──
const SHEETS = [
  { route: '合歡群峰', id: '1k960isaQo7hNys3BCsgCxYhKMoJsw52nrT_F0QecZWc' },
  { route: '眠月線',   id: '17zmassOYxTRmWYMW6zBaeIH2ykYC1Tl-rbJX9MxYh6k' },
  { route: '加里山',   id: '1-3zPioCE_Qx1MMiMsNbgMxqJtLjvKiMZsICe2lYPfvI' },
  { route: '高島縱走', id: '1b_7F4E92Kgk0k_KiscGh8ucVWuxUdZMCbtyFvoaAmzE' },
  { route: '水漾森林', id: '1nruh2dEH0Zj6R__V8dEwDPIrj4mKS80gfuGAA4pr0bQ' },
  { route: '奇萊南華', id: '1bgGzrf6VMpANqod1qtnutcQiXDdRAn9tBefKWxFUs5s' },
];

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

function readTabs(ss) {
  const tabs = [];
  ss.getSheets().forEach(function (sh) {
    const tab = sh.getName().trim();
    if (/回覆/.test(tab) || !/\d{1,2}\s*[\/.]\s*\d{1,2}/.test(tab)) return;   // 只讀日期分頁
    const values = sh.getDataRange().getDisplayValues();
    // 表頭不一定在第一列：前 5 列裡找有「姓名」的那列
    const h = values.slice(0, 5).findIndex(function (r) {
      return r.some(function (c) { return String(c).indexOf('姓名') >= 0; });
    });
    if (h < 0) {
      if (values.filter(function (r) { return r.join('').trim(); }).length <= 1) tabs.push({ tab: tab, rows: [] });
      return;
    }
    const header = values[h];
    const col = {};
    Object.keys(COLUMNS).forEach(function (k) {
      col[k] = header.findIndex(function (cell) {
        return COLUMNS[k].some(function (kw) { return String(cell).indexOf(kw) >= 0; });
      });
    });
    const rows = values.slice(h + 1)
      .filter(function (r) { return String(r[col.name]).trim(); })
      .map(function (r) {
        const o = {};
        Object.keys(col).forEach(function (k) { o[k] = col[k] >= 0 ? String(r[col[k]]) : (k === 'diet' ? null : ''); });
        return o;
      });
    tabs.push({ tab: tab, rows: rows });
  });
  return tabs;
}

function syncAll(dryRun) {
  SHEETS.forEach(function (s) {
    try {
      const ss = SpreadsheetApp.openById(s.id);
      const res = UrlFetchApp.fetch(SYNC_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-sync-key': SYNC_KEY },
        payload: JSON.stringify({ route: s.route, source: ss.getName(), tabs: readTabs(ss), dryRun: !!dryRun }),
        muteHttpExceptions: true,
      });
      Logger.log('【' + s.route + '】' + res.getResponseCode() + ' ' + res.getContentText());
    } catch (e) {
      Logger.log('【' + s.route + '】讀取失敗：' + e);   // 一份失敗不影響其他份
    }
  });
}

/** 先試跑：只看結果、不寫入後台 */
function testSync() { syncAll(true); }

/** 立即同步一次 */
function runSync() { syncAll(false); }

/** 執行一次就好：之後每 15 分鐘自動同步全部試算表 */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runSync').timeBased().everyMinutes(15).create();
  runSync();
}
