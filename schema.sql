-- Document Control System — D1 schema (database: dcs_document_control)
-- Apply with:
--   wrangler d1 execute dcs_document_control --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS mdl (
  id             TEXT PRIMARY KEY,
  DocCode        TEXT NOT NULL,
  DocType        TEXT,
  DocName        TEXT,
  Department     TEXT,
  OwnerName      TEXT,
  OwnerEmail     TEXT,
  ApproverName   TEXT,
  ApproverEmail  TEXT,
  Rev            TEXT,
  Status         TEXT,
  IssueDate      TEXT,
  EffectiveDate  TEXT,
  NextReviewDate TEXT,
  Keyword        TEXT,
  FileLink       TEXT,
  Notes          TEXT,
  updated_at     TEXT
);

CREATE TABLE IF NOT EXISTS approval_log (
  id             TEXT PRIMARY KEY,
  Timestamp      TEXT,
  RequestId      TEXT,
  DocCode        TEXT,
  ActionType     TEXT,
  DocType        TEXT,
  DocName        TEXT,
  Department     TEXT,
  RequestedRev   TEXT,
  RequesterName  TEXT,
  RequesterEmail TEXT,
  ApproverName   TEXT,
  ApproverEmail  TEXT,
  DraftFileLink  TEXT,
  Reason         TEXT,
  Decision       TEXT,
  DecisionBy     TEXT,
  DecisionTime   TEXT,
  Comment        TEXT,
  updated_at     TEXT
);

CREATE TABLE IF NOT EXISTS ack_log (
  id            TEXT PRIMARY KEY,
  Timestamp     TEXT,
  EmployeeName  TEXT,
  EmployeeEmail TEXT,
  Department    TEXT,
  DocCode       TEXT,
  Rev           TEXT,
  Confirm       TEXT,
  Method        TEXT,
  Notes         TEXT,
  updated_at    TEXT
);

-- บันทึกการแจกจ่าย/เรียกคืนเอกสาร (FM-MR-03)
CREATE TABLE IF NOT EXISTS dist_log (
  id           TEXT PRIMARY KEY,
  Timestamp    TEXT,
  DocCode      TEXT,
  DocName      TEXT,
  Rev          TEXT,
  HolderName   TEXT,
  Department   TEXT,
  CopyNo       TEXT,
  CopyType     TEXT,
  IssuedDate   TEXT,
  ReturnedDate TEXT,
  Status       TEXT,
  Notes        TEXT,
  updated_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_mdl_doccode  ON mdl(DocCode);
CREATE INDEX IF NOT EXISTS idx_dist_doccode ON dist_log(DocCode);
CREATE INDEX IF NOT EXISTS idx_appr_doccode ON approval_log(DocCode);
CREATE INDEX IF NOT EXISTS idx_ack_doccode  ON ack_log(DocCode);
