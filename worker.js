/* ============================================================
   Document Control System — Cloudflare Worker (D1-backed)
   - Serves a mobile-first single-page app at "/"
   - JSON API under "/api/*" backed by the D1 database (env.DB)
   Tables: mdl, approval_log, ack_log  (see schema.sql)
   Deploy: GitHub Action (wrangler) or `wrangler deploy`
   ============================================================ */

// Columns the client is allowed to write, per table.
const MDL_COLS = ['DocCode','DocType','DocName','Department','OwnerName','OwnerEmail',
  'ApproverName','ApproverEmail','Rev','Status','IssueDate','EffectiveDate','NextReviewDate',
  'Keyword','FileLink','Notes'];
const REQ_COLS = ['Timestamp','RequestId','DocCode','ActionType','DocType','DocName','Department',
  'RequestedRev','RequesterName','RequesterEmail','ApproverName','ApproverEmail','DraftFileLink',
  'ExpectedDate','Reason','Decision','DecisionBy','DecisionTime','Comment'];
const DIST_COLS = ['Timestamp','DocCode','DocName','Rev','HolderName','Department','CopyNo',
  'CopyType','IssuedDate','ReturnedDate','Status','Notes'];

// --- Email notification (via a Google Apps Script "mailer" web app) ---
// Aligned to QP-DC-01: notify the document controller / approver on every
// new request. Configurable via Worker vars; falls back to these constants.
const NOTIFY_DEFAULT = 'qa.sorworaphat@gmail.com';
const MAILER_URL_DEFAULT = 'https://script.google.com/macros/s/AKfycbyRCJ223DKomrx8wfUiWwcDK1R-wRfvYONVKWwmvKLLcd7Leiy6GVFXehpnQG9dttZoVQ/exec';   // Apps Script mailer web-app
const MAILER_TOKEN_DEFAULT = 'a4f9c1e8d7b6403a9f2c5e1d8b7a6c3f';

// Password for the admin app (/). Override via Worker var ADMIN_KEY (recommended).
const ADMIN_KEY_DEFAULT = 'Swifoods@2026';

async function notifyNewRequest(env, r, origin) {
  const url = env.MAILER_URL || MAILER_URL_DEFAULT;
  if (!url) return;                          // mailer not configured yet — skip silently
  const token = env.MAILER_TOKEN || MAILER_TOKEN_DEFAULT;
  const to = env.NOTIFY_EMAIL || NOTIFY_DEFAULT;
  const e = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  const tr = function (k, v) { return '<tr><td style="padding:6px 10px;color:#6b7280;border:1px solid #eee">' + k + '</td><td style="padding:6px 10px;border:1px solid #eee">' + e(v || '-') + '</td></tr>'; };
  const subject = '[DCC] คำร้อง ' + (r.ActionType || '') + ' ' + (r.DocCode || '') + ' — รอพิจารณา';
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:620px">' +
    '<h2 style="color:#15803d;margin:0 0 4px">📄 มีคำร้องควบคุมเอกสารใหม่</h2>' +
    '<p style="color:#6b7280;margin:0 0 14px;font-size:13px">ตามระเบียบปฏิบัติ <b>QP-DC-01 การควบคุมเอกสาร</b> · ใบขอดำเนินการด้านเอกสาร (DAR / FM-MR-01)<br>ขั้นตอนอนุมัติ: ผู้จัดทำ (Owner) → หัวหน้าแผนก / ตัวแทนฝ่ายบริหาร (MR) → กรรมการผู้จัดการ (MD)</p>' +
    '<table style="border-collapse:collapse;width:100%;font-size:14px">' +
      tr('เลขคำร้อง', r.RequestId) + tr('ประเภทคำขอ', r.ActionType) + tr('ประเภทเอกสาร', r.DocType) +
      tr('รหัสเอกสาร', r.DocCode) + tr('ชื่อเอกสาร', r.DocName) + tr('แผนก', r.Department) +
      tr('ผู้ขอ', r.RequesterName) + tr('เหตุผล', r.Reason) +
      (r.ExpectedDate ? tr('วันที่คาดว่าจะเสร็จ', r.ExpectedDate) : '') +
      tr('สถานะ', r.Decision) + tr('เวลา', r.Timestamp) +
      (r.DraftFileLink ? tr('ไฟล์ร่าง', r.DraftFileLink) : '') +
    '</table>' +
    (origin ? '<p style="margin:16px 0"><a href="' + origin + '" style="background:#15803d;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">เปิดระบบ DCC เพื่อพิจารณา</a></p>' : '') +
    '<p style="color:#9ca3af;font-size:12px">อีเมลนี้ส่งอัตโนมัติจากระบบควบคุมเอกสาร (Document Control Center)</p>' +
    '</div>';
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token, to: to, subject: subject, html: html }) });
  } catch (err) { /* never block the request because email failed */ }
}

const J = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };
function json(data, status) { return new Response(JSON.stringify(data), { status: status || 200, headers: J }); }
function now() { return new Date().toISOString(); }
function uuid() { return crypto.randomUUID(); }
function reqId() {
  const d = new Date();
  const y = '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  return 'REQ-' + y + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

// Keep only whitelisted, defined keys.
function pick(body, cols) {
  const o = {};
  cols.forEach(function (k) { if (body[k] !== undefined && body[k] !== null) o[k] = body[k]; });
  return o;
}

async function insertRow(db, table, obj) {
  const id = obj.id || uuid();
  delete obj.id;
  const keys = Object.keys(obj);
  const cols = ['id'].concat(keys, ['updated_at']);
  const marks = cols.map(function () { return '?'; }).join(',');
  const vals = [id].concat(keys.map(function (k) { return obj[k]; }), [now()]);
  await db.prepare('INSERT INTO ' + table + ' (' + cols.join(',') + ') VALUES (' + marks + ')').bind(...vals).run();
  return id;
}

async function updateRow(db, table, id, obj) {
  delete obj.id;
  const keys = Object.keys(obj);
  if (!keys.length) return;
  const sets = keys.map(function (k) { return k + '=?'; }).concat(['updated_at=?']).join(',');
  const vals = keys.map(function (k) { return obj[k]; }).concat([now(), id]);
  await db.prepare('UPDATE ' + table + ' SET ' + sets + ' WHERE id=?').bind(...vals).run();
}

// Compute the next running document code (AA-BB-NN) per QP-DC-01, scanning
// both the master list and existing requests so numbers never collide.
async function nextDocCode(db, type, dept) {
  type = String(type || '').toUpperCase().replace(/[^A-Z]/g, '');
  dept = String(dept || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!type || !dept) return null;
  const prefix = type + '-' + dept + '-';
  let max = 0;
  const scan = function (rows) {
    (rows.results || []).forEach(function (x) {
      const m = String(x.DocCode || '').slice(prefix.length).match(/^(\d+)/);
      if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
    });
  };
  scan(await db.prepare('SELECT DocCode FROM mdl WHERE DocCode LIKE ?').bind(prefix + '%').all());
  scan(await db.prepare('SELECT DocCode FROM approval_log WHERE DocCode LIKE ?').bind(prefix + '%').all());
  return prefix + String(max + 1).padStart(2, '0');
}

// When a request is APPROVED, keep the master list (FM-MR-02) in sync:
//   new doc  -> register as Active (Rev 00, review +1yr)
//   cancel   -> mark the matching document Obsolete
async function syncMdlFromRequest(db, r) {
  if (!r || !r.DocCode) return;
  const existing = await db.prepare('SELECT id FROM mdl WHERE DocCode=?').bind(r.DocCode).first();
  if (/ยกเลิก/.test(r.ActionType || '')) {
    if (existing) await db.prepare("UPDATE mdl SET Status='Obsolete', updated_at=? WHERE id=?").bind(now(), existing.id).run();
    return;
  }
  if (existing) return;   // already registered (e.g. revision) — leave it to DCC
  const today = new Date().toISOString().slice(0, 10);
  const review = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  await insertRow(db, 'mdl', {
    DocCode: r.DocCode, DocType: r.DocType, DocName: r.DocName, Department: r.Department,
    OwnerName: r.RequesterName, Rev: '00', Status: 'Active', EffectiveDate: today,
    NextReviewDate: review, FileLink: r.DraftFileLink,
    Notes: 'ขึ้นทะเบียนอัตโนมัติจากคำร้อง ' + (r.RequestId || ''),
  });
}

// Email the requester the outcome (only when they provided an email).
async function notifyDecision(env, r, origin) {
  const url = env.MAILER_URL || MAILER_URL_DEFAULT;
  const to = r && r.RequesterEmail;
  if (!url || !to) return;
  const token = env.MAILER_TOKEN || MAILER_TOKEN_DEFAULT;
  const ok = r.Decision === 'APPROVED';
  const e = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  const subject = '[DCC] ผลคำร้อง ' + (r.DocCode || '') + ' — ' + (ok ? 'อนุมัติ' : 'ไม่อนุมัติ');
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:620px">' +
    '<h2 style="color:' + (ok ? '#15803d' : '#c62f2f') + '">' + (ok ? '✅ คำร้องได้รับการอนุมัติ' : '❌ คำร้องไม่ได้รับการอนุมัติ') + '</h2>' +
    '<p style="font-size:13px;color:#6b7280">ตามระเบียบปฏิบัติ QP-DC-01 · DAR (FM-MR-01)</p>' +
    '<p>เรียน คุณ' + e(r.RequesterName || '') + '</p>' +
    '<p>คำร้อง <b>' + e(r.RequestId || '') + '</b> เอกสาร <b>' + e(r.DocCode || '') + ' ' + e(r.DocName || '') + '</b> ' +
    (ok ? 'ได้รับการอนุมัติแล้ว และถูกขึ้นทะเบียนในบัญชีแม่บท (MDL)' : 'ไม่ได้รับการอนุมัติ') + '</p>' +
    (r.DecisionBy ? '<p>ผู้ตัดสิน: ' + e(r.DecisionBy) + '</p>' : '') +
    (r.Comment ? '<p>ความเห็น: ' + e(r.Comment) + '</p>' : '') +
    (origin ? '<p style="margin-top:14px"><a href="' + origin + '" style="background:#15803d;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none">เปิดระบบ DCC</a></p>' : '') +
    '</div>';
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token, to: to, subject: subject, html: html }) });
  } catch (err) { /* ignore */ }
}

