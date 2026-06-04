/* ============================================================
   Document Control System — Google Apps Script backend
   - Serves the data-entry web app (Index.html) at the web-app URL
   - Reads/writes the existing Google Sheet (no Cloudflare / D1)
   Deploy: Extensions ▸ Apps Script ▸ Deploy ▸ New deployment ▸ Web app
   ============================================================ */

// The spreadsheet that stores the data. Leaving the ID set makes the script
// work whether it is container-bound to the sheet OR a standalone project.
var SPREADSHEET_ID = '1gb0bv6mDKJWsYR9-vRqZUHfeclnSVe5Cb5XXtDGrB1E';

// Helper column appended to each tab so rows can be edited/deleted reliably.
var ID_COL = 'id';

// Each logical sheet is detected by the columns present in its header row,
// so the actual tab names in the spreadsheet don't matter.
var SHEETS = {
  mdl:      { signature: ['DocCode', 'DocName'],   sort: { col: 'DocCode',   dir: 'asc'  } },
  approval: { signature: ['RequestId', 'DocCode'], sort: { col: 'Timestamp', dir: 'desc' } },
  ack:      { signature: ['EmployeeName'],         sort: { col: 'Timestamp', dir: 'desc' } },
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('ระบบควบคุมเอกสาร · Document Control System')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function ss_() {
  return SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}

function cfg_(key) {
  var c = SHEETS[key];
  if (!c) throw new Error('unknown sheet: ' + key);
  return c;
}

// Find the tab whose header row contains all of the signature columns.
function findSheet_(key) {
  var c = cfg_(key);
  var sheets = ss_().getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    if (sh.getLastColumn() < 1) continue;
    var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
      .map(function (h) { return String(h).trim(); });
    var ok = c.signature.every(function (col) { return header.indexOf(col) >= 0; });
    if (ok) return sh;
  }
  throw new Error('ไม่พบแท็บสำหรับ "' + key + '" (ต้องมีคอลัมน์: ' + c.signature.join(', ') + ')');
}

// Returns { sheet, header[], map{name->index}, idIdx } and guarantees an id column.
function bind_(key) {
  var sh = findSheet_(key);
  var lastCol = sh.getLastColumn();
  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var idIdx = header.indexOf(ID_COL);
  if (idIdx < 0) {
    idIdx = header.length;            // append a new "id" column at the end
    sh.getRange(1, idIdx + 1).setValue(ID_COL);
    header.push(ID_COL);
  }
  var map = {};
  header.forEach(function (h, i) { if (h !== '') map[h] = i; });
  return { sheet: sh, header: header, map: map, idIdx: idIdx };
}

// Backfill UUIDs for any existing rows that don't have one yet.
function ensureIds_(b) {
  var sh = b.sheet, last = sh.getLastRow();
  if (last < 2) return;
  var rng = sh.getRange(2, b.idIdx + 1, last - 1, 1);
  var ids = rng.getValues();
  var changed = false;
  for (var i = 0; i < ids.length; i++) {
    if (!ids[i][0]) { ids[i][0] = Utilities.getUuid(); changed = true; }
  }
  if (changed) rng.setValues(ids);
}

function rowToObj_(b, row) {
  var o = {};
  b.header.forEach(function (h, i) { if (h !== '') o[h] = (row[i] === '' ? null : row[i]); });
  return o;
}

