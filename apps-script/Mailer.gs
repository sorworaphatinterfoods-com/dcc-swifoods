/* ============================================================
   DCC Mailer — Google Apps Script web app
   Sends notification emails from your Google Workspace account
   (e.g. qa_admin@sorworaphatinterfoods.com) on behalf of the
   Cloudflare Worker. Aligned to QP-DC-01.

   Deploy:
     1. script.google.com / New project / paste this file
     2. Deploy / New deployment / Web app
          - Execute as: Me
          - Who has access: Anyone
     3. Authorize, copy the /exec URL, and send it back so it can
        be wired into the Worker (MAILER_URL).
   ============================================================ */

// Must match MAILER_TOKEN in the Worker (worker.js).
var SHARED_TOKEN = 'a4f9c1e8d7b6403a9f2c5e1d8b7a6c3f';

// Fallback recipient if the Worker does not pass one.
var DEFAULT_TO = 'qa_admin@sorworaphatinterfoods.com';

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.token !== SHARED_TOKEN) return out_({ ok: false, error: 'unauthorized' });
    MailApp.sendEmail({
      to: body.to || DEFAULT_TO,
      subject: body.subject || '(no subject)',
      htmlBody: body.html || body.text || '',
      body: body.text || 'มีคำร้องใหม่ในระบบควบคุมเอกสาร (DCC)'
    });
    return out_({ ok: true });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  }
}

// Lets you confirm the deployment URL works from a browser.
function doGet() {
  return out_({ ok: true, service: 'DCC Mailer', ready: true });
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