async function api(request, env, url, ctx) {
  const db = env.DB;
  const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean); // [resource, id?]
  const resource = seg[0];
  const id = seg[1];
  const method = request.method;
  let body = {};
  if (method === 'POST' || method === 'PUT') { try { body = await request.json(); } catch (e) { body = {}; } }

  if (resource === 'stats') {
    const c = async function (sql) { const r = await db.prepare(sql).first(); return (r && r.c) || 0; };
    const mdlTotal = await c('SELECT COUNT(*) c FROM mdl');
    const pending = await c("SELECT COUNT(*) c FROM approval_log WHERE Decision='PENDING'");
    const approved = await c("SELECT COUNT(*) c FROM approval_log WHERE Decision='APPROVED'");
    const rejected = await c("SELECT COUNT(*) c FROM approval_log WHERE Decision='REJECTED'");
    const recent = await db.prepare('SELECT * FROM approval_log ORDER BY Timestamp DESC LIMIT 6').all();
    return json({ mdlTotal: mdlTotal, pending: pending, approved: approved, rejected: rejected, recent: recent.results || [] });
  }

  if (resource === 'nextcode') {
    const code = await nextDocCode(db, url.searchParams.get('type'), url.searchParams.get('dept'));
    if (!code) return json({ error: 'type & dept required' }, 400);
    return json({ code: code });
  }

  const table = resource === 'mdl' ? 'mdl' : resource === 'requests' ? 'approval_log' : resource === 'dist' ? 'dist_log' : null;
  const cols = table === 'mdl' ? MDL_COLS : table === 'dist_log' ? DIST_COLS : REQ_COLS;
  if (!table) return json({ error: 'not found' }, 404);

  if (method === 'GET') {
    const order = table === 'mdl' ? 'DocCode ASC' : 'Timestamp DESC';
    const rows = await db.prepare('SELECT * FROM ' + table + ' ORDER BY ' + order).all();
    return json(rows.results || []);
  }
  if (method === 'POST') {
    const obj = pick(body, cols);
    if (table === 'approval_log') {
      if (!obj.RequestId) obj.RequestId = reqId();
      if (!obj.Timestamp) obj.Timestamp = now();
      if (!obj.Decision) obj.Decision = 'PENDING';
    }
    if (table === 'dist_log') {
      if (!obj.Timestamp) obj.Timestamp = now();
      if (!obj.Status) obj.Status = 'Issued';
    }
    const newId = await insertRow(db, table, obj);
    const row = await db.prepare('SELECT * FROM ' + table + ' WHERE id=?').bind(newId).first();
    if (table === 'approval_log' && ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(notifyNewRequest(env, row, url.origin));
    }
    return json(row, 201);
  }
  if (method === 'PUT') {
    if (!id) return json({ error: 'id required' }, 400);
    await updateRow(db, table, id, pick(body, cols));
    const row = await db.prepare('SELECT * FROM ' + table + ' WHERE id=?').bind(id).first();
    if (table === 'approval_log' && row) {
      if (row.Decision === 'APPROVED') await syncMdlFromRequest(db, row);   // register/obsolete in MDL
      if ((row.Decision === 'APPROVED' || row.Decision === 'REJECTED') && ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(notifyDecision(env, row, url.origin));               // email the requester
      }
    }
    return json(row);
  }
  if (method === 'DELETE') {
    if (!id) return json({ error: 'id required' }, 400);
    await db.prepare('DELETE FROM ' + table + ' WHERE id=?').bind(id).run();
    return json({ ok: true, id: id });
  }
  return json({ error: 'method not allowed' }, 405);
}

// Store an uploaded file in R2 and return a URL to retrieve it.
async function uploadHandler(request, env, url) {
  if (!env.FILES) return json({ error: 'storage not configured (R2 binding FILES missing)' }, 500);
  var raw = url.searchParams.get('name') || 'file';
  var safe = raw.replace(/[^A-Za-z0-9._\-]+/g, '_').replace(/^_+/, '');
  if (safe.length > 80) safe = safe.slice(-80);
  if (!safe) safe = 'file';
  var key = 'uploads/' + uuid() + '-' + safe;
  var ct = request.headers.get('content-type') || 'application/octet-stream';
  await env.FILES.put(key, request.body, { httpMetadata: { contentType: ct } });
  return json({ url: '/files/' + key, name: raw });
}

