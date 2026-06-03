/* ============================================================
   Document Control System — Cloudflare Worker (UI + API on D1)
   - Serves the data-entry web app at "/"
   - REST API at "/api/:sheet" backed by D1 binding `DB`
   Deploy: wrangler deploy   (see wrangler.toml)
   ============================================================ */

const TABLES = {
  mdl: {
    table: "mdl",
    cols: ["DocCode","DocType","DocName","Department","OwnerName","OwnerEmail","ApproverName","ApproverEmail","Rev","Status","IssueDate","EffectiveDate","NextReviewDate","Keyword","FileLink","Notes"],
    order: "DocCode COLLATE NOCASE ASC",
  },
  approval: {
    table: "approval_log",
    cols: ["Timestamp","RequestId","DocCode","RequestedRev","RequesterName","RequesterEmail","ApproverName","ApproverEmail","DraftFileLink","Reason","Decision","DecisionBy","DecisionTime","Comment"],
    order: "updated_at DESC",
  },
  ack: {
    table: "ack_log",
    cols: ["Timestamp","EmployeeName","EmployeeEmail","Department","DocCode","Rev","Confirm","Method","Notes"],
    order: "updated_at DESC",
  },
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json;charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
    },
  });

async function handleApi(request, env, parts) {
  // optional shared-secret gate: set AUTH_TOKEN secret to enable
  if (env.AUTH_TOKEN) {
    const auth = request.headers.get("authorization") || "";
    if (auth !== "Bearer " + env.AUTH_TOKEN) return json({ error: "unauthorized" }, 401);
  }
  const sheet = parts[1];
  const id = parts[2];
  const cfg = TABLES[sheet];
  if (!cfg) return json({ error: "unknown sheet" }, 404);
  const m = request.method;

  if (m === "POST" && id === "bulk") {
    const body = await request.json().catch(() => ({}));
    const rowsIn = Array.isArray(body.rows) ? body.rows : [];
    const key = body.key && cfg.cols.includes(body.key) ? body.key : null;
    const now = new Date().toISOString();
    const existing = {};
    if (key) {
      const { results } = await env.DB.prepare(
        "SELECT id," + key + " AS k FROM " + cfg.table
      ).all();
      (results || []).forEach((r) => { if (r.k != null) existing[String(r.k)] = r.id; });
    }
    const stmts = [];
    let ins = 0, upd = 0;
    for (const row of rowsIn) {
      const present = cfg.cols.filter((c) => c in row);
      if (!present.length) continue;
      const keyVal = key ? row[key] : null;
      const foundId = key && keyVal != null ? existing[String(keyVal)] : null;
      if (foundId) {
        const sets = [...present.map((c) => c + "=?"), "updated_at=?"];
        const vals = [...present.map((c) => row[c] ?? null), now, foundId];
        stmts.push(env.DB.prepare("UPDATE " + cfg.table + " SET " + sets.join(",") + " WHERE id=?").bind(...vals));
        upd++;
      } else {
        const rid = crypto.randomUUID();
        const fields = ["id", ...present, "updated_at"];
        const vals = [rid, ...present.map((c) => row[c] ?? null), now];
        const ph = fields.map(() => "?").join(",");
        stmts.push(env.DB.prepare("INSERT INTO " + cfg.table + " (" + fields.join(",") + ") VALUES (" + ph + ")").bind(...vals));
        ins++;
        if (key && keyVal != null) existing[String(keyVal)] = rid;
      }
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ inserted: ins, updated: upd, total: stmts.length });
  }

  if (m === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM " + cfg.table + " ORDER BY " + cfg.order
    ).all();
    return json(results || []);
  }

  if (m === "POST" || m === "PUT") {
    const body = await request.json().catch(() => ({}));
    const rid = m === "PUT" ? id : (body.id || crypto.randomUUID());
    const now = new Date().toISOString();
    const present = cfg.cols.filter((c) => c in body);

    if (m === "POST") {
      const fields = ["id", ...present, "updated_at"];
      const vals = [rid, ...present.map((c) => body[c] ?? null), now];
      const ph = fields.map(() => "?").join(",");
      await env.DB.prepare(
        "INSERT INTO " + cfg.table + " (" + fields.join(",") + ") VALUES (" + ph + ")"
      ).bind(...vals).run();
    } else {
      const sets = [...present.map((c) => c + "=?"), "updated_at=?"];
      const vals = [...present.map((c) => body[c] ?? null), now, rid];
      await env.DB.prepare(
        "UPDATE " + cfg.table + " SET " + sets.join(",") + " WHERE id=?"
      ).bind(...vals).run();
    }
    const { results } = await env.DB.prepare(
      "SELECT * FROM " + cfg.table + " WHERE id=?"
    ).bind(rid).all();
    return json((results && results[0]) || { id: rid });
  }

  if (m === "DELETE") {
    await env.DB.prepare("DELETE FROM " + cfg.table + " WHERE id=?").bind(id).run();
    return json({ ok: true, id });
  }
  return json({ error: "method not allowed" }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return json({}, 204);
    const parts = url.pathname.split("/").filter(Boolean); // ["api","mdl","<id>"]
    if (parts[0] === "api") return handleApi(request, env, parts);
    return new Response(PAGE, {
      headers: { "content-type": "text/html;charset=utf-8" },
    });
  },
};