function findRowById_(b, id) {
  var sh = b.sheet, last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, b.idIdx + 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

function readOne_(b, id) {
  var r = findRowById_(b, id);
  if (r < 0) return { id: id };
  var row = b.sheet.getRange(r, 1, 1, b.header.length).getValues()[0];
  return rowToObj_(b, row);
}

// ---- API called from the client via google.script.run ----

function apiList(key) {
  var c = cfg_(key);
  var b = bind_(key);
  ensureIds_(b);
  var last = b.sheet.getLastRow();
  if (last < 2) return [];
  var values = b.sheet.getRange(2, 1, last - 1, b.header.length).getValues();
  var out = values
    .map(function (row) { return rowToObj_(b, row); })
    .filter(function (o) { return o[ID_COL]; });
  var s = c.sort;
  if (s && b.map.hasOwnProperty(s.col)) {
    out.sort(function (a, x) {
      var av = a[s.col] == null ? '' : a[s.col];
      var bv = x[s.col] == null ? '' : x[s.col];
      av = (av instanceof Date) ? av.getTime() : String(av);
      bv = (bv instanceof Date) ? bv.getTime() : String(bv);
      if (av < bv) return s.dir === 'asc' ? -1 : 1;
      if (av > bv) return s.dir === 'asc' ? 1 : -1;
      return 0;
    });
  }
  return out;
}

function buildRow_(b, obj) {
  var row = [];
  for (var i = 0; i < b.header.length; i++) row.push('');
  b.header.forEach(function (h, i) {
    if (obj.hasOwnProperty(h) && obj[h] != null) row[i] = obj[h];
  });
  return row;
}

function apiCreate(key, body) {
  var b = bind_(key);
  body = body || {};
  var id = body.id || Utilities.getUuid();
  var obj = {};
  b.header.forEach(function (h) { if (body.hasOwnProperty(h)) obj[h] = body[h]; });
  obj[ID_COL] = id;
  b.sheet.appendRow(buildRow_(b, obj));
  return readOne_(b, id);
}

function apiUpdate(key, id, body) {
  var b = bind_(key);
  var r = findRowById_(b, id);
  if (r < 0) throw new Error('not found: ' + id);
  body = body || {};
  b.header.forEach(function (h, i) {
    if (h === ID_COL) return;
    if (body.hasOwnProperty(h)) b.sheet.getRange(r, i + 1).setValue(body[h] == null ? '' : body[h]);
  });
  return readOne_(b, id);
}

function apiDelete(key, id) {
  var b = bind_(key);
  var r = findRowById_(b, id);
  if (r > 0) b.sheet.deleteRow(r);
  return { ok: true, id: id };
}

// Bulk upsert: rows matching upsertKey are updated, the rest inserted.
function apiBulk(key, rows, upsertKey) {
  var b = bind_(key);
  ensureIds_(b);
  rows = rows || [];
  var useKey = (upsertKey && b.map.hasOwnProperty(upsertKey)) ? upsertKey : null;

  var existing = {};
  if (useKey) {
    var last = b.sheet.getLastRow();
    if (last >= 2) {
      var data = b.sheet.getRange(2, 1, last - 1, b.header.length).getValues();
      var keyIdx = b.map[useKey];
      data.forEach(function (row, i) {
        var kv = row[keyIdx];
        if (kv !== '' && kv != null) existing[String(kv)] = i + 2;
      });
    }
  }

  var inserted = 0, updated = 0, toAppend = [];
  rows.forEach(function (body) {
    var present = b.header.filter(function (h) { return h !== ID_COL && body.hasOwnProperty(h); });
    if (!present.length) return;
    var kv = useKey ? body[useKey] : null;
    var foundRow = (useKey && kv != null) ? existing[String(kv)] : null;
    if (foundRow) {
      present.forEach(function (h) {
        b.sheet.getRange(foundRow, b.map[h] + 1).setValue(body[h] == null ? '' : body[h]);
      });
      updated++;
    } else {
      var obj = {};
      present.forEach(function (h) { obj[h] = body[h]; });
      obj[ID_COL] = Utilities.getUuid();
      toAppend.push(buildRow_(b, obj));
      inserted++;
    }
  });
  if (toAppend.length) {
    var start = b.sheet.getLastRow() + 1;
    b.sheet.getRange(start, 1, toAppend.length, b.header.length).setValues(toAppend);
  }
  return { inserted: inserted, updated: updated, total: inserted + updated };
}