// Serve a previously uploaded file from R2.
async function serveFile(env, url) {
  if (!env.FILES) return new Response('storage not configured', { status: 500 });
  var key = decodeURIComponent(url.pathname.replace(/^\/files\//, ''));
  var obj = await env.FILES.get(key);
  if (!obj) return new Response('not found', { status: 404 });
  var h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('etag', obj.httpEtag);
  h.set('cache-control', 'private, max-age=3600');
  return new Response(obj.body, { headers: h });
}

// Printable DAR form (FM-MR-01) for a single request.
function darHtml(r) {
  var e = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var d = function (v) { if (!v) return '......./......./.......'; var t = String(v); return t.length >= 10 ? t.slice(0, 10) : t; };
  var status = r.Decision === 'APPROVED' ? 'อนุมัติ (APPROVED)' : r.Decision === 'REJECTED' ? 'ไม่อนุมัติ (REJECTED)' : 'รอพิจารณา (PENDING)';
  var chk = function (label, on) { return '<span style="border:1.3px solid #333;display:inline-block;width:13px;height:13px;text-align:center;line-height:12px;margin-right:5px">' + (on ? '✓' : '') + '</span>' + label; };
  var act = r.ActionType || '';
  return '<!doctype html><html lang="th"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>DAR ' + e(r.RequestId || '') + '</title>' +
    "<style>@import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap');" +
    '@page{size:A4;margin:16mm}*{box-sizing:border-box}' +
    "body{font-family:'Sarabun',sans-serif;color:#1a1a1a;font-size:14px;line-height:1.5;margin:0;padding:24px;background:#f4f4f4}" +
    '.sheet{background:#fff;max-width:780px;margin:0 auto;padding:30px 34px;box-shadow:0 1px 8px rgba(0,0,0,.12)}' +
    '.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2.5px solid #111;padding-bottom:10px}' +
    '.hd .co{font-size:17px;font-weight:700}.hd .co small{display:block;font-size:11px;font-weight:400;color:#555;letter-spacing:.5px}' +
    '.hd .ttl{text-align:right}.hd .ttl b{font-size:16px}.hd .ttl small{display:block;font-size:11px;color:#555}' +
    '.meta{width:100%;border-collapse:collapse;margin:12px 0 4px;font-size:12.5px}' +
    '.meta td{border:1px solid #bbb;padding:5px 8px}.meta .k{background:#eef3f0;font-weight:600;width:130px}' +
    'h3{font-size:13.5px;margin:18px 0 6px;padding:5px 9px;background:#15803d;color:#fff;border-radius:4px}' +
    'table.f{width:100%;border-collapse:collapse;font-size:13px}table.f td{border:1px solid #bbb;padding:7px 9px;vertical-align:top}' +
    'table.f .k{background:#f3f6f4;font-weight:600;width:150px}' +
    '.sign{display:flex;gap:14px;margin-top:30px}.sign .b{flex:1;text-align:center;font-size:12.5px}' +
    '.sign .ln{margin:34px 14px 6px;border-top:1px dotted #555}' +
    '.print{position:fixed;top:14px;right:14px;background:#15803d;color:#fff;border:none;padding:10px 18px;border-radius:8px;font:inherit;font-weight:600;cursor:pointer}' +
    '@media print{body{background:#fff;padding:0}.sheet{box-shadow:none;max-width:none}.print{display:none}}' +
    '</style></head><body>' +
    '<button class="print" onclick="window.print()">🖨️ พิมพ์</button>' +
    '<div class="sheet">' +
    '<div class="hd"><div class="co">บริษัท ศ.วรภัทร อินเตอร์ ฟู้ดส์ จำกัด<small>S.WORAPHAT INTER FOODS CO., LTD.</small></div>' +
      '<div class="ttl"><b>ใบขอดำเนินการด้านเอกสาร</b><small>Document Action Request (DAR) · FM-MR-01</small></div></div>' +
    '<table class="meta"><tr><td class="k">เลขที่คำร้อง</td><td>' + e(r.RequestId || '-') + '</td><td class="k">วันที่ยื่น</td><td>' + d(r.Timestamp) + '</td></tr>' +
      '<tr><td class="k">อ้างอิงระเบียบ</td><td>QP-DC-01</td><td class="k">สถานะ</td><td>' + status + '</td></tr></table>' +
    '<h3>1. ประเภทการดำเนินการ</h3>' +
    '<div style="padding:6px 4px">' + chk('จัดทำใหม่', /จัดทำ/.test(act)) + ' &nbsp; ' + chk('ปรับปรุง/แก้ไข', /ปรับปรุง|แก้ไข/.test(act)) + ' &nbsp; ' + chk('ยกเลิก', /ยกเลิก/.test(act)) + ' &nbsp; ' + chk('ขอสำเนา/ขอใช้', /สำเนา|ขอใช้/.test(act)) + '</div>' +
    '<h3>2. รายละเอียดเอกสาร</h3>' +
    '<table class="f">' +
      '<tr><td class="k">รหัสเอกสาร</td><td>' + e(r.DocCode || '-') + '</td><td class="k">ประเภท</td><td>' + e(r.DocType || '-') + '</td></tr>' +
      '<tr><td class="k">ชื่อเอกสาร</td><td colspan="3">' + e(r.DocName || '-') + '</td></tr>' +
      '<tr><td class="k">แผนก</td><td>' + e(r.Department || '-') + '</td><td class="k">วันคาดว่าจะเสร็จ</td><td>' + d(r.ExpectedDate) + '</td></tr>' +
      '<tr><td class="k">เหตุผล</td><td colspan="3">' + e(r.Reason || '-') + '</td></tr>' +
      (r.DraftFileLink ? '<tr><td class="k">ไฟล์ฉบับร่าง</td><td colspan="3">' + e(r.DraftFileLink) + '</td></tr>' : '') +
    '</table>' +
    '<h3>3. ผลการพิจารณา</h3>' +
    '<table class="f"><tr><td class="k">ผลการพิจารณา</td><td>' + status + '</td><td class="k">ผู้ตัดสิน</td><td>' + e(r.DecisionBy || '-') + '</td></tr>' +
      '<tr><td class="k">ความเห็น</td><td colspan="3">' + e(r.Comment || '-') + '</td></tr></table>' +
    '<div class="sign">' +
      '<div class="b"><div class="ln"></div>(' + e(r.RequesterName || '..................') + ')<br>ผู้จัดทำ / ผู้ขอ<br>วันที่ ' + d(r.Timestamp) + '</div>' +
      '<div class="b"><div class="ln"></div>(..................)<br>ผู้ทบทวน (หัวหน้าแผนก/MR)<br>วันที่ ......./......./.......</div>' +
      '<div class="b"><div class="ln"></div>(' + e(r.ApproverName || '..................') + ')<br>ผู้อนุมัติ (MD)<br>วันที่ ' + d(r.DecisionTime) + '</div>' +
    '</div></div>' +
    '<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},450);});<\/script>' +
    '</body></html>';
}

// Printable control stamps (ต้นฉบับ / สำเนาควบคุม / เอกสารไม่ควบคุม) per QP-DC-01.
function stampHtml(p) {
  var e = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var get = function (k) { return p && p.get ? (p.get(k) || '') : ''; };
  var type = get('type') || 'all';
  var code = get('code'), rev = get('rev'), no = get('no'), holder = get('name');
  var CONF = {
    original:     { th: 'ต้นฉบับ', en: 'ORIGINAL', col: '#c1121f' },
    controlled:   { th: 'สำเนาควบคุม', en: 'CONTROLLED COPY', col: '#c1121f' },
    uncontrolled: { th: 'เอกสารไม่ควบคุม', en: 'UNCONTROLLED COPY', col: '#8a6d00' },
  };
  var one = function (t) {
    var c = CONF[t]; if (!c) return '';
    var info = '';
    if (code) info += '<div class="i">' + e(code) + (rev ? ' · Rev ' + e(rev) : '') + '</div>';
    if (t === 'controlled' && no) info += '<div class="i">ชุดที่ (Copy No.) ' + e(no) + '</div>';
    if (t === 'controlled' && holder) info += '<div class="i">ผู้ถือครอง: ' + e(holder) + '</div>';
    return '<div class="stamp" style="color:' + c.col + ';border-color:' + c.col + '">' +
      '<div class="th">' + c.th + '</div><div class="en">' + c.en + '</div>' +
      '<div class="qp">QP-DC-01</div>' + info +
      '<div class="dt">วันที่ ......./......./.......</div></div>';
  };
  var blocks = (type === 'all') ? (one('original') + one('controlled') + one('uncontrolled')) : one(type);
  return '<!doctype html><html lang="th"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>สแตมป์เอกสาร</title>' +
    "<style>@import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@600;700;800&display=swap');" +
    "*{box-sizing:border-box}body{font-family:'Sarabun',sans-serif;margin:0;padding:26px;background:#f4f4f4;text-align:center}" +
    '.print{position:fixed;top:14px;right:14px;background:#15803d;color:#fff;border:none;padding:10px 18px;border-radius:8px;font:inherit;font-weight:600;cursor:pointer}' +
    '.wrap{display:flex;flex-wrap:wrap;gap:26px;justify-content:center;align-items:flex-start}' +
    '.stamp{display:inline-block;border:3px solid;border-radius:10px;padding:12px 22px;transform:rotate(-7deg);' +
    'box-shadow:inset 0 0 0 2px currentColor;background:rgba(255,255,255,.7);min-width:230px}' +
    '.stamp .th{font-size:30px;font-weight:800;line-height:1.1;letter-spacing:1px}' +
    '.stamp .en{font-size:13px;font-weight:700;letter-spacing:2px;margin-top:2px}' +
    '.stamp .qp{font-size:11px;font-weight:600;margin-top:6px;opacity:.85}' +
    '.stamp .i{font-size:13px;font-weight:600;margin-top:3px}' +
    '.stamp .dt{font-size:11.5px;font-weight:600;margin-top:8px;opacity:.9}' +
    '.hint{color:#666;font-size:12.5px;margin:6px 0 20px}' +
    '@media print{body{background:#fff;padding:8mm}.print,.hint{display:none}}' +
    '</style></head><body>' +
    '<button class="print" onclick="window.print()">🖨️ พิมพ์</button>' +
    '<div class="hint">ตราประทับควบคุมเอกสาร · พิมพ์ลงสติกเกอร์/ฉลาก แล้วติดบนเอกสาร (สีแดงตาม QP-DC-01)</div>' +
    '<div class="wrap">' + blocks + '</div>' +
    '<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},450);});<\/script>' +
    '</body></html>';
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: Object.assign({}, J, {
          'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'access-control-allow-headers': 'content-type,authorization,x-admin-key',
        }) });
      }
      if (env.AUTH_TOKEN) {
        const a = request.headers.get('authorization') || '';
        if (a !== 'Bearer ' + env.AUTH_TOKEN) return json({ error: 'unauthorized' }, 401);
      }
      // Admin gate: only request submission, file upload and auto-numbering are
      // public (used by /submit). Everything else needs the admin key.
      const adminKey = env.ADMIN_KEY || ADMIN_KEY_DEFAULT;
      const provided = request.headers.get('x-admin-key') || url.searchParams.get('key') || '';
      const isPublic =
        (request.method === 'POST' && url.pathname === '/api/requests') ||
        (request.method === 'POST' && url.pathname === '/api/upload') ||
        (request.method === 'GET' && url.pathname === '/api/nextcode');
      if (!isPublic && provided !== adminKey) return json({ error: 'unauthorized', login: true }, 401);
      if (url.pathname === '/api/upload' && request.method === 'POST') {
        return await uploadHandler(request, env, url);  // body not pre-parsed here
      }
      try { return await api(request, env, url, ctx); }
      catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
    }
    if (url.pathname.startsWith('/files/')) return serveFile(env, url);
    if (url.pathname.startsWith('/dar/')) {
      const adminKey = env.ADMIN_KEY || ADMIN_KEY_DEFAULT;
      if ((url.searchParams.get('key') || '') !== adminKey) return new Response('unauthorized', { status: 401 });
      const rid = decodeURIComponent(url.pathname.replace(/^\/dar\//, ''));
      const r = await env.DB.prepare('SELECT * FROM approval_log WHERE id=? OR RequestId=?').bind(rid, rid).first();
      if (!r) return new Response('not found', { status: 404 });
      return new Response(darHtml(r), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/stamp') {
      const adminKey = env.ADMIN_KEY || ADMIN_KEY_DEFAULT;
      if ((url.searchParams.get('key') || '') !== adminKey) return new Response('unauthorized', { status: 401 });
      return new Response(stampHtml(url.searchParams), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/submit' || url.pathname === '/submit/') {
      return new Response(SUBMIT_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/manifest.webmanifest') {
      return new Response(MANIFEST_JSON, { headers: { 'content-type': 'application/manifest+json; charset=utf-8' } });
    }
    if (url.pathname === '/icon.svg') {
      return new Response(ICON_SVG, { headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
    }
    if (url.pathname === '/sw.js') {
      return new Response(SW_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
    }
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response('Not found', { status: 404 });
  },
};

const HTML = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Document Control Center</title>
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#15803d">
<link rel="icon" href="/icon.svg">
<link rel="apple-touch-icon" href="/icon.svg">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="DCC">
<style>
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#eef4f0;--card:#ffffff;--ink:#1f2a26;--muted:#7e8a83;--line:#e6efe9;
  --blue:#159a57;--blue-soft:#e4f5ec;
  --grad:linear-gradient(135deg,#1fae5f 0%,#0d9488 100%);
  --grad-bar:linear-gradient(135deg,#15803d 0%,#0f766e 100%);
  --amber:#f59e0b;--amber-soft:#fff5e6;--amber-ink:#b4690e;
  --green:#16a34a;--green-soft:#e8f7ee;--green-ink:#15803d;
  --red:#ef4444;--red-soft:#fdecec;--red-ink:#c62f2f;
  --slate:#64748b;--slate-soft:#eef1f5;
}
html,body{background:var(--bg);background-image:linear-gradient(180deg,#eef6f0 0%,#e3efe8 100%);background-attachment:fixed;color:var(--ink);font-family:'Noto Sans Thai',system-ui,sans-serif;font-size:15px;line-height:1.5}
.mono{font-family:'IBM Plex Mono',monospace}
#topbar{position:sticky;top:0;z-index:30;height:56px;background:var(--grad-bar);color:#fff;box-shadow:0 2px 12px rgba(13,148,136,.28);
  display:flex;align-items:center;gap:10px;padding:0 14px}
#topbar .iconbtn{color:#fff}
#topbar .iconbtn:active{background:rgba(255,255,255,.18)}
#topbar .tt{font-weight:700;font-size:16px;flex:1;text-align:center}
.iconbtn{width:38px;height:38px;border:none;background:none;border-radius:10px;font-size:20px;cursor:pointer;color:var(--ink);display:grid;place-items:center}
.iconbtn:active{background:var(--slate-soft)}
main{max-width:760px;margin:0 auto;padding:18px 14px 90px}
.page-h{margin:4px 2px 16px}
.page-h h1{font-size:24px;font-weight:700}
.page-h p{color:var(--muted);font-size:13px;margin-top:2px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;box-shadow:0 1px 2px rgba(20,30,60,.04)}
.card+.card{margin-top:14px}
/* drawer */
#scrim{position:fixed;inset:0;background:rgba(15,20,35,.45);opacity:0;pointer-events:none;transition:opacity .2s;z-index:40}
#scrim.open{opacity:1;pointer-events:auto}
#drawer{position:fixed;top:0;left:0;bottom:0;width:264px;background:#fff;z-index:50;transform:translateX(-100%);
  transition:transform .22s ease;box-shadow:2px 0 24px rgba(20,30,60,.12);display:flex;flex-direction:column}
#drawer.open{transform:none}
.brand{display:flex;align-items:center;gap:10px;padding:18px 16px;border-bottom:1px solid var(--line)}
.brand .logo{width:38px;height:38px;border-radius:10px;background:var(--grad);color:#fff;display:grid;place-items:center;font-size:18px}
.brand b{font-size:15px}.brand span{display:block;font-size:11px;color:var(--muted)}
nav{padding:10px 10px;display:flex;flex-direction:column;gap:3px}
nav a{display:flex;align-items:center;gap:12px;padding:11px 12px;border-radius:10px;color:var(--ink);cursor:pointer;font-weight:500;font-size:14.5px}
nav a .ni{width:20px;text-align:center}
nav a:active{background:var(--slate-soft)}
nav a.on{background:var(--grad);color:#fff}
/* stat cards */
.stats{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px}
.stat{background:#fff;border:1px solid var(--line);border-radius:16px;padding:15px;display:flex;flex-direction:column;gap:10px}
.stat .tile{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;font-size:18px}
.stat .n{font-size:30px;font-weight:700;line-height:1}
.stat .t{font-size:12.5px;color:var(--muted)}
.t-blue{background:var(--blue-soft);color:var(--blue)}
.t-amber{background:var(--amber-soft);color:var(--amber)}
.t-green{background:var(--green-soft);color:var(--green)}
.t-red{background:var(--red-soft);color:var(--red)}
/* tables / lists */
.sec-h{display:flex;align-items:center;justify-content:space-between;margin:2px 2px 10px}
.sec-h h2{font-size:16px;font-weight:700}
.link{color:var(--blue);font-size:13px;font-weight:600;cursor:pointer}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;color:var(--muted);font-weight:600;font-size:12px;padding:8px 6px;border-bottom:1px solid var(--line)}
td{padding:11px 6px;border-bottom:1px solid var(--line)}
tr:last-child td{border-bottom:none}
.badge{display:inline-block;font-size:12px;font-weight:600;padding:3px 11px;border-radius:20px}
.bg-amber{background:var(--amber-soft);color:var(--amber-ink)}
.bg-green{background:var(--green-soft);color:var(--green-ink)}
.bg-red{background:var(--red-soft);color:var(--red-ink)}
.bg-slate{background:var(--slate-soft);color:var(--slate)}
.rowcard{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:7px;cursor:pointer}
.rowcard+.rowcard{margin-top:10px}
.rowcard .top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.rowcard .code{font-weight:700;font-size:14px}
.rowcard .name{font-size:14px}
.rowcard .meta{color:var(--muted);font-size:12.5px;display:flex;gap:12px;flex-wrap:wrap}
.empty{text-align:center;color:var(--muted);padding:34px 10px}
/* forms */
.fsec{margin-bottom:14px}
.fsec-t{font-weight:700;font-size:14.5px;margin:0 2px 10px;display:flex;gap:7px;align-items:center}
.fsec-t .num{width:22px;height:22px;border-radius:7px;background:var(--blue-soft);color:var(--blue);font-size:12px;display:grid;place-items:center;font-weight:700}
.fld{margin-bottom:13px}
.fld:last-child{margin-bottom:0}
.fld label{display:block;font-size:13px;font-weight:600;color:#46506a;margin-bottom:6px}
.fld label .req{color:var(--red)}
.fld input,.fld select,.fld textarea{width:100%;font-family:inherit;font-size:14.5px;color:var(--ink);background:#fff;
  border:1px solid #dde1ea;border-radius:11px;padding:11px 13px;outline:none;transition:border .12s,box-shadow .12s}
.fld input::placeholder,.fld textarea::placeholder{color:#aeb4c2}
.fld input:focus,.fld select:focus,.fld textarea:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(21,154,87,.18)}
.fld textarea{resize:vertical;min-height:80px}
.fld select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%238b91a3' d='M6 8 0 0h12z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;font-family:inherit;font-size:15px;font-weight:600;
  cursor:pointer;border-radius:12px;padding:13px;border:none;transition:filter .12s,transform .1s}
.btn:active{transform:translateY(1px)}
.btn-pri{background:var(--grad);color:#fff}
.btn-pri:active{filter:brightness(.94)}
.btn-ghost{background:var(--slate-soft);color:var(--ink)}
.btn-sm{width:auto;padding:8px 14px;font-size:13.5px;border-radius:10px}
.btn:disabled{opacity:.55}
.toolbar{display:flex;gap:8px;margin-bottom:14px}
.toolbar .search{flex:1;display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #dde1ea;border-radius:11px;padding:0 12px}
.toolbar .search input{border:none;outline:none;width:100%;padding:11px 0;font-family:inherit;font-size:14px;background:none}
/* modal */
.overlay{position:fixed;inset:0;background:rgba(15,20,35,.5);z-index:60;display:flex;align-items:flex-end;justify-content:center;padding:0}
.sheet{background:#fff;width:100%;max-width:760px;max-height:92vh;overflow-y:auto;border-radius:18px 18px 0 0;padding:18px 16px calc(18px + env(safe-area-inset-bottom))}
@media(min-width:640px){.overlay{align-items:center;padding:20px}.sheet{border-radius:18px}}
.sheet-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.sheet-h h3{font-size:17px;font-weight:700}
.expiry-pill{font-size:11.5px;font-weight:600;padding:2px 9px;border-radius:20px}
.kv{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);font-size:14px}
.kv:last-child{border-bottom:none}.kv b{color:var(--muted);font-weight:600}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(20px);background:#1f2533;color:#fff;
  padding:11px 18px;border-radius:12px;font-size:14px;z-index:80;opacity:0;transition:all .25s;pointer-events:none}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
</style>
</head>
<body>
<div id="topbar">
  <button class="iconbtn" id="menuBtn">&#9776;</button>
  <div class="tt" id="topTitle">Document Control</div>
  <button class="iconbtn" id="refreshBtn">&#8635;</button>
</div>
<div id="scrim"></div>
<aside id="drawer">
  <div class="brand">
    <div class="logo">&#128737;</div>
    <div><b>Document Control</b><span>ระบบควบคุมเอกสาร</span></div>
  </div>
  <nav id="nav">
    <a data-nav="dashboard"><span class="ni">&#128202;</span>Dashboard</a>
    <a data-nav="create"><span class="ni">&#9999;</span>สร้างคำร้อง</a>
    <a data-nav="requests"><span class="ni">&#128203;</span>คำร้องทั้งหมด</a>
    <a data-nav="mdl"><span class="ni">&#128196;</span>MDL</a>
    <a data-nav="dist"><span class="ni">&#128230;</span>แจกจ่ายเอกสาร</a>
    <a data-nav="expiry"><span class="ni">&#9200;</span>Expiry Monitor</a>
  </nav>
</aside>
<main id="app"></main>
<div id="modalRoot"></div>
<div class="toast" id="toast"></div>

<script>
var ST={view:'dashboard',mdl:[],requests:[],dist:[],stats:null,q:''};
var COPYTYPES=['Controlled (สำเนาควบคุม)','Uncontrolled (ไม่ควบคุม)'];
var DIST_STATUS=['Issued (แจกจ่ายแล้ว)','Returned (เรียกคืนแล้ว)'];
var DEPTS=['QA','QC','PD','WH','HR','AC','PU','MN'];
var DOCTYPES=['QM','QP','WI','FM','SD'];
var ACTIONS=['จัดทำเอกสารใหม่','ปรับปรุง/แก้ไขเอกสาร','ยกเลิกเอกสาร','ขอสำเนา/ขอใช้เอกสาร'];
var STATUSES=['Draft','Pending Approval','Active','Obsolete'];

function el(id){return document.getElementById(id);}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function toast(m){var t=el('toast');t.textContent=m;t.classList.add('show');setTimeout(function(){t.classList.remove('show');},2200);}
function fmtDate(v){if(!v)return '—';var d=new Date(v);if(isNaN(d))return v;return d.toLocaleDateString('th-TH',{year:'numeric',month:'short',day:'numeric'});}

var KEY=localStorage.getItem('dcc_key')||'';
function api(method,path,body){
  return fetch('/api'+path,{method:method,headers:{'content-type':'application/json','x-admin-key':KEY},body:body?JSON.stringify(body):undefined})
    .then(function(r){
      if(r.status===401){showLogin('รหัสผ่านไม่ถูกต้อง หรือหมดสิทธิ์');throw new Error('unauthorized');}
      if(r.status===204)return null;
      return r.json().then(function(j){ if(!r.ok) throw new Error(j&&j.error?j.error:('HTTP '+r.status)); return j; });
    });
}
function showLogin(msg){
  el('modalRoot').innerHTML='<div class="overlay" id="ov"><div class="sheet" style="max-width:380px">'+
    '<div class="sheet-h"><h3>🔒 เข้าสู่ระบบ DCC</h3></div>'+
    '<p style="font-size:13px;color:var(--muted);margin-bottom:12px">สำหรับเจ้าหน้าที่ QA / DCC เท่านั้น</p>'+
    (msg?'<p style="color:var(--red-ink);font-size:13px;margin-bottom:10px">'+esc(msg)+'</p>':'')+
    '<div class="fld"><input type="password" id="pw" placeholder="รหัสผ่าน"></div>'+
    '<button class="btn btn-pri" id="loginBtn" style="margin-top:6px">เข้าสู่ระบบ</button></div></div>';
  el('loginBtn').onclick=doLogin;
  el('pw').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin();});
  el('pw').focus();
}
function doLogin(){
  KEY=el('pw').value;
  api('GET','/stats').then(function(){localStorage.setItem('dcc_key',KEY);closeSheet();render();}).catch(function(){});
}

/* ---------- drawer / nav ---------- */
function openDrawer(o){el('drawer').classList.toggle('open',o);el('scrim').classList.toggle('open',o);}
function setNav(){var as=el('nav').querySelectorAll('a');for(var i=0;i<as.length;i++)as[i].classList.toggle('on',as[i].getAttribute('data-nav')===ST.view);}
function navigate(v){ST.view=v;ST.q='';setNav();openDrawer(false);render();}

/* ---------- decision badge ---------- */
function decBadge(d){
  if(d==='APPROVED')return '<span class="badge bg-green">Approved</span>';
  if(d==='REJECTED')return '<span class="badge bg-red">Rejected</span>';
  return '<span class="badge bg-amber">Pending</span>';
}

/* ---------- views ---------- */
function render(){
  if(ST.view==='dashboard')return viewDashboard();
  if(ST.view==='create')return viewCreate();
  if(ST.view==='requests')return viewRequests();
  if(ST.view==='mdl')return viewMdl();
  if(ST.view==='dist')return viewDist();
  if(ST.view==='expiry')return viewExpiry();
}

function loading(){el('app').innerHTML='<div class="empty">กำลังโหลด…</div>';}

function viewDashboard(){
  el('topTitle').textContent='Dashboard';
  loading();
  api('GET','/stats').then(function(s){
    ST.stats=s;
    var rec=(s.recent||[]).map(function(r){
      return '<tr><td class="mono">'+esc(r.DocCode||'—')+'</td><td style="text-align:right">'+decBadge(r.Decision)+'</td></tr>';
    }).join('')||'<tr><td class="empty" colspan="2">ยังไม่มีคำร้อง</td></tr>';
    el('app').innerHTML=
     '<div class="page-h"><h1>Dashboard</h1><p>ภาพรวมระบบควบคุมเอกสาร — Document Control Center</p></div>'+
     '<div class="stats">'+
       statCard('t-blue','&#128196;',s.mdlTotal,'เอกสารทั้งหมด (MDL)')+
       statCard('t-amber','&#9201;',s.pending,'รออนุมัติ')+
       statCard('t-green','&#10004;',s.approved,'อนุมัติแล้ว')+
       statCard('t-red','&#10006;',s.rejected,'ปฏิเสธ')+
     '</div>'+
     '<div class="card"><div class="sec-h"><h2>คำร้องล่าสุด</h2><span class="link" data-nav-link="requests">ดูทั้งหมด &#8594;</span></div>'+
       '<table><thead><tr><th>รหัส</th><th style="text-align:right">สถานะ</th></tr></thead><tbody>'+rec+'</tbody></table></div>';
    bindNavLinks();
  }).catch(showErr);
}
function statCard(tile,icon,n,t){
  return '<div class="stat"><div class="tile '+tile+'">'+icon+'</div><div class="n">'+(n||0)+'</div><div class="t">'+t+'</div></div>';
}

function viewRequests(){
  el('topTitle').textContent='คำร้องทั้งหมด';
  loading();
  api('GET','/requests').then(function(list){
    ST.requests=list;
    renderRequestList();
  }).catch(showErr);
}
function renderRequestList(){
  var q=ST.q.trim().toLowerCase();
  var list=ST.requests.filter(function(r){
    if(!q)return true;
    return [r.DocCode,r.DocName,r.RequesterName,r.Department,r.RequestId].some(function(x){return String(x||'').toLowerCase().indexOf(q)>=0;});
  });
  var cards=list.map(function(r){
    return '<div class="rowcard" data-req="'+r.id+'">'+
      '<div class="top"><span class="code mono">'+esc(r.DocCode||'—')+'</span>'+decBadge(r.Decision)+'</div>'+
      '<div class="name">'+esc(r.DocName||'(ไม่ระบุชื่อเอกสาร)')+'</div>'+
      '<div class="meta"><span>&#128100; '+esc(r.RequesterName||'—')+'</span><span>'+esc(r.Department||'—')+'</span><span>'+esc(r.ActionType||'')+'</span></div>'+
    '</div>';
  }).join('')||'<div class="empty">ยังไม่มีคำร้อง</div>';
  el('app').innerHTML=
   '<div class="page-h"><h1>คำร้องทั้งหมด</h1><p>'+ST.requests.length+' รายการ</p></div>'+
   '<div class="toolbar"><div class="search">&#128269;<input id="q" placeholder="ค้นหา รหัส/ชื่อ/ผู้ขอ…" value="'+esc(ST.q)+'"></div>'+
     '<button class="btn btn-pri btn-sm" data-nav-link="create">+ สร้าง</button></div>'+
   cards;
  bindNavLinks();
  el('q').addEventListener('input',function(e){ST.q=e.target.value;renderRequestList();});
  var rc=el('app').querySelectorAll('[data-req]');
  for(var i=0;i<rc.length;i++)rc[i].addEventListener('click',function(){openRequest(this.getAttribute('data-req'));});
}

function viewMdl(){
  el('topTitle').textContent='MDL';
  loading();
  api('GET','/mdl').then(function(list){ST.mdl=list;renderMdlList();}).catch(showErr);
}
function renderMdlList(){
  var q=ST.q.trim().toLowerCase();
  var list=ST.mdl.filter(function(r){
    if(!q)return true;
    return [r.DocCode,r.DocName,r.Department,r.Status].some(function(x){return String(x||'').toLowerCase().indexOf(q)>=0;});
  });
  var statusBadge=function(s){
    if(s==='Active')return '<span class="badge bg-green">Active</span>';
    if(s==='Obsolete')return '<span class="badge bg-slate">Obsolete</span>';
    if(s==='Pending Approval')return '<span class="badge bg-amber">Pending</span>';
    return '<span class="badge bg-slate">'+esc(s||'Draft')+'</span>';
  };
  var cards=list.map(function(r){
    return '<div class="rowcard" data-mdl="'+r.id+'">'+
      '<div class="top"><span class="code mono">'+esc(r.DocCode)+'</span>'+statusBadge(r.Status)+'</div>'+
      '<div class="name">'+esc(r.DocName||'')+'</div>'+
      '<div class="meta"><span>'+esc(r.DocType||'—')+'</span><span>'+esc(r.Department||'—')+'</span><span>Rev '+esc(r.Rev||'-')+'</span></div>'+
    '</div>';
  }).join('')||'<div class="empty">ยังไม่มีเอกสารในทะเบียน — กด “+ เพิ่ม”</div>';
  el('app').innerHTML=
   '<div class="page-h"><h1>บัญชีแม่บทเอกสาร</h1><p>Document Master List · FM-MR-02 · '+ST.mdl.length+' ฉบับ</p></div>'+
   '<div class="toolbar"><div class="search">&#128269;<input id="q" placeholder="ค้นหา รหัส/ชื่อ/แผนก…" value="'+esc(ST.q)+'"></div>'+
     '<button class="btn btn-pri btn-sm" id="addMdl">+ เพิ่ม</button></div>'+
   cards;
  el('q').addEventListener('input',function(e){ST.q=e.target.value;renderMdlList();});
  el('addMdl').addEventListener('click',function(){openMdlForm(null);});
  var rc=el('app').querySelectorAll('[data-mdl]');
  for(var i=0;i<rc.length;i++)rc[i].addEventListener('click',function(){
    var id=this.getAttribute('data-mdl');openMdlForm(ST.mdl.filter(function(x){return x.id===id;})[0]);
  });
}

/* ---------- distribution (FM-MR-03) ---------- */
function viewDist(){
  el('topTitle').textContent='แจกจ่ายเอกสาร';
  loading();
  Promise.all([api('GET','/dist'),ST.mdl.length?Promise.resolve(ST.mdl):api('GET','/mdl')]).then(function(res){
    ST.dist=res[0];ST.mdl=res[1];renderDistList();
  }).catch(showErr);
}
function renderDistList(){
  var q=ST.q.trim().toLowerCase();
  var list=ST.dist.filter(function(r){if(!q)return true;
    return [r.DocCode,r.DocName,r.HolderName,r.Department,r.CopyNo].some(function(x){return String(x||'').toLowerCase().indexOf(q)>=0;});});
  var badge=function(s){return (s&&s.indexOf('Returned')>=0)?'<span class="badge bg-slate">เรียกคืนแล้ว</span>':'<span class="badge bg-green">แจกจ่ายแล้ว</span>';};
  var cards=list.map(function(r){
    return '<div class="rowcard" data-dist="'+r.id+'">'+
      '<div class="top"><span class="code mono">'+esc(r.DocCode||'-')+' · Rev '+esc(r.Rev||'-')+'</span>'+badge(r.Status)+'</div>'+
      '<div class="name">'+esc(r.DocName||'')+'</div>'+
      '<div class="meta"><span>👤 '+esc(r.HolderName||'-')+'</span><span>'+esc(r.Department||'')+'</span><span>ชุดที่ '+esc(r.CopyNo||'-')+'</span><span>'+esc((r.CopyType||'').split(' ')[0])+'</span></div>'+
    '</div>';
  }).join('')||'<div class="empty">ยังไม่มีบันทึกการแจกจ่าย — กด “+ แจกจ่าย”</div>';
  el('app').innerHTML=
   '<div class="page-h"><h1>แจกจ่าย/เรียกคืนเอกสาร</h1><p>บันทึกการแจกจ่าย · FM-MR-03 · '+ST.dist.length+' รายการ</p></div>'+
   '<div class="toolbar"><div class="search">&#128269;<input id="q" placeholder="ค้นหา รหัส/ผู้ถือครอง…" value="'+esc(ST.q)+'"></div>'+
     '<button class="btn btn-pri btn-sm" id="addDist">+ แจกจ่าย</button></div>'+
   cards;
  el('q').addEventListener('input',function(e){ST.q=e.target.value;renderDistList();});
  el('addDist').addEventListener('click',function(){openDistForm(null);});
  var rc=el('app').querySelectorAll('[data-dist]');
  for(var i=0;i<rc.length;i++)rc[i].addEventListener('click',function(){
    var id=this.getAttribute('data-dist');openDistForm(ST.dist.filter(function(x){return x.id===id;})[0]);});
}
function openDistForm(rec){
  rec=rec||{};
  var isNew=!rec.id;
  var codes=ST.mdl.map(function(r){return r.DocCode;}).filter(Boolean);
  var body='<form id="distForm">'+
    '<div class="fld"><label>รหัสเอกสาร <span class="req">*</span></label>'+
      '<input list="dcodes" class="mono" data-f="DocCode" data-req="รหัสเอกสาร" value="'+esc(rec.DocCode||'')+'" placeholder="เลือก/พิมพ์รหัส"></div>'+
    '<datalist id="dcodes">'+codes.map(function(c){return '<option value="'+esc(c)+'">';}).join('')+'</datalist>'+
    fld('DocName','ชื่อเอกสาร','text',{val:rec.DocName})+
    fld('Rev','Revision','text',{mono:1,val:rec.Rev})+
    fld('HolderName','ผู้ถือครอง (Holder)','text',{req:1,val:rec.HolderName})+
    fldSelect('Department','แผนกผู้ถือครอง',DEPTS,{val:rec.Department})+
    fld('CopyNo','ชุดที่ (Copy No.)','text',{val:rec.CopyNo,ph:'เช่น 1, 2'})+
    fldSelect('CopyType','ประเภทสำเนา',COPYTYPES,{val:rec.CopyType})+
    fld('IssuedDate','วันที่แจกจ่าย','date',{val:rec.IssuedDate||new Date().toISOString().slice(0,10)})+
    fldSelect('Status','สถานะ',DIST_STATUS,{val:rec.Status})+
    fld('ReturnedDate','วันที่เรียกคืน','date',{val:rec.ReturnedDate})+
    fld('Notes','หมายเหตุ','textarea',{val:rec.Notes})+
    '<button type="submit" class="btn btn-pri" id="saveDist" style="margin-top:6px">&#10003; บันทึก</button>'+
    (isNew?'':'<button type="button" class="btn btn-ghost" id="stampDist" style="margin-top:10px">🔖 พิมพ์สแตมป์สำเนา</button>')+
    (isNew?'':'<button type="button" class="btn btn-ghost" id="delDist" style="margin-top:10px;color:var(--red-ink)">ลบรายการ</button>')+
  '</form>';
  openSheet(isNew?'แจกจ่ายเอกสาร':'แก้ไขบันทึกแจกจ่าย',body);
  el('distForm').addEventListener('submit',function(e){
    e.preventDefault();
    var miss=requiredMissing(el('distForm'));if(miss){toast('กรุณากรอก: '+miss);return;}
    var data=collect(el('distForm'));
    var btn=el('saveDist');btn.disabled=true;btn.textContent='กำลังบันทึก…';
    var p=isNew?api('POST','/dist',data):api('PUT','/dist/'+rec.id,data);
    p.then(function(){closeSheet();toast('บันทึกแล้ว ✓');navigate('dist');})
     .catch(function(err){toast('บันทึกไม่สำเร็จ: '+err.message);btn.disabled=false;btn.innerHTML='&#10003; บันทึก';});
  });
  if(!isNew)el('stampDist').addEventListener('click',function(){
    var t=(rec.CopyType&&rec.CopyType.indexOf('Uncontrolled')>=0)?'uncontrolled':'controlled';
    window.open('/stamp?type='+t+'&code='+encodeURIComponent(rec.DocCode||'')+'&rev='+encodeURIComponent(rec.Rev||'')+'&no='+encodeURIComponent(rec.CopyNo||'')+'&name='+encodeURIComponent(rec.HolderName||'')+'&key='+encodeURIComponent(KEY),'_blank');
  });
  if(!isNew)el('delDist').addEventListener('click',function(){
    if(!confirm('ลบรายการนี้?'))return;
    api('DELETE','/dist/'+rec.id).then(function(){closeSheet();toast('ลบแล้ว');navigate('dist');}).catch(function(e){toast('ลบไม่สำเร็จ');});
  });
}

function viewExpiry(){
  el('topTitle').textContent='Expiry Monitor';
  loading();
  api('GET','/mdl').then(function(list){
    ST.mdl=list;
    var today=new Date();today.setHours(0,0,0,0);
    var withDate=list.map(function(r){
      var d=r.NextReviewDate?new Date(r.NextReviewDate):null;
      var days=(d&&!isNaN(d))?Math.round((d-today)/86400000):null;
      return {r:r,days:days};
    });
    withDate.sort(function(a,b){
      if(a.days==null)return 1;if(b.days==null)return -1;return a.days-b.days;
    });
    var pill=function(days){
      if(days==null)return '<span class="expiry-pill bg-slate">ไม่ได้กำหนด</span>';
      if(days<0)return '<span class="expiry-pill bg-red">เลยกำหนด '+(-days)+' วัน</span>';
      if(days<=30)return '<span class="expiry-pill bg-amber">อีก '+days+' วัน</span>';
      return '<span class="expiry-pill bg-green">อีก '+days+' วัน</span>';
    };
    var over=withDate.filter(function(x){return x.days!=null&&x.days<0;}).length;
    var soon=withDate.filter(function(x){return x.days!=null&&x.days>=0&&x.days<=30;}).length;
    var cards=withDate.map(function(x){
      return '<div class="rowcard" data-mdl="'+x.r.id+'">'+
        '<div class="top"><span class="code mono">'+esc(x.r.DocCode)+'</span>'+pill(x.days)+'</div>'+
        '<div class="name">'+esc(x.r.DocName||'')+'</div>'+
        '<div class="meta"><span>ทบทวนถัดไป: '+fmtDate(x.r.NextReviewDate)+'</span><span>'+esc(x.r.Department||'')+'</span></div>'+
      '</div>';
    }).join('')||'<div class="empty">ยังไม่มีเอกสารให้ติดตาม</div>';
    el('app').innerHTML=
     '<div class="page-h"><h1>Expiry Monitor</h1><p>ติดตามรอบทบทวนเอกสาร</p></div>'+
     '<div class="stats"><div class="stat"><div class="tile t-red">&#9888;</div><div class="n">'+over+'</div><div class="t">เลยกำหนดทบทวน</div></div>'+
       '<div class="stat"><div class="tile t-amber">&#9201;</div><div class="n">'+soon+'</div><div class="t">ใกล้ครบ (&le;30 วัน)</div></div></div>'+
     cards;
    var rc=el('app').querySelectorAll('[data-mdl]');
    for(var i=0;i<rc.length;i++)rc[i].addEventListener('click',function(){
      var id=this.getAttribute('data-mdl');openMdlForm(ST.mdl.filter(function(x){return x.id===id;})[0]);
    });
  }).catch(showErr);
}

/* ---------- file upload (to R2 via the Worker) ---------- */
function uploadFile(file,field,statusId){
  field=field||'DraftFileLink';
  var status=el(statusId||'upStatus');
  if(file.size>25*1024*1024){status.textContent='ไฟล์ใหญ่เกิน 25MB';return;}
  status.textContent='กำลังอัปโหลด… '+file.name;
  fetch('/api/upload?name='+encodeURIComponent(file.name),{method:'POST',headers:{'content-type':file.type||'application/octet-stream'},body:file})
    .then(function(r){return r.json();})
    .then(function(j){
      if(j&&j.url){var inp=document.querySelector('[data-f='+field+']');if(inp)inp.value=j.url;
        status.innerHTML='✓ แนบแล้ว: <a href="'+esc(j.url)+'" target="_blank" style="color:var(--blue)">'+esc(file.name)+'</a>';}
      else{status.textContent='อัปโหลดไม่สำเร็จ: '+((j&&j.error)||'unknown');}
    })
    .catch(function(err){status.textContent='อัปโหลดไม่สำเร็จ: '+err.message;});
}

/* ---------- auto document-number (AA-BB-NN per QP-DC-01) ---------- */
function genCode(){
  var t=document.querySelector('[data-f=DocType]'),d=document.querySelector('[data-f=Department]');
  var type=t?t.value:'',dept=d?d.value:'';
  var st=el('codeStatus');
  if(!type||!dept){if(st)st.textContent='เลือกประเภทเอกสาร + แผนกก่อน';return;}
  if(st)st.textContent='กำลังออกเลข…';
  fetch('/api/nextcode?type='+encodeURIComponent(type)+'&dept='+encodeURIComponent(dept))
    .then(function(r){return r.json();})
    .then(function(j){var inp=document.querySelector('[data-f=DocCode]');
      if(j&&j.code&&inp){inp.value=j.code;if(st)st.innerHTML='✓ ออกเลขให้แล้ว';}
      else if(st)st.textContent='ออกเลขไม่สำเร็จ';})
    .catch(function(){if(st)st.textContent='ออกเลขไม่สำเร็จ';});
}

/* ---------- create request (full page form) ---------- */
function viewCreate(){
  el('topTitle').textContent='สร้างคำร้อง';
  var f=function(inner){return inner;};
  el('app').innerHTML=
   '<div class="page-h"><h1>สร้างคำร้อง (DAR)</h1><p>ใบขอดำเนินการด้านเอกสาร · FM-MR-01 —จัดทำ / แก้ไข / ยกเลิก / ขอสำเนา (ตาม QP-DC-01)</p></div>'+
   '<form id="reqForm">'+
     '<div class="card fsec"><div class="fsec-t"><span class="num">1</span>ข้อมูลผู้ร้องขอ</div>'+
       fld('RequesterName','ชื่อ-นามสกุล ผู้ส่งคำร้อง','text',{req:1,ph:'ชื่อ-นามสกุล'})+
       fld('RequesterEmail','อีเมลผู้ขอ (สำหรับรับแจ้งผล)','email',{ph:'name@company.com'})+
       fldSelect('Department','แผนก (Department)',DEPTS,{req:1})+
     '</div>'+
     '<div class="card fsec"><div class="fsec-t"><span class="num">2</span>ประเภทคำขอ</div>'+
       fldSelect('ActionType','ประเภทการดำเนินการ',ACTIONS,{req:1})+
     '</div>'+
     '<div class="card fsec"><div class="fsec-t"><span class="num">3</span>ข้อมูลเอกสาร</div>'+
       fldSelect('DocType','ประเภทเอกสาร',DOCTYPES,{req:1})+
       fld('DocName','ชื่อเอกสาร (ไทย/อังกฤษ)','text',{req:1,ph:'เช่น ขั้นตอนการตรวจรับวัตถุดิบ'})+
       '<div class="fld"><label>รหัสเอกสาร</label>'+
         '<input type="text" class="mono" data-f="DocCode" placeholder="เช่น QP-QA-03 หรือกดออกเลขอัตโนมัติ" value="">'+
         '<div style="display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap">'+
           '<button type="button" class="btn btn-ghost btn-sm" id="genCodeBtn">🔢 ออกเลขอัตโนมัติ</button>'+
           '<span id="codeStatus" style="font-size:12.5px;color:var(--muted)"></span>'+
         '</div></div>'+
       '<div class="fld"><label>ไฟล์ฉบับร่าง (Draft File)</label>'+
         '<input type="url" data-f="DraftFileLink" placeholder="วางลิงก์ หรือกดอัปโหลดไฟล์ด้านล่าง" value="">'+
         '<div style="display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap">'+
           '<button type="button" class="btn btn-ghost btn-sm" id="upBtn">📎 อัปโหลดไฟล์</button>'+
           '<input type="file" id="upFile" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg" style="display:none">'+
           '<span id="upStatus" style="font-size:12.5px;color:var(--muted)"></span>'+
         '</div></div>'+
     '</div>'+
     '<div class="card fsec"><div class="fsec-t"><span class="num">4</span>เหตุผลและการอนุมัติ</div>'+
       fld('Reason','เหตุผลในการขอ','textarea',{req:1,ph:'ระบุเหตุผลที่ต้องสร้างหรือแก้ไขเอกสาร'})+
       fld('ExpectedDate','วันที่คาดว่าจะแล้วเสร็จ (Target Date)','date',{})+
       fld('ApproverName','ผู้อนุมัติ (Approver)','text',{ph:'ชื่อผู้อนุมัติ'})+
     '</div>'+
     '<button type="submit" class="btn btn-pri" id="submitReq">&#9993; ส่งคำร้อง</button>'+
   '</form>';
  el('upBtn').addEventListener('click',function(){el('upFile').click();});
  el('upFile').addEventListener('change',function(e){var ff=e.target.files&&e.target.files[0];if(ff)uploadFile(ff,'DraftFileLink','upStatus');});
  el('genCodeBtn').addEventListener('click',genCode);
  el('reqForm').addEventListener('submit',function(e){
    e.preventDefault();
    var rec=collect(el('reqForm'));
    var miss=requiredMissing(el('reqForm'));
    if(miss){toast('กรุณากรอก: '+miss);return;}
    var btn=el('submitReq');btn.disabled=true;btn.textContent='กำลังส่ง…';
    api('POST','/requests',rec).then(function(){toast('ส่งคำร้องเรียบร้อย ✓');navigate('requests');})
      .catch(function(err){toast('ส่งไม่สำเร็จ: '+err.message);btn.disabled=false;btn.innerHTML='&#9993; ส่งคำร้อง';});
  });
}

/* ---------- field builders ---------- */
function fld(k,label,type,o){
  o=o||{};
  var req=o.req?' <span class="req">*</span>':'';
  var ph=o.ph?' placeholder="'+esc(o.ph)+'"':'';
  var val=o.val!=null?esc(o.val):'';
  var cls=o.mono?' class="mono"':'';
  var ctrl;
  if(type==='textarea')ctrl='<textarea data-f="'+k+'"'+(o.req?' data-req="'+esc(label)+'"':'')+ph+'>'+val+'</textarea>';
  else ctrl='<input type="'+type+'" data-f="'+k+'"'+cls+(o.req?' data-req="'+esc(label)+'"':'')+ph+' value="'+val+'">';
  return '<div class="fld"><label>'+esc(label)+req+'</label>'+ctrl+'</div>';
}
function fldSelect(k,label,opts,o){
  o=o||{};
  var req=o.req?' <span class="req">*</span>':'';
  var cur=o.val!=null?String(o.val):'';
  var options='<option value="" disabled'+(cur?'':' selected')+' hidden>— เลือก —</option>'+
    opts.map(function(x){return '<option'+(x===cur?' selected':'')+'>'+esc(x)+'</option>';}).join('');
  return '<div class="fld"><label>'+esc(label)+req+'</label><select data-f="'+k+'"'+(o.req?' data-req="'+esc(label)+'"':'')+'>'+options+'</select></div>';
}
function collect(form){
  var rec={};var els=form.querySelectorAll('[data-f]');
  for(var i=0;i<els.length;i++){var v=els[i].value;if(v!=='')rec[els[i].getAttribute('data-f')]=v;}
  return rec;
}
function requiredMissing(form){
  var els=form.querySelectorAll('[data-req]');var miss=[];
  for(var i=0;i<els.length;i++){if(!String(els[i].value||'').trim())miss.push(els[i].getAttribute('data-req'));}
  return miss.length?miss.join(', '):null;
}

/* ---------- MDL add/edit modal ---------- */
function openMdlForm(rec){
  rec=rec||{};
  var isNew=!rec.id;
  var body='<form id="mdlForm">'+
    fld('DocCode','รหัสเอกสาร','text',{req:1,mono:1,val:rec.DocCode,ph:'เช่น SOP-PD-001'})+
    fldSelect('DocType','ประเภทเอกสาร',DOCTYPES,{req:1,val:rec.DocType})+
    fld('DocName','ชื่อเอกสาร','text',{req:1,val:rec.DocName})+
    fldSelect('Department','แผนก',DEPTS,{val:rec.Department})+
    fld('OwnerName','ผู้รับผิดชอบ','text',{val:rec.OwnerName})+
    fld('Rev','Revision','text',{mono:1,val:rec.Rev})+
    fldSelect('Status','สถานะ',STATUSES,{val:rec.Status})+
    fld('EffectiveDate','วันบังคับใช้','date',{val:rec.EffectiveDate})+
    fld('NextReviewDate','ทบทวนครั้งถัดไป','date',{val:rec.NextReviewDate})+
    '<div class="fld"><label>เอกสารฉบับเต็ม (ฉบับอนุมัติ)</label>'+
      '<input type="url" data-f="FileLink" placeholder="วางลิงก์ หรือกดอัปโหลดไฟล์ฉบับเต็ม" value="'+esc(rec.FileLink||'')+'">'+
      '<div style="display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap">'+
        '<button type="button" class="btn btn-ghost btn-sm" id="upBtnM">📎 อัปโหลดเอกสารฉบับเต็ม</button>'+
        '<input type="file" id="upFileM" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg" style="display:none">'+
        '<span id="upStatusM" style="font-size:12.5px;color:var(--muted)">'+(rec.FileLink?'มีไฟล์แนบแล้ว':'')+'</span>'+
      '</div></div>'+
    fld('Notes','หมายเหตุ','textarea',{val:rec.Notes})+
    '<button type="submit" class="btn btn-pri" id="saveMdl" style="margin-top:6px">&#10003; บันทึก</button>'+
    (isNew?'':'<button type="button" class="btn btn-ghost" id="distMdl" style="margin-top:10px">📦 แจกจ่ายเอกสารนี้</button>')+
    (isNew?'':'<button type="button" class="btn btn-ghost" id="stampMdl" style="margin-top:10px">🔖 พิมพ์สแตมป์ “ต้นฉบับ”</button>')+
    (isNew?'':'<button type="button" class="btn btn-ghost" id="delMdl" style="margin-top:10px;color:var(--red-ink)">ลบเอกสารนี้</button>')+
   '</form>';
  openSheet(isNew?'เพิ่มเอกสารใหม่':'แก้ไขเอกสาร',body);
  el('upBtnM').addEventListener('click',function(){el('upFileM').click();});
  el('upFileM').addEventListener('change',function(e){var ff=e.target.files&&e.target.files[0];if(ff)uploadFile(ff,'FileLink','upStatusM');});
  if(!isNew)el('distMdl').addEventListener('click',function(){closeSheet();openDistForm({DocCode:rec.DocCode,DocName:rec.DocName,Rev:rec.Rev});});
  if(!isNew)el('stampMdl').addEventListener('click',function(){window.open('/stamp?type=original&code='+encodeURIComponent(rec.DocCode||'')+'&rev='+encodeURIComponent(rec.Rev||'')+'&key='+encodeURIComponent(KEY),'_blank');});
  el('mdlForm').addEventListener('submit',function(e){
    e.preventDefault();
    var miss=requiredMissing(el('mdlForm'));if(miss){toast('กรุณากรอก: '+miss);return;}
    var data=collect(el('mdlForm'));
    var btn=el('saveMdl');btn.disabled=true;btn.textContent='กำลังบันทึก…';
    var p=isNew?api('POST','/mdl',data):api('PUT','/mdl/'+rec.id,data);
    p.then(function(){closeSheet();toast('บันทึกแล้ว ✓');navigate('mdl');})
     .catch(function(err){toast('บันทึกไม่สำเร็จ: '+err.message);btn.disabled=false;btn.innerHTML='&#10003; บันทึก';});
  });
  if(!isNew)el('delMdl').addEventListener('click',function(){
    if(!confirm('ลบเอกสาร '+(rec.DocCode||'')+' ?'))return;
    api('DELETE','/mdl/'+rec.id).then(function(){closeSheet();toast('ลบแล้ว');navigate('mdl');}).catch(function(e){toast('ลบไม่สำเร็จ');});
  });
}

/* ---------- request detail / decision ---------- */
function openRequest(id){
  var r=ST.requests.filter(function(x){return x.id===id;})[0];if(!r)return;
  var body='<div class="kv"><b>เลขคำขอ</b><span class="mono">'+esc(r.RequestId||'—')+'</span></div>'+
    '<div class="kv"><b>รหัสเอกสาร</b><span class="mono">'+esc(r.DocCode||'—')+'</span></div>'+
    '<div class="kv"><b>ชื่อเอกสาร</b><span>'+esc(r.DocName||'—')+'</span></div>'+
    '<div class="kv"><b>ประเภทคำขอ</b><span>'+esc(r.ActionType||'—')+'</span></div>'+
    '<div class="kv"><b>ผู้ขอ</b><span>'+esc(r.RequesterName||'—')+' ('+esc(r.Department||'-')+')</span></div>'+
    '<div class="kv"><b>เหตุผล</b><span>'+esc(r.Reason||'—')+'</span></div>'+
    '<div class="kv"><b>วันที่คาดว่าจะเสร็จ</b><span>'+(r.ExpectedDate?fmtDate(r.ExpectedDate):'—')+'</span></div>'+
    (r.DraftFileLink?'<div class="kv"><b>ไฟล์ร่าง</b><a href="'+esc(r.DraftFileLink)+'" target="_blank" style="color:var(--blue)">เปิดไฟล์</a></div>':'')+
    '<div class="kv"><b>สถานะ</b><span>'+decBadge(r.Decision)+'</span></div>'+
    '<div style="margin-top:16px">'+fld('DecisionBy','ผู้ตัดสิน','text',{val:r.DecisionBy})+
      fld('Comment','ความเห็น','textarea',{val:r.Comment})+'</div>'+
    '<div style="display:flex;gap:8px;margin-top:6px">'+
      '<button class="btn btn-pri" id="appr" style="background:var(--green)">&#10003; อนุมัติ</button>'+
      '<button class="btn btn-pri" id="rej" style="background:var(--red)">&#10006; ปฏิเสธ</button></div>'+
    '<button class="btn btn-ghost" id="printDar" style="margin-top:10px">🖨️ พิมพ์ใบ DAR (FM-MR-01)</button>'+
    (r.Decision==='APPROVED'?'<button class="btn btn-ghost" id="distDoc" style="margin-top:10px">📦 แจกจ่ายเอกสารนี้</button>':'')+
    '<button class="btn btn-ghost" id="delReq" style="margin-top:10px;color:var(--red-ink)">ลบคำร้อง</button>';
  openSheet('รายละเอียดคำร้อง',body);
  el('printDar').addEventListener('click',function(){window.open('/dar/'+r.id+'?key='+encodeURIComponent(KEY),'_blank');});
  if(el('distDoc'))el('distDoc').addEventListener('click',function(){closeSheet();openDistForm({DocCode:r.DocCode,DocName:r.DocName});});
  var decide=function(dec){
    var data={Decision:dec,DecisionBy:el('modalRoot').querySelector('[data-f=DecisionBy]').value,
      Comment:el('modalRoot').querySelector('[data-f=Comment]').value,DecisionTime:new Date().toISOString()};
    api('PUT','/requests/'+r.id,data).then(function(){closeSheet();toast(dec==='APPROVED'?'อนุมัติแล้ว ✓':'ปฏิเสธแล้ว');navigate('requests');})
      .catch(function(e){toast('บันทึกไม่สำเร็จ: '+e.message);});
  };
  el('appr').addEventListener('click',function(){decide('APPROVED');});
  el('rej').addEventListener('click',function(){decide('REJECTED');});
  el('delReq').addEventListener('click',function(){
    if(!confirm('ลบคำร้องนี้?'))return;
    api('DELETE','/requests/'+r.id).then(function(){closeSheet();toast('ลบแล้ว');navigate('requests');}).catch(function(e){toast('ลบไม่สำเร็จ');});
  });
}

/* ---------- sheet/modal ---------- */
function openSheet(title,bodyHtml){
  el('modalRoot').innerHTML='<div class="overlay" id="ov"><div class="sheet"><div class="sheet-h"><h3>'+esc(title)+
    '</h3><button class="iconbtn" id="closeSheet">&#10005;</button></div>'+bodyHtml+'</div></div>';
  el('closeSheet').addEventListener('click',closeSheet);
  el('ov').addEventListener('mousedown',function(e){if(e.target.id==='ov')closeSheet();});
}
function closeSheet(){el('modalRoot').innerHTML='';}

function showErr(err){el('app').innerHTML='<div class="empty">โหลดข้อมูลไม่สำเร็จ<br><small>'+esc(err.message)+'</small></div>';}
function bindNavLinks(){
  var ls=el('app').querySelectorAll('[data-nav-link]');
  for(var i=0;i<ls.length;i++)ls[i].addEventListener('click',function(){navigate(this.getAttribute('data-nav-link'));});
}

/* ---------- wire up ---------- */
el('menuBtn').addEventListener('click',function(){openDrawer(!el('drawer').classList.contains('open'));});
el('scrim').addEventListener('click',function(){openDrawer(false);});
el('refreshBtn').addEventListener('click',function(){render();});
var navas=el('nav').querySelectorAll('a');
for(var i=0;i<navas.length;i++)navas[i].addEventListener('click',function(){navigate(this.getAttribute('data-nav'));});
if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){});}
setNav();
if(KEY){render();}else{showLogin();}
</script>
</body>
</html>`;

// ---- Submit-only page (/submit) for other departments: create requests only ----
const SUBMIT_HTML = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ยื่นคำร้องด้านเอกสาร · DAR</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#1f2a26;--muted:#7e8a83;--blue:#159a57;--grad:linear-gradient(135deg,#1fae5f,#0d9488);--grad-bar:linear-gradient(135deg,#15803d,#0f766e);--line:#e6efe9}
body{font-family:'Noto Sans Thai',system-ui,sans-serif;color:var(--ink);background:#eef4f0;background-image:linear-gradient(180deg,#eef6f0,#e3efe8);background-attachment:fixed;min-height:100vh;font-size:15px}
.mono{font-family:'IBM Plex Mono',monospace}
.bar{background:var(--grad-bar);color:#fff;padding:18px 16px}
.bar h1{font-size:19px;font-weight:700}.bar p{font-size:12.5px;color:#d7efe4;margin-top:3px}
.wrap{max-width:680px;margin:0 auto;padding:18px 14px 80px}
.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:16px;box-shadow:0 1px 2px rgba(20,30,60,.04);margin-bottom:14px}
.fsec-t{font-weight:700;font-size:14.5px;margin-bottom:10px;display:flex;gap:8px;align-items:center}
.num{width:22px;height:22px;border-radius:7px;background:#e4f5ec;color:var(--blue);font-size:12px;display:grid;place-items:center;font-weight:700}
.fld{margin-bottom:13px}.fld:last-child{margin-bottom:0}
label{display:block;font-size:13px;font-weight:600;color:#46504a;margin-bottom:6px}
label .req{color:#ef4444}
input,select,textarea{width:100%;font-family:inherit;font-size:14.5px;color:var(--ink);background:#fff;border:1px solid #dde1ea;border-radius:11px;padding:11px 13px;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(21,154,87,.18)}
textarea{resize:vertical;min-height:80px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;font-family:inherit;font-size:15px;font-weight:600;cursor:pointer;border-radius:12px;padding:13px;border:none}
.btn-pri{background:var(--grad);color:#fff}.btn-sm{width:auto;padding:8px 14px;font-size:13.5px;border-radius:10px;background:#eef1f5;color:var(--ink)}
.btn:disabled{opacity:.55}
.muted{font-size:12.5px;color:var(--muted)}
.ok{text-align:center;padding:40px 20px}
.ok .ic{font-size:54px}.ok h2{font-size:20px;margin:10px 0 6px;color:#15803d}
.ok .rid{font-family:'IBM Plex Mono',monospace;font-size:17px;font-weight:600;background:#e8f7ee;color:#15803d;display:inline-block;padding:6px 14px;border-radius:10px;margin:8px 0}
</style>
</head>
<body>
<div class="bar"><h1>ยื่นคำร้องด้านเอกสาร (DAR)</h1><p>สำหรับหน่วยงานที่ขอจัดทำ / แก้ไข / ยกเลิก / ขอใช้เอกสาร · ตาม QP-DC-01 (FM-MR-01)</p></div>
<div class="wrap" id="wrap">
  <form id="f">
    <div class="card"><div class="fsec-t"><span class="num">1</span>ข้อมูลผู้ร้องขอ</div>
      <div class="fld"><label>ชื่อ-นามสกุล ผู้ส่งคำร้อง <span class="req">*</span></label><input data-f="RequesterName" data-req="ชื่อผู้ส่งคำร้อง" placeholder="ชื่อ-นามสกุล"></div>
      <div class="fld"><label>อีเมลผู้ขอ (สำหรับรับแจ้งผล)</label><input type="email" data-f="RequesterEmail" placeholder="name@company.com"></div>
      <div class="fld"><label>แผนก (Department) <span class="req">*</span></label><select data-f="Department" data-req="แผนก"><option value="" disabled selected hidden>— เลือก —</option><option>QA</option><option>QC</option><option>PD</option><option>WH</option><option>HR</option><option>AC</option><option>PU</option><option>MN</option></select></div>
    </div>
    <div class="card"><div class="fsec-t"><span class="num">2</span>ประเภทคำขอ</div>
      <div class="fld"><label>ประเภทการดำเนินการ <span class="req">*</span></label><select data-f="ActionType" data-req="ประเภทคำขอ"><option value="" disabled selected hidden>— เลือก —</option><option>จัดทำเอกสารใหม่</option><option>ปรับปรุง/แก้ไขเอกสาร</option><option>ยกเลิกเอกสาร</option><option>ขอสำเนา/ขอใช้เอกสาร</option></select></div>
    </div>
    <div class="card"><div class="fsec-t"><span class="num">3</span>ข้อมูลเอกสาร</div>
      <div class="fld"><label>ประเภทเอกสาร <span class="req">*</span></label><select data-f="DocType" data-req="ประเภทเอกสาร"><option value="" disabled selected hidden>— เลือก —</option><option>QM</option><option>QP</option><option>WI</option><option>FM</option><option>SD</option></select></div>
      <div class="fld"><label>ชื่อเอกสาร (ไทย/อังกฤษ) <span class="req">*</span></label><input data-f="DocName" data-req="ชื่อเอกสาร" placeholder="เช่น ขั้นตอนการตรวจรับวัตถุดิบ"></div>
      <div class="fld"><label>รหัสเอกสาร</label><input class="mono" data-f="DocCode" placeholder="เช่น QP-QA-03 หรือกดออกเลข">
        <div style="display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap"><button type="button" class="btn btn-sm" id="genCodeBtn">🔢 ออกเลขอัตโนมัติ</button><span class="muted" id="codeStatus"></span></div></div>
      <div class="fld"><label>ไฟล์ฉบับร่าง (Draft File)</label><input type="url" data-f="DraftFileLink" placeholder="วางลิงก์ หรือกดอัปโหลด">
        <div style="display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap"><button type="button" class="btn btn-sm" id="upBtn">📎 อัปโหลดไฟล์</button><input type="file" id="upFile" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg" style="display:none"><span class="muted" id="upStatus"></span></div></div>
    </div>
    <div class="card"><div class="fsec-t"><span class="num">4</span>เหตุผลและการอนุมัติ</div>
      <div class="fld"><label>เหตุผลในการขอ <span class="req">*</span></label><textarea data-f="Reason" data-req="เหตุผล" placeholder="ระบุเหตุผลที่ต้องสร้างหรือแก้ไขเอกสาร"></textarea></div>
      <div class="fld"><label>วันที่คาดว่าจะแล้วเสร็จ (Target Date)</label><input type="date" data-f="ExpectedDate"></div>
      <div class="fld"><label>ผู้อนุมัติ (Approver)</label><input data-f="ApproverName" placeholder="ชื่อผู้อนุมัติ"></div>
    </div>
    <button type="submit" class="btn btn-pri" id="submitBtn">✉ ส่งคำร้อง</button>
    <p class="muted" style="text-align:center;margin-top:12px">คำร้องจะถูกส่งไปยังเจ้าหน้าที่ควบคุมเอกสาร (DCC) เพื่อพิจารณาตามขั้นตอน</p>
  </form>
</div>
<script>
function el(id){return document.getElementById(id);}
if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){});}
function api(method,path,body){return fetch(path,{method:method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j&&j.error?j.error:('HTTP '+r.status));return j;});});}
function collect(){var rec={};var els=document.querySelectorAll('[data-f]');for(var i=0;i<els.length;i++){var v=els[i].value;if(v!=='')rec[els[i].getAttribute('data-f')]=v;}return rec;}
function missing(){var els=document.querySelectorAll('[data-req]');var m=[];for(var i=0;i<els.length;i++){if(!String(els[i].value||'').trim())m.push(els[i].getAttribute('data-req'));}return m;}
function genCode(){var t=document.querySelector('[data-f=DocType]'),d=document.querySelector('[data-f=Department]'),st=el('codeStatus');var type=t.value,dept=d.value;if(!type||!dept){st.textContent='เลือกประเภทเอกสาร + แผนกก่อน';return;}st.textContent='กำลังออกเลข…';fetch('/api/nextcode?type='+encodeURIComponent(type)+'&dept='+encodeURIComponent(dept)).then(function(r){return r.json();}).then(function(j){if(j&&j.code){document.querySelector('[data-f=DocCode]').value=j.code;st.textContent='✓ ออกเลขให้แล้ว';}else st.textContent='ออกเลขไม่สำเร็จ';}).catch(function(){st.textContent='ออกเลขไม่สำเร็จ';});}
function uploadFile(file){var st=el('upStatus');if(file.size>25*1024*1024){st.textContent='ไฟล์ใหญ่เกิน 25MB';return;}st.textContent='กำลังอัปโหลด… '+file.name;fetch('/api/upload?name='+encodeURIComponent(file.name),{method:'POST',headers:{'content-type':file.type||'application/octet-stream'},body:file}).then(function(r){return r.json();}).then(function(j){if(j&&j.url){document.querySelector('[data-f=DraftFileLink]').value=j.url;st.textContent='✓ แนบแล้ว: '+file.name;}else st.textContent='อัปโหลดไม่สำเร็จ';}).catch(function(){st.textContent='อัปโหลดไม่สำเร็จ';});}
el('genCodeBtn').addEventListener('click',genCode);
el('upBtn').addEventListener('click',function(){el('upFile').click();});
el('upFile').addEventListener('change',function(e){var ff=e.target.files&&e.target.files[0];if(ff)uploadFile(ff);});
el('f').addEventListener('submit',function(e){e.preventDefault();var miss=missing();if(miss.length){alert('กรุณากรอก: '+miss.join(', '));return;}var btn=el('submitBtn');btn.disabled=true;btn.textContent='กำลังส่ง…';api('POST','/api/requests',collect()).then(function(j){el('wrap').innerHTML='<div class="card ok"><div class="ic">✅</div><h2>ส่งคำร้องเรียบร้อย</h2><div class="muted">เลขที่คำร้องของคุณ</div><div class="rid">'+(j.RequestId||'-')+'</div><div class="muted">เจ้าหน้าที่ควบคุมเอกสารจะพิจารณาตามขั้นตอน QP-DC-01</div><div style="margin-top:18px"><button class="btn btn-pri" onclick="location.reload()">+ ส่งคำร้องใหม่</button></div></div>';window.scrollTo(0,0);}).catch(function(err){alert('ส่งไม่สำเร็จ: '+err.message);btn.disabled=false;btn.textContent='✉ ส่งคำร้อง';});});
</script>
</body>
</html>`;

// ---- PWA assets (install as a desktop/mobile app) ----
const MANIFEST_JSON = JSON.stringify({
  name: 'DCC — ระบบควบคุมเอกสาร',
  short_name: 'DCC',
  description: 'Document Control Center · Sorworaphat InterFoods',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#eef4f0',
  theme_color: '#15803d',
  lang: 'th',
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/icon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
  ],
});

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1fae5f"/><stop offset="1" stop-color="#0d9488"/></linearGradient></defs>
<rect width="512" height="512" rx="112" fill="url(#g)"/>
<rect x="150" y="120" width="212" height="272" rx="20" fill="#ffffff"/>
<rect x="186" y="170" width="140" height="16" rx="8" fill="#cfe9da"/>
<rect x="186" y="208" width="140" height="16" rx="8" fill="#cfe9da"/>
<rect x="186" y="246" width="92" height="16" rx="8" fill="#cfe9da"/>
<circle cx="320" cy="330" r="58" fill="#15803d"/>
<path d="M296 330 l18 18 l34 -38" fill="none" stroke="#ffffff" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const SW_JS = `const C='dcc-v1';
self.addEventListener('install',function(e){self.skipWaiting();});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});
self.addEventListener('fetch',function(e){
  var req=e.request;
  if(req.method!=='GET')return;
  e.respondWith(
    fetch(req).then(function(r){
      if(r&&r.status===200&&r.type==='basic'){var cp=r.clone();caches.open(C).then(function(c){c.put(req,cp);});}
      return r;
    }).catch(function(){return caches.match(req);})
  );
});`;
