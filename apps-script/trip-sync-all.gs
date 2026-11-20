/**
 * 入野門｜報名表 → 後台團務自動同步（集中版，只要裝一次）
 *
 * 到 https://script.google.com 建一個新專案，貼上這整份，設定步驟見 TRIP_SYNC_SETUP.md。
 *
 * 每天 07:50、18:00（台灣時間）自動執行：
 *   1. 找出報名資料夾裡所有「(回覆)」試算表（沒有回覆試算表的表單＝還沒有人報名，略過）
 *   2. 讀每份試算表的第一頁「表單回覆」，每一列依他選的「行程日期」分到後台對應的梯次
 *   3. 整列（或姓名）被刪除線槓掉的人＝取消，從該梯移除
 *   4. 更新後台：報名人數、裝備租借、代揹服務、餐食需求（已結束的梯次不更新）
 * 只送出填表時間、行程日期、姓名、租借、代揹、葷素、不吃、過敏；身分證、電話、地址等個資不會送出。
 */

const SYNC_KEY = '貼上同步金鑰';  // 和 Supabase secret TRIP_SYNC_KEY 相同

// 報名表單資料夾（多日付費活動（山））；要多同步其他資料夾，把 id 加進來
const FOLDER_IDS = ['1179tJGVgcX-lPaF5aXE6Am6sjIerW8Hr'];

// 暫時不同步的試算表（標題包含這些字就略過）；要開始同步就把它從清單刪掉
const SKIP = [];

const SYNC_URL = 'https://dygxochowbhmdftstgoz.supabase.co/functions/v1/trip-sync';

// 依表頭關鍵字找欄位（欄位順序變了也沒關係）
const COLUMNS = {
  ts:      ['時間戳記'],
  date:    ['行程日期'],
  name:    ['姓名'],
  equip:   ['租借'],
  porter:  ['代背', '代揹'],
  diet:    ['葷/素', '葷素'],
  avoid:   ['不能吃'],
  allergy: ['過敏'],
};

/** 讀第一頁「表單回覆」 */
function readResponses(ss) {
  const sh = ss.getSheets()[0];
  const range = sh.getDataRange();
  const values = range.getDisplayValues();
  const lines = range.getFontLines();   // 'line-through' = 刪除線
  // 表頭不一定在第一列：前 5 列裡找有「姓名」的那列
  const h = values.slice(0, 5).findIndex(function (r) {
    return r.some(function (c) { return String(c).indexOf('姓名') >= 0; });
  });
  if (h < 0) return [];
  const col = {};
  Object.keys(COLUMNS).forEach(function (k) {
    col[k] = values[h].findIndex(function (cell) {
      return COLUMNS[k].some(function (kw) { return String(cell).indexOf(kw) >= 0; });
    });
  });
  if (col.name < 0) return [];
  const rows = [];
  for (let i = h + 1; i < values.length; i++) {
    const r = values[i];
    if (!String(r[col.name]).trim()) continue;
    // 姓名被槓掉，或一半以上有內容的格子被槓掉 → 取消
    let filled = 0, struck = 0;
    r.forEach(function (c, j) { if (String(c).trim()) { filled++; if (lines[i][j] === 'line-through') struck++; } });
    const o = { struck: lines[i][col.name] === 'line-through' || (filled > 0 && struck * 2 >= filled) };
    Object.keys(col).forEach(function (k) { o[k] = col[k] >= 0 ? String(r[col[k]]) : (k === 'diet' ? null : ''); });
    rows.push(o);
  }
  return rows;
}

/** 資料夾裡所有回覆試算表（名稱有 ❌ 的停用表單不讀） */
function responseSheets() {
  const out = [];
  FOLDER_IDS.forEach(function (fid) {
    const it = DriveApp.getFolderById(fid).getFilesByType(MimeType.GOOGLE_SHEETS);
    while (it.hasNext()) {
      const f = it.next();
      const name = f.getName();
      if (name.indexOf('回覆') < 0 || name.indexOf('❌') >= 0) continue;
      if (SKIP.some(function (w) { return name.indexOf(w) >= 0; })) continue;
      out.push(f);
    }
  });
  return out;
}

function syncAll(dryRun) {
  responseSheets().forEach(function (f) {
    try {
      const ss = SpreadsheetApp.openById(f.getId());
      const res = UrlFetchApp.fetch(SYNC_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-sync-key': SYNC_KEY },
        payload: JSON.stringify({ source: ss.getName(), rows: readResponses(ss), dryRun: !!dryRun }),
        muteHttpExceptions: true,
      });
      Logger.log('【' + ss.getName() + '】' + res.getResponseCode() + ' ' + res.getContentText());
    } catch (e) {
      Logger.log('【' + f.getName() + '】讀取失敗：' + e);   // 一份失敗不影響其他份
    }
  });
}

/** 先試跑：只看結果、不寫入後台 */
function testSync() { syncAll(true); }

/** 立即同步一次 */
function runSync() { syncAll(false); }

/** 執行一次就好：之後每天 07:50、18:00（台灣時間）自動同步 */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runSync').timeBased().everyDays(1).atHour(7).nearMinute(50).inTimezone('Asia/Taipei').create();
  ScriptApp.newTrigger('runSync').timeBased().everyDays(1).atHour(18).nearMinute(0).inTimezone('Asia/Taipei').create();
  runSync();
}
