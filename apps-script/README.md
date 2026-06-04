# Document Control System — Google Apps Script (Google Sheets backend)

เวอร์ชันที่เก็บข้อมูลใน **Google Sheets** แทน Cloudflare D1 — หน้า UI เหมือนเดิม
แต่ทำงานเป็น **Apps Script Web App** ผูกกับสเปรดชีตที่มีอยู่แล้ว (ไม่ต้องใช้
Cloudflare / wrangler / API token ใด ๆ)

ไฟล์ในโฟลเดอร์นี้:

| ไฟล์ | หน้าที่ |
|------|---------|
| `Code.gs` | ฝั่ง server — อ่าน/เขียน/แก้/ลบ ข้อมูลในชีท |
| `Index.html` | หน้าเว็บ (UI) — เรียก server ผ่าน `google.script.run` |
| `appsscript.json` | manifest ของโปรเจกต์ (timezone, web app config) |

ชีทเป้าหมาย: `1gb0bv6mDKJWsYR9-vRqZUHfeclnSVe5Cb5XXtDGrB1E`

## วิธี deploy (ครั้งแรก ~5 นาที)

1. เปิดสเปรดชีตเป้าหมาย → เมนู **ส่วนขยาย (Extensions) ▸ Apps Script**
2. ในโปรเจกต์ Apps Script:
   - วางโค้ดจาก `Code.gs` ลงในไฟล์ `Code.gs`
   - กด **+ ▸ HTML** สร้างไฟล์ชื่อ `Index` แล้ววางเนื้อหาจาก `Index.html`
   - (ถ้าอยากตั้ง timezone/manifest) เปิด **Project Settings ▸ Show "appsscript.json"** แล้ววางเนื้อหาจาก `appsscript.json`
3. กด **Deploy ▸ New deployment** → เลือกชนิด **Web app**
   - **Execute as:** Me (เจ้าของชีท)
   - **Who has access:** Anyone within <องค์กรของคุณ> *(= ค่า `DOMAIN`)*
4. กด **Deploy** → อนุญาตสิทธิ์ (authorize) ครั้งแรก
5. คัดลอก **Web app URL** ที่ได้ → เปิดใช้งานได้เลย

> หลังแก้โค้ดครั้งถัด ๆ ไป ให้ **Deploy ▸ Manage deployments ▸ (ดินสอ) ▸ Version: New version**
> เพื่อให้ URL เดิมอัปเดตเป็นโค้ดล่าสุด

## หมายเหตุการทำงาน

- สคริปต์ **ตรวจจับแท็บอัตโนมัติจากหัวคอลัมน์** (เช่น แท็บที่มี `DocCode`+`DocName`
  = MDL) จึง **ไม่ต้องแก้ชื่อแท็บ** และไม่สนลำดับแท็บ
- ระบบจะเพิ่มคอลัมน์ช่วยชื่อ **`id`** ต่อท้ายแต่ละแท็บ (ใช้ระบุแถวเวลาแก้/ลบ) และ
  เติม UUID ให้แถวเดิมที่ยังไม่มี id โดยอัตโนมัติ — ไม่กระทบคอลัมน์/ข้อมูลเดิม
- การเรียงลำดับ: MDL เรียงตาม `DocCode`, Approval/Ack เรียงตาม `Timestamp` ล่าสุดก่อน
- ปรับสิทธิ์เข้าถึงได้ที่ `appsscript.json` → `webapp.access`
  (`DOMAIN` = เฉพาะคนในองค์กร, `ANYONE_ANONYMOUS` = ใครก็เข้าได้ไม่ต้องล็อกอิน)

## ทางเลือก: deploy อัตโนมัติด้วย clasp (ไม่บังคับ)

```bash
npm i -g @google/clasp
clasp login
clasp clone <SCRIPT_ID>     # หรือ clasp create --type sheets
# คัดลอกไฟล์ในโฟลเดอร์นี้เข้าโปรเจกต์ แล้ว
clasp push
clasp deploy
```
