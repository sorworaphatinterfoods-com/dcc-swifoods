# DCC Mailer (Google Apps Script)

Tiny web app that lets the Cloudflare Worker send email notifications from your
Google Workspace account (e.g. `qa_admin@sorworaphatinterfoods.com`) without any
external email service or DNS changes. Aligned to **QP-DC-01**.

## Deploy
1. Go to https://script.google.com → **New project**.
2. Delete the sample code, paste the contents of **`Mailer.gs`**.
3. **Deploy ▸ New deployment ▸ Web app**
   - **Execute as:** Me
   - **Who has access:** Anyone
4. Click **Authorize access** and allow the permissions (send email on your behalf).
5. Copy the **Web app URL** (ends in `/exec`).
6. Send that URL back — it gets wired into the Worker as `MAILER_URL`, and the
   Worker will POST JSON `{ token, to, subject, html }` to it on every new request.

`SHARED_TOKEN` in `Mailer.gs` must match `MAILER_TOKEN` in `worker.js`.