/* ===========================  FRONTEND  =========================== */
const PAGE = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ระบบควบคุมเอกสาร · Document Control System</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --paper:#E9E3D6;--surface:#FBFAF5;--surface2:#F2EEE3;--ink:#211E18;--ink-soft:#6A6356;
  --line:#D6CFBE;--line-strong:#C3BAA4;--accent:#BE3A2B;--accent-ink:#962A1F;
  --green:#2E7D52;--amber:#B07A1E;--slate:#6E6757;
}
body{font-family:'IBM Plex Sans Thai',system-ui,sans-serif;color:var(--ink);background:var(--paper);
  background-image:radial-gradient(var(--line) .7px,transparent .7px);background-size:22px 22px;min-height:100vh;
  -webkit-font-smoothing:antialiased}
.mono{font-family:'IBM Plex Mono',monospace;font-feature-settings:"tnum"}
.wrap{max-width:1240px;margin:0 auto;padding:26px 22px 70px}
.head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;border-bottom:2px solid var(--ink);padding-bottom:16px}
.title{display:flex;align-items:center;gap:14px}
.mark{width:46px;height:46px;border:2px solid var(--ink);display:grid;place-items:center;background:var(--accent);color:#fff;font-size:22px}
.h1{font-size:21px;font-weight:700;letter-spacing:.3px;line-height:1.1}
.sub{font-size:11px;letter-spacing:3px;text-transform:uppercase;color:var(--ink-soft);font-family:'IBM Plex Mono',monospace;margin-top:3px}
.stamp{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:1px;border:1.5px solid var(--accent);color:var(--accent);
  padding:7px 11px;border-radius:3px;transform:rotate(-4deg);text-align:center;line-height:1.5;opacity:.85}
.dbtag{font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:var(--ink-soft);margin-top:6px}
.dbdot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--green);margin-right:5px;vertical-align:1px}
.tabs{display:flex;gap:4px;margin:18px 0 14px;flex-wrap:wrap}
.tab{display:flex;align-items:center;gap:8px;border:1.5px solid var(--line-strong);border-bottom:none;background:var(--surface2);
  color:var(--ink-soft);padding:10px 16px;font-size:13.5px;font-weight:600;cursor:pointer;border-radius:7px 7px 0 0;position:relative;top:1px;
  transition:all .15s;font-family:inherit}
