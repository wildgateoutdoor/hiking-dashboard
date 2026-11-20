"""讀報名回覆試算表（xlsx 匯出檔）第一頁「表單回覆」→ JSON（和 Apps Script readResponses 相同欄位）。

用法：python3 -I readxl.py <manifest.json> > sheets.json
manifest.json：[{"title": "試算表標題", "id": "Drive 檔案 id", "file": "下載的 xlsx 路徑"}, ...]
輸出：[{"title", "url", "rows": [{ts, tripDate, date, name, equip, porter, diet, avoid, allergy, start, struck}]}]
只輸出同步需要的欄位；身分證、電話、地址等個資不讀。
"""
import json, sys
import openpyxl

COLS = {
    'ts': ['時間戳記'],
    'tripDate': ['出團日期'],          # 有填就以出團日期為準（換梯）
    'date': ['行程日期'],
    'name': ['姓名'],
    'equip': ['租借'],
    'porter': ['代背', '代揹'],
    'diet': ['葷/素', '葷素'],
    'avoid': ['不能吃'],
    'allergy': ['過敏'],
    'start': ['行程費用', '出發地點', '上車地點'],
}


def read(path):
    ws = openpyxl.load_workbook(path).worksheets[0]
    rows = list(ws.iter_rows())
    h = next((i for i, r in enumerate(rows[:5]) if any('姓名' in str(c.value or '') for c in r)), None)
    if h is None:
        return []
    hdr = [str(c.value or '') for c in rows[h]]
    col = {k: next((i for i, x in enumerate(hdr) if any(kw in x for kw in v)), -1) for k, v in COLS.items()}
    date_cols = [i for i, x in enumerate(hdr) if '行程日期' in x]   # 富士山這類有好幾欄行程日期
    out = []
    for r in rows[h + 1:]:
        if col['name'] < 0 or col['name'] >= len(r):
            continue
        name = r[col['name']]
        if not str(name.value or '').strip():
            continue
        cells = [c for c in r if c.value not in (None, '')]
        struck_n = sum(1 for c in cells if c.font and c.font.strike)
        o = {}
        for k, i in col.items():
            v = r[i].value if 0 <= i < len(r) else None
            o[k] = None if (k == 'diet' and i < 0) else ('' if v is None else str(v))
        for j in date_cols:
            if j < len(r) and r[j].value not in (None, ''):
                o['date'] = str(r[j].value)
                break
        o['struck'] = bool(name.font and name.font.strike) or (len(cells) > 0 and struck_n * 2 >= len(cells))
        out.append(o)
    return out


manifest = json.load(open(sys.argv[1]))
print(json.dumps([{'title': m['title'], 'url': f"https://docs.google.com/spreadsheets/d/{m['id']}/edit",
                   'rows': read(m['file'])} for m in manifest], ensure_ascii=False))