.tab:hover{color:var(--ink);background:var(--surface)}
.tab.on{background:var(--surface);color:var(--ink);border-color:var(--ink);box-shadow:0 -2px 0 var(--accent) inset}
.tab .cnt{font-family:'IBM Plex Mono',monospace;font-size:11px;background:var(--ink);color:#fff;padding:1px 7px;border-radius:10px;font-weight:500}
.tab.on .cnt{background:var(--accent)}
.panel{background:var(--surface);border:1.5px solid var(--ink);border-radius:0 8px 8px 8px;padding:18px;box-shadow:6px 6px 0 rgba(33,30,24,.07)}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.stat{flex:1;min-width:130px;border:1px solid var(--line-strong);background:var(--surface2);padding:12px 14px;border-radius:6px}
.stat .n{font-family:'IBM Plex Mono',monospace;font-size:26px;font-weight:600;line-height:1}
.stat .t{font-size:11.5px;color:var(--ink-soft);margin-top:5px;letter-spacing:.4px}
.stat .bar{height:3px;margin-top:9px;background:var(--accent);border-radius:2px;transition:width .4s}
.tools{display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap}
.search{flex:1;min-width:200px;display:flex;align-items:center;gap:8px;background:var(--surface2);border:1px solid var(--line-strong);border-radius:6px;padding:9px 12px}
.search input{border:none;background:none;outline:none;font-size:14px;width:100%;font-family:inherit;color:var(--ink)}
.btn{display:inline-flex;align-items:center;gap:7px;font-family:inherit;font-size:13.5px;font-weight:600;cursor:pointer;border-radius:6px;
  padding:9px 15px;border:1.5px solid transparent;transition:transform .12s,background .15s}
.btn:active{transform:translateY(1px)}
.btn-pri{background:var(--accent);color:#fff;border-color:var(--accent-ink);box-shadow:0 2px 0 var(--accent-ink)}
.btn-pri:hover{background:var(--accent-ink)}
.btn-ghost{background:var(--surface2);color:var(--ink);border-color:var(--line-strong)}
.btn-ghost:hover{background:#fff;border-color:var(--ink-soft)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.tablewrap{overflow-x:auto;border:1px solid var(--line-strong);border-radius:7px}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:560px}
thead th{text-align:left;background:var(--ink);color:#F3EEE2;padding:10px 12px;font-weight:600;font-size:11.5px;letter-spacing:.6px;text-transform:uppercase;white-space:nowrap}
tbody td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr{background:var(--surface);transition:background .12s}
tbody tr:nth-child(even){background:var(--surface2)}
tbody tr:hover{background:#FFF8E8}
tbody tr:hover .act{opacity:1}
.act{display:flex;gap:6px;opacity:.25;transition:opacity .15s;justify-content:flex-end}
.ic{border:1px solid var(--line-strong);background:var(--surface);border-radius:5px;width:30px;height:30px;display:inline-grid;place-items:center;cursor:pointer;color:var(--ink-soft);transition:all .12s;font-size:14px}
.ic:hover{color:var(--accent);border-color:var(--accent)}
.ic.del:hover{color:#fff;background:var(--accent);border-color:var(--accent)}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;letter-spacing:.3px;white-space:nowrap;border:1px solid}
.b-green{color:var(--green);border-color:var(--green);background:#E7F2EC}
.b-amber{color:var(--amber);border-color:var(--amber);background:#F8F0DC}
.b-red{color:var(--accent);border-color:var(--accent);background:#F8E5E1}
.b-slate{color:var(--slate);border-color:var(--slate);background:#EEEBE2}
.empty{text-align:center;padding:46px 20px;color:var(--ink-soft)}
.note{font-size:12px;color:var(--ink-soft);line-height:1.7;margin-top:14px;border-left:3px solid var(--accent);padding:4px 0 4px 12px}
.overlay{position:fixed;inset:0;background:rgba(28,25,20,.45);display:flex;align-items:flex-start;justify-content:center;padding:30px 16px;z-index:50;overflow-y:auto}
.modal{background:var(--surface);border:2px solid var(--ink);border-radius:9px;width:100%;max-width:820px;box-shadow:10px 10px 0 rgba(33,30,24,.18)}
.mhead{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1.5px solid var(--ink);background:var(--surface2);border-radius:7px 7px 0 0}
.mhead h3{font-size:16px;font-weight:700}
.form{padding:20px;display:grid;grid-template-columns:1fr 1fr;gap:14px 16px}
.fld{display:flex;flex-direction:column;gap:5px}
.fld.wide{grid-column:1/-1}
.fld label{font-size:12px;font-weight:600;color:var(--ink-soft)}
.fld label .req{color:var(--accent)}
.fld input,.fld select,.fld textarea{font-family:inherit;font-size:14px;color:var(--ink);border:1px solid var(--line-strong);background:#fff;border-radius:6px;padding:9px 11px;outline:none;transition:border .12s,box-shadow .12s;width:100%}
.fld input:focus,.fld select:focus,.fld textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(190,58,43,.12)}
.fld textarea{resize:vertical;min-height:62px}
.fld .derived{font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:var(--ink-soft);background:var(--surface2);border-style:dashed}
.mfoot{display:flex;justify-content:flex-end;gap:10px;padding:16px 20px;border-top:1.5px solid var(--line);background:var(--surface2);border-radius:0 0 7px 7px}
@media(max-width:640px){.form{grid-template-columns:1fr}.fld.wide{grid-column:auto}}
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <div class="title">
      <div class="mark">&#9635;</div>
      <div>
        <div class="h1">ระบบควบคุมเอกสาร</div>
        <div class="sub">Document Control System</div>
        <div class="dbtag"><span class="dbdot"></span>Cloudflare D1 · dcs_document_control</div>
      </div>
    </div>
    <div class="stamp">CONTROLLED<br>DOCUMENT<br>ISO&nbsp;9001</div>
  </div>
  <div class="tabs" id="tabs"></div>
  <div class="panel">
    <div class="stats" id="stats"></div>
    <div class="tools">
      <div class="search">&#128269;<input id="q" placeholder="ค้นหา…"></div>
      <input type="file" id="importFile" accept=".csv,text/csv" style="display:none">
      <button class="btn btn-ghost" id="importBtn">&#11014; Import CSV</button>
      <button class="btn btn-ghost" id="exportBtn">&#11015; Export CSV</button>
      <button class="btn btn-pri" id="addBtn">&#43; เพิ่มรายการ</button>
    </div>
    <div class="tablewrap"><table><thead id="thead"></thead><tbody id="tbody"></tbody></table></div>
    <div class="note">ข้อมูลทั้งหมดถูกบันทึกบน <b>Cloudflare D1</b> (ฐานข้อมูลกลาง) แบบเรียลไทม์ · คอลัมน์ตรงกับ template ทุกตัว · กด <b>Export CSV</b> เพื่อนำไปวางในไฟล์ต้นฉบับได้</div>
  </div>
</div>
<div id="modalRoot"></div>

<script>
var API='/api';
var S={
 mdl:{label:'ทะเบียนเอกสารหลัก',sub:'Master Document List',icon:'&#128196;',keyName:'DocCode',statusField:'Status',importKey:'DocCode',
  cols:['DocCode','DocType','DocName','Department','Rev','Status','EffectiveDate'],
  order:['DocCode','DocType','DocName','Department','OwnerName','OwnerEmail','ApproverName','ApproverEmail','Rev','Status','IssueDate','EffectiveDate','NextReviewDate','Keyword','FileId','FileLink','Notes'],
  fields:[
   {k:'DocCode',l:'รหัสเอกสาร / Doc Code',t:'text',req:1,mono:1},
   {k:'DocType',l:'ประเภท / Type',t:'select',opts:['POL','QP','WI','FM','SD','HACCP','OTHER'],req:1},
   {k:'DocName',l:'ชื่อเอกสาร / Document Name',t:'text',req:1,wide:1},
   {k:'Department',l:'แผนก / Department',t:'text'},
   {k:'OwnerName',l:'ผู้รับผิดชอบ / Owner',t:'text'},
   {k:'OwnerEmail',l:'อีเมลผู้รับผิดชอบ',t:'email'},
   {k:'ApproverName',l:'ผู้อนุมัติ / Approver',t:'text'},
   {k:'ApproverEmail',l:'อีเมลผู้อนุมัติ',t:'email'},
   {k:'Rev',l:'Revision',t:'text',mono:1},
   {k:'Status',l:'สถานะ / Status',t:'select',opts:['Draft','Pending Approval','Active','Obsolete']},
   {k:'IssueDate',l:'วันที่ออก / Issue Date',t:'date'},
   {k:'EffectiveDate',l:'วันบังคับใช้ / Effective',t:'date'},
   {k:'NextReviewDate',l:'ทบทวนครั้งถัดไป / Next Review',t:'date'},
   {k:'Keyword',l:'คำค้น / Keyword',t:'text',wide:1},
   {k:'FileLink',l:'ลิงก์ไฟล์ / File Link',t:'url',wide:1},
   {k:'FileId',l:'File ID (อัตโนมัติ)',t:'derived',from:'FileLink'},
   {k:'Notes',l:'หมายเหตุ / Notes',t:'textarea',wide:1}
  ]},
 approval:{label:'บันทึกคำขออนุมัติ',sub:'Approval Log',icon:'&#128203;',keyName:'RequestId',statusField:'Decision',importKey:'RequestId',
  defaults:{Decision:'PENDING'},
  cols:['RequestId','DocCode','RequestedRev','RequesterName','Decision','Timestamp'],
  order:['Timestamp','RequestId','DocCode','RequestedRev','RequesterName','RequesterEmail','ApproverName','ApproverEmail','DraftFileLink','DraftFileId','Reason','Decision','DecisionBy','DecisionTime','Comment'],
  fields:[
   {k:'Timestamp',l:'เวลาบันทึก / Timestamp',t:'autotime'},
   {k:'RequestId',l:'เลขคำขอ / Request ID',t:'autoid',mono:1},
   {k:'DocCode',l:'รหัสเอกสาร / Doc Code',t:'doccode',req:1,mono:1},
   {k:'RequestedRev',l:'Revision ที่ขอ',t:'text',mono:1},
   {k:'RequesterName',l:'ผู้ขอ / Requester',t:'text',req:1},
   {k:'RequesterEmail',l:'อีเมลผู้ขอ',t:'email'},
   {k:'ApproverName',l:'ผู้อนุมัติ / Approver',t:'text'},
   {k:'ApproverEmail',l:'อีเมลผู้อนุมัติ',t:'email'},
   {k:'DraftFileLink',l:'ลิงก์ไฟล์ร่าง / Draft Link',t:'url',wide:1},
   {k:'DraftFileId',l:'Draft File ID (อัตโนมัติ)',t:'derived',from:'DraftFileLink'},
   {k:'Reason',l:'เหตุผล / Reason',t:'textarea',wide:1},
   {k:'Decision',l:'ผลการพิจารณา / Decision',t:'select',opts:['PENDING','APPROVED','REJECTED']},
   {k:'DecisionBy',l:'ผู้ตัดสิน / Decision By',t:'text'},
   {k:'DecisionTime',l:'เวลาตัดสิน / Decision Time',t:'date'},
   {k:'Comment',l:'ความเห็น / Comment',t:'textarea',wide:1}
  ]},
 ack:{label:'บันทึกรับทราบ',sub:'Acknowledgement · ISO 9001',icon:'&#9745;',keyName:'DocCode',statusField:'Confirm',importKey:'',
  defaults:{Confirm:'YES',Method:'WebApp'},
  cols:['EmployeeName','Department','DocCode','Rev','Confirm','Timestamp'],
  order:['Timestamp','EmployeeName','EmployeeEmail','Department','DocCode','Rev','Confirm','Method','Notes'],
  fields:[
   {k:'Timestamp',l:'เวลาบันทึก / Timestamp',t:'autotime'},
   {k:'EmployeeName',l:'ชื่อพนักงาน / Employee',t:'text',req:1},
   {k:'EmployeeEmail',l:'อีเมลพนักงาน',t:'email'},
   {k:'Department',l:'แผนก / Department',t:'text'},
   {k:'DocCode',l:'รหัสเอกสาร / Doc Code',t:'doccode',req:1,mono:1},
   {k:'Rev',l:'Revision',t:'text',mono:1},
   {k:'Confirm',l:'ยืนยันรับทราบ / Confirm',t:'select',opts:['YES','NO']},
   {k:'Method',l:'ช่องทาง / Method',t:'select',opts:['Form','WebApp','Training','Other']},
   {k:'Notes',l:'หมายเหตุ / Notes',t:'textarea',wide:1}
  ]}
};
var ST={tab:'mdl',data:{mdl:[],approval:[],ack:[]},query:'',editing:null,loaded:false};

function deriveFileId(link){if(!link)return '';var i=link.indexOf('/d/');return i<0?'':link.substring(i+3,i+3+33);}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function genReqId(){var d=new Date();var y=''+d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0');return 'REQ-'+y+'-'+Math.random().toString(36).slice(2,6).toUpperCase();}
function fmtTime(v){if(!v)return '—';var d=new Date(v);if(isNaN(d))return v;var s=d.toLocaleDateString('th-TH',{year:'numeric',month:'short',day:'numeric'});if(String(v).indexOf('T')>0)s+=' '+d.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'});return s;}
function badge(v){var m={Active:'b-green',APPROVED:'b-green',YES:'b-green','Pending Approval':'b-amber',PENDING:'b-amber',Draft:'b-amber',Obsolete:'b-slate',REJECTED:'b-red',NO:'b-red'};return 'badge '+(m[v]||'b-slate');}

async function api(method,path,body){
  var o={method:method,headers:{'content-type':'application/json'}};
  if(body)o.body=JSON.stringify(body);
  var r=await fetch(API+path,o);
  if(!r.ok)throw new Error('API '+r.status);
  return r.json();
}
async function loadAll(){
  try{
    var res=await Promise.all([api('GET','/mdl'),api('GET','/approval'),api('GET','/ack')]);
    ST.data={mdl:res[0],approval:res[1],ack:res[2]};ST.loaded=true;render();
  }catch(e){ST.loaded=true;document.getElementById('tbody').innerHTML='<tr><td class="empty">เชื่อมต่อฐานข้อมูลไม่สำเร็จ: '+esc(e.message)+'</td></tr>';}
}

function rows(){
  var arr=ST.data[ST.tab],q=ST.query.trim().toLowerCase();
  if(!q)return arr;
  return arr.filter(function(r){return Object.keys(r).some(function(k){return String(r[k]==null?'':r[k]).toLowerCase().indexOf(q)>=0;});});
}

function renderTabs(){
  var h='';Object.keys(S).forEach(function(k){var s=S[k];
   h+='<button class="tab'+(ST.tab===k?' on':'')+'" data-tab="'+k+'">'+s.icon+' '+s.label+'<span class="cnt">'+ST.data[k].length+'</span></button>';});
  document.getElementById('tabs').innerHTML=h;
}
function renderStats(){
  var d=ST.data[ST.tab],n=d.length,out=[];
  function c(field,val){return d.filter(function(r){return r[field]===val;}).length;}
  if(ST.tab==='mdl')out=[[n,'เอกสารทั้งหมด'],[c('Status','Active'),'ใช้งาน (Active)'],[c('Status','Pending Approval')+c('Status','Draft'),'รอ/ร่าง'],[c('Status','Obsolete'),'ยกเลิก']];
  else if(ST.tab==='approval')out=[[n,'คำขอทั้งหมด'],[c('Decision','PENDING'),'รอพิจารณา'],[c('Decision','APPROVED'),'อนุมัติ'],[c('Decision','REJECTED'),'ไม่อนุมัติ']];
  else{var y=c('Confirm','YES');out=[[n,'บันทึกทั้งหมด'],[y,'ยืนยันแล้ว'],[n-y,'ยังไม่ยืนยัน'],[new Set(d.map(function(r){return r.DocCode;})).size,'เอกสารเกี่ยวข้อง']];}
  var h='';out.forEach(function(o){var w=n?Math.max(8,(o[0]/Math.max(1,n))*100):8;
   h+='<div class="stat"><div class="n mono">'+o[0]+'</div><div class="t">'+o[1]+'</div><div class="bar" style="width:'+w+'%"></div></div>';});
  document.getElementById('stats').innerHTML=h;
}
function renderTable(){
  var s=S[ST.tab],list=rows();
  document.getElementById('thead').innerHTML='<tr>'+s.cols.map(function(c){return '<th>'+c+'</th>';}).join('')+'<th style="width:80px;text-align:right">จัดการ</th></tr>';
  var tb=document.getElementById('tbody');
  if(!ST.loaded){tb.innerHTML='<tr><td class="empty mono" colspan="'+(s.cols.length+1)+'">กำลังโหลด…</td></tr>';return;}
  if(!list.length){tb.innerHTML='<tr><td class="empty" colspan="'+(s.cols.length+1)+'">'+(ST.query?'ไม่พบรายการที่ค้นหา':'ยังไม่มีข้อมูล — กด “เพิ่มรายการ”')+'</td></tr>';return;}
  tb.innerHTML=list.map(function(r){
    var tds=s.cols.map(function(c){
      var f=s.fields.filter(function(x){return x.k===c;})[0];var v=r[c];
      if(c===s.statusField&&v)return '<td><span class="'+badge(v)+'">'+esc(v)+'</span></td>';
      if(f&&(f.t==='date'||f.t==='autotime'))v=fmtTime(v);
      var mono=f&&(f.mono||f.t==='autoid');
      return '<td class="'+(mono?'mono':'')+'">'+esc(v||'—')+'</td>';
    }).join('');
    return '<tr>'+tds+'<td><div class="act"><button class="ic" data-edit="'+r.id+'">&#9998;</button><button class="ic del" data-del="'+r.id+'">&#128465;</button></div></td></tr>';
  }).join('');
}
function render(){renderTabs();renderStats();renderTable();}

function openForm(rec,isNew){
  ST.editing={rec:Object.assign({},rec),isNew:isNew};
  var s=S[ST.tab];
  var codes=ST.data.mdl.map(function(r){return r.DocCode;}).filter(Boolean);
  var fields=s.fields.map(function(f){
    var val=ST.editing.rec[f.k]==null?'':ST.editing.rec[f.k];
    var wide=(f.wide||f.t==='textarea')?' wide':'';
    var ctrl='';
    if(f.t==='select'){
      ctrl='<select data-f="'+f.k+'">'+(val?'':'<option value="" disabled selected hidden>— เลือก —</option>')+f.opts.map(function(o){return '<option'+(o===val?' selected':'')+'>'+o+'</option>';}).join('')+'</select>';
    }else if(f.t==='textarea'){ctrl='<textarea data-f="'+f.k+'">'+esc(val)+'</textarea>';}
    else if(f.t==='date'){ctrl='<input type="date" data-f="'+f.k+'" value="'+esc(val)+'">';}
    else if(f.t==='derived'){ctrl='<input class="derived" readonly data-derived="'+f.from+'" value="'+esc(deriveFileId(ST.editing.rec[f.from])||'— วางลิงก์เพื่อดึงอัตโนมัติ —')+'">';}
    else if(f.t==='autotime'){ctrl='<input class="derived" readonly value="'+esc(val?fmtTime(val):'— บันทึกเมื่อกดบันทึก —')+'">';}
    else if(f.t==='autoid'){ctrl='<input class="derived" readonly value="'+esc(val||'— สร้างอัตโนมัติ —')+'">';}
    else if(f.t==='doccode'){ctrl='<input list="dclist" class="mono" data-f="'+f.k+'" value="'+esc(val)+'" placeholder="เลือกหรือพิมพ์รหัส">';}
    else{ctrl='<input type="'+(f.t==='email'?'email':f.t==='url'?'url':'text')+'" class="'+(f.mono?'mono':'')+'" data-f="'+f.k+'" value="'+esc(val)+'">';}
    return '<div class="fld'+wide+'"><label>'+f.l+(f.req?' <span class="req">*</span>':'')+'</label>'+ctrl+'</div>';
  }).join('');
  document.getElementById('modalRoot').innerHTML=
   '<div class="overlay" id="ov"><div class="modal"><div class="mhead"><h3>'+s.icon+' '+(isNew?'เพิ่มรายการใหม่':'แก้ไขรายการ')+' <span class="mono" style="font-size:11px;color:var(--ink-soft)"> · '+s.sub+'</span></h3><button class="ic" id="closeBtn">&#10005;</button></div>'+
   '<div class="form">'+fields+'</div>'+
   '<datalist id="dclist">'+codes.map(function(c){return '<option value="'+esc(c)+'">';}).join('')+'</datalist>'+
   '<div class="mfoot"><button class="btn btn-ghost" id="cancelBtn">ยกเลิก</button><button class="btn btn-pri" id="saveBtn">&#10003; บันทึก</button></div></div></div>';
  // live derived update
  document.querySelectorAll('[data-f]').forEach(function(el){el.addEventListener('input',function(){
    var dv=document.querySelector('[data-derived="'+el.getAttribute('data-f')+'"]');
    if(dv)dv.value=deriveFileId(el.value)||'— วางลิงก์เพื่อดึงอัตโนมัติ —';
  });});
  document.getElementById('closeBtn').onclick=closeForm;
  document.getElementById('cancelBtn').onclick=closeForm;
  document.getElementById('ov').onmousedown=function(e){if(e.target.id==='ov')closeForm();};
  document.getElementById('saveBtn').onclick=saveForm;
}
function closeForm(){ST.editing=null;document.getElementById('modalRoot').innerHTML='';}

async function saveForm(){
  var s=S[ST.tab],rec=ST.editing.rec;
  document.querySelectorAll('[data-f]').forEach(function(el){rec[el.getAttribute('data-f')]=el.value;});
  var miss=s.fields.filter(function(f){return f.req&&!String(rec[f.k]||'').trim();});
  if(miss.length){alert('กรุณากรอก: '+miss.map(function(f){return f.l.split(' / ')[0];}).join(', '));return;}
  s.fields.forEach(function(f){if(f.t==='autotime'&&!rec[f.k])rec[f.k]=new Date().toISOString();if(f.t==='autoid'&&!rec[f.k])rec[f.k]=genReqId();});
  var btn=document.getElementById('saveBtn');btn.disabled=true;btn.textContent='กำลังบันทึก…';
  try{
    var saved;
    if(ST.editing.isNew){saved=await api('POST','/'+ST.tab,rec);ST.data[ST.tab].push(saved);}
    else{saved=await api('PUT','/'+ST.tab+'/'+rec.id,rec);ST.data[ST.tab]=ST.data[ST.tab].map(function(r){return r.id===saved.id?saved:r;});}
    closeForm();render();
  }catch(e){alert('บันทึกไม่สำเร็จ: '+e.message);btn.disabled=false;btn.textContent='บันทึก';}
}
async function delRow(id){
  var r=ST.data[ST.tab].filter(function(x){return x.id===id;})[0];if(!r)return;
  if(!confirm('ลบรายการนี้?\\n'+(r[S[ST.tab].keyName]||'')))return;
  try{await api('DELETE','/'+ST.tab+'/'+id);ST.data[ST.tab]=ST.data[ST.tab].filter(function(x){return x.id!==id;});render();}
  catch(e){alert('ลบไม่สำเร็จ: '+e.message);}
}
function exportCSV(){
  var s=S[ST.tab],arr=ST.data[ST.tab];
  function q(v){var t=String(v==null?'':v);return /[",\\n]/.test(t)?'"'+t.replace(/"/g,'""')+'"':t;}
  var head=s.order.join(',');
  var body=arr.map(function(r){return s.order.map(function(k){var f=s.fields.filter(function(x){return x.k===k;})[0];if(f&&f.t==='derived')return q(deriveFileId(r[f.from]));return q(r[k]);}).join(',');});
  var csv='\\uFEFF'+[head].concat(body).join('\\n');
  var blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
  var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=ST.tab+'_'+new Date().toISOString().slice(0,10)+'.csv';a.click();URL.revokeObjectURL(a.href);
}

function parseCSV(text){
  text=String(text).replace(/^\\uFEFF/,'');
  var rows=[],row=[],cur='',i=0,inq=false;
  while(i<text.length){
    var ch=text[i];
    if(inq){
      if(ch==='"'){if(text[i+1]==='"'){cur+='"';i+=2;continue;}inq=false;i++;continue;}
      cur+=ch;i++;continue;
    }
    if(ch==='"'){inq=true;i++;continue;}
    if(ch===','){row.push(cur);cur='';i++;continue;}
    if(ch==='\\r'){i++;continue;}
    if(ch==='\\n'){row.push(cur);rows.push(row);row=[];cur='';i++;continue;}
    cur+=ch;i++;
  }
  if(cur!==''||row.length){row.push(cur);rows.push(row);}
  return rows;
}
function importCSV(file){
  var s=S[ST.tab];
  var reader=new FileReader();
  reader.onload=function(){
    var raw=parseCSV(reader.result).filter(function(r){return r.some(function(c){return String(c).trim()!=='';});});
    if(raw.length<2){alert('ไฟล์ว่างหรือมีแต่หัวคอลัมน์');return;}
    var headers=raw[0].map(function(h){return String(h).trim();});
    var map=[];
    headers.forEach(function(h,idx){
      var f=s.fields.filter(function(x){return x.k===h||x.k.toLowerCase()===h.toLowerCase();})[0];
      if(f&&f.t!=='derived')map.push({idx:idx,k:f.k});
    });
    if(!map.length){alert('หัวคอลัมน์ไม่ตรงกับตาราง “'+s.label+'” — ตรวจสอบว่า export มาจากชีตที่ถูกต้อง');return;}
    var recs=[];
    for(var i=1;i<raw.length;i++){
      var line=raw[i],rec={};
      map.forEach(function(m){rec[m.k]=line[m.idx]!=null?String(line[m.idx]).trim():'';});
      s.fields.forEach(function(f){if(f.t==='autotime'&&!rec[f.k])rec[f.k]=new Date().toISOString();if(f.t==='autoid'&&!rec[f.k])rec[f.k]=genReqId();});
      if(s.importKey&&!String(rec[s.importKey]||'').trim())continue;
      recs.push(rec);
    }
    if(!recs.length){alert('ไม่มีแถวที่นำเข้าได้ (อาจขาดคอลัมน์ '+(s.importKey||'หลัก')+')');return;}
    var mode=s.importKey?('อัปเดตทับรายการที่ '+s.importKey+' ซ้ำ และเพิ่มรายการใหม่'):'เพิ่มทุกแถวเป็นรายการใหม่';
    if(!confirm('นำเข้า '+recs.length+' แถว ลงตาราง “'+s.label+'” บน D1?\\n('+mode+')'))return;
    runImport(recs);
  };
  reader.readAsText(file);
}
async function runImport(recs){
  var s=S[ST.tab],btn=document.getElementById('importBtn'),old=btn.innerHTML;
  btn.disabled=true;document.getElementById('exportBtn').disabled=true;document.getElementById('addBtn').disabled=true;
  var ins=0,upd=0;
  try{
    for(var i=0;i<recs.length;i+=200){
      var chunk=recs.slice(i,i+200);
      btn.textContent='นำเข้า… '+Math.min(i+chunk.length,recs.length)+'/'+recs.length;
      var res=await api('POST','/'+ST.tab+'/bulk',{rows:chunk,key:s.importKey||null});
      ins+=res.inserted||0;upd+=res.updated||0;
    }
    var fresh=await api('GET','/'+ST.tab);ST.data[ST.tab]=fresh;render();
    alert('นำเข้าสำเร็จ — เพิ่ม '+ins+' รายการ · อัปเดต '+upd+' รายการ');
  }catch(e){alert('นำเข้าไม่สำเร็จ: '+e.message);}
  btn.disabled=false;btn.innerHTML=old;document.getElementById('exportBtn').disabled=false;document.getElementById('addBtn').disabled=false;
}

document.getElementById('tabs').addEventListener('click',function(e){var b=e.target.closest('[data-tab]');if(b){ST.tab=b.getAttribute('data-tab');ST.query='';document.getElementById('q').value='';render();}});
document.getElementById('tbody').addEventListener('click',function(e){
  var ed=e.target.closest('[data-edit]'),dl=e.target.closest('[data-del]');
  if(ed){var r=ST.data[ST.tab].filter(function(x){return x.id===ed.getAttribute('data-edit');})[0];openForm(r,false);}
  if(dl)delRow(dl.getAttribute('data-del'));
});
document.getElementById('q').addEventListener('input',function(e){ST.query=e.target.value;renderTable();});
document.getElementById('addBtn').onclick=function(){openForm(Object.assign({},S[ST.tab].defaults||{}),true);};
document.getElementById('exportBtn').onclick=exportCSV;
document.getElementById('importBtn').onclick=function(){document.getElementById('importFile').click();};
document.getElementById('importFile').onchange=function(e){var f=e.target.files&&e.target.files[0];if(f)importCSV(f);e.target.value='';};
loadAll();
</script>
</body>
</html>`;
