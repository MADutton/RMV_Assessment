// RMV Portal — standalone Node.js server
// Phase 1: submission intake, file storage, admin queue
// Phase 3: PDF/DOCX text extraction

import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import Busboy from "busboy";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = path.join(__dirname, "public");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(DATA_DIR, "uploads");
const DB_PATH = path.join(DATA_DIR, "rmv.sqlite");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;
const AUTH_SECRET = process.env.AUTH_SECRET || "dev-secret-change-me";
const DEV_LOGIN = process.env.DEV_LOGIN === "true";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const USERS_CSV_URL = process.env.USERS_CSV_URL || "";

// ─── Database ─────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'learner',
  name TEXT,
  program TEXT,
  created_ts INTEGER NOT NULL,
  last_seen_ts INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  expires_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  applicant_email TEXT NOT NULL,
  applicant_name TEXT,
  program TEXT,
  specialty TEXT,
  submission_type TEXT NOT NULL,
  case_title TEXT,
  species TEXT,
  case_date TEXT,
  revision_number TEXT,
  notes TEXT,
  attestation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'submitted',
  original_filename TEXT,
  stored_path TEXT,
  mime_type TEXT,
  file_size_bytes INTEGER,
  reviewer_notes TEXT,
  ai_review_json TEXT,
  rmv_question_set_json TEXT,
  rmv_session_status TEXT DEFAULT 'not_started',
  final_decision TEXT DEFAULT 'pending',
  extracted_text_path TEXT,
  extraction_status TEXT DEFAULT 'pending',
  extraction_error TEXT
);

CREATE TABLE IF NOT EXISTS submission_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  actor_email TEXT,
  event_type TEXT NOT NULL,
  details_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions(email);
CREATE INDEX IF NOT EXISTS idx_submissions_email ON submissions(applicant_email);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_sub_events_sub_id ON submission_events(submission_id);
`);

// Migrate existing DBs — safe to run every startup
for (const col of [
  "ALTER TABLE submissions ADD COLUMN extracted_text_path TEXT",
  "ALTER TABLE submissions ADD COLUMN extraction_status TEXT DEFAULT 'pending'",
  "ALTER TABLE submissions ADD COLUMN extraction_error TEXT",
]) {
  try { db.exec(col); } catch {}
}

// ─── Prepared statements ──────────────────────────────────────────────────────

const getUserByEmail = db.prepare("SELECT * FROM users WHERE email = ?");
const upsertUser = db.prepare(`
  INSERT INTO users (email, role, name, program, created_ts, last_seen_ts)
  VALUES (@email, @role, @name, @program, @created_ts, @last_seen_ts)
  ON CONFLICT(email) DO UPDATE SET
    last_seen_ts = excluded.last_seen_ts,
    name = COALESCE(excluded.name, name),
    program = COALESCE(excluded.program, program)
`);

const getSessionByToken = db.prepare("SELECT * FROM sessions WHERE token = ? AND expires_ts > ?");
const insertSession = db.prepare(`
  INSERT INTO sessions (token, email, created_ts, expires_ts) VALUES (?, ?, ?, ?)
`);
const deleteSession = db.prepare("DELETE FROM sessions WHERE token = ?");

const insertSubmission = db.prepare(`
  INSERT INTO submissions (
    created_ts, updated_ts, applicant_email, applicant_name, program, specialty,
    submission_type, case_title, species, case_date, revision_number, notes, attestation,
    status, original_filename, stored_path, mime_type, file_size_bytes,
    reviewer_notes, ai_review_json, rmv_question_set_json, rmv_session_status, final_decision
  ) VALUES (
    @created_ts, @updated_ts, @applicant_email, @applicant_name, @program, @specialty,
    @submission_type, @case_title, @species, @case_date, @revision_number, @notes, @attestation,
    @status, @original_filename, @stored_path, @mime_type, @file_size_bytes,
    @reviewer_notes, @ai_review_json, @rmv_question_set_json, @rmv_session_status, @final_decision
  )
`);

const updateStoredPath = db.prepare("UPDATE submissions SET stored_path = ?, updated_ts = ? WHERE id = ?");

const updateSubmissionStatus = db.prepare(`
  UPDATE submissions
  SET status = @status,
      reviewer_notes = COALESCE(@reviewer_notes, reviewer_notes),
      final_decision = COALESCE(@final_decision, final_decision),
      updated_ts = @updated_ts
  WHERE id = @id
`);

const getSubmissionById = db.prepare("SELECT * FROM submissions WHERE id = ?");
const getSubmissionsByApplicant = db.prepare("SELECT * FROM submissions WHERE applicant_email = ? ORDER BY created_ts DESC");
const getAllSubmissions = db.prepare("SELECT * FROM submissions ORDER BY created_ts DESC");

const insertSubEvent = db.prepare(`
  INSERT INTO submission_events (submission_id, ts, actor_email, event_type, details_json)
  VALUES (@submission_id, @ts, @actor_email, @event_type, @details_json)
`);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function trackSubEvent({ submission_id, actor_email, event_type, details }) {
  insertSubEvent.run({
    submission_id,
    ts: Date.now(),
    actor_email: actor_email || null,
    event_type,
    details_json: details ? JSON.stringify(details) : null,
  });
}

function sanitizeFilename(name) {
  return String(name || "upload")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^_+/, "")
    .slice(0, 180) || "upload";
}

function allowedUpload(mimeType, filename) {
  const lower = String(filename || "").toLowerCase();
  return lower.endsWith(".pdf") || lower.endsWith(".docx") || lower.endsWith(".txt");
}

function parseMultipart(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    const fields = {};
    const files = [];
    let total = 0;

    bb.on("field", (name, val) => { fields[name] = val; });

    bb.on("file", (name, stream, info) => {
      const chunks = [];
      let size = 0;

      stream.on("data", (chunk) => {
        size += chunk.length;
        total += chunk.length;
        if (size > maxBytes || total > maxBytes) {
          stream.resume();
          reject(new Error("File too large (max 25 MB)"));
          return;
        }
        chunks.push(chunk);
      });

      stream.on("end", () => {
        files.push({
          fieldname: name,
          filename: info.filename,
          mimeType: info.mimeType,
          buffer: Buffer.concat(chunks),
          size,
        });
      });
    });

    bb.on("close", () => resolve({ fields, files }));
    bb.on("error", reject);
    req.pipe(bb);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
  };
  return map[ext] || "application/octet-stream";
}

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const resolved = path.normalize(path.join(STATIC_ROOT, decoded));
  if (!resolved.startsWith(STATIC_ROOT)) return null;
  return resolved;
}

// ─── HTTP response helpers ────────────────────────────────────────────────────

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function apiError(res, status, message) {
  return json(res, status, { error: message });
}

function redirect(res, url) {
  res.writeHead(302, { Location: url });
  res.end();
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)) return apiError(res, 404, "Not found");
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return apiError(res, 404, "Not found");
  const buf = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
  res.end(buf);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = "rmv_session";

function parseCookies(req) {
  const header = req.headers["cookie"] || "";
  const out = {};
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) out[k.trim()] = decodeURIComponent(rest.join("=").trim());
  }
  return out;
}

function getSessionEmail(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const row = getSessionByToken.get(token, Date.now());
  return row ? row.email : null;
}

function createSession(res, email) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  insertSession.run(token, email, now, now + SESSION_TTL_MS);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
  return token;
}

function clearSession(req, res) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (token) deleteSession.run(token);
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function getOrCreateUser(email) {
  const existing = getUserByEmail.get(email);
  if (existing) return existing;

  const role = ADMIN_EMAIL && email.toLowerCase() === ADMIN_EMAIL ? "admin" : "learner";
  upsertUser.run({
    email,
    role,
    name: null,
    program: null,
    created_ts: Date.now(),
    last_seen_ts: Date.now(),
  });
  return getUserByEmail.get(email);
}

function touchUser(email) {
  db.prepare("UPDATE users SET last_seen_ts = ? WHERE email = ?").run(Date.now(), email);
}

function requireAuth(req, res) {
  const email = getSessionEmail(req);
  if (!email) {
    apiError(res, 401, "Not authenticated");
    return null;
  }
  touchUser(email);
  return email;
}

function requireFaculty(req, res) {
  const email = requireAuth(req, res);
  if (!email) return null;
  const user = getUserByEmail.get(email);
  if (!user || (user.role !== "faculty" && user.role !== "admin")) {
    apiError(res, 403, "Faculty or admin role required");
    return null;
  }
  return email;
}

function getUserRole(email) {
  const user = getUserByEmail.get(email);
  return user ? user.role : "learner";
}

// ─── Route handlers ───────────────────────────────────────────────────────────

// GET /health
function handleHealth(req, res) {
  json(res, 200, { ok: true, ts: Date.now(), service: "rmv-portal" });
}

// GET /auth/me
function handleAuthMe(req, res) {
  const email = getSessionEmail(req);
  if (!email) return json(res, 200, { email: null, role: null });
  const user = getUserByEmail.get(email);
  return json(res, 200, {
    email,
    role: user ? user.role : "learner",
    name: user ? user.name : null,
  });
}

// POST /auth/dev-login
async function handleDevLogin(req, res) {
  if (!DEV_LOGIN) return apiError(res, 403, "Dev login is disabled");

  const raw = await readBody(req);
  let parsed = {};
  try { parsed = JSON.parse(raw || "{}"); } catch {}

  const email = (parsed.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return apiError(res, 400, "Valid email required");

  getOrCreateUser(email);

  // If no admin exists yet, promote this user — first-login bootstrap
  const adminCount = db.prepare("SELECT COUNT(*) as n FROM users WHERE role = 'admin'").get().n;
  if (adminCount === 0) {
    db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(email);
    console.log(`Bootstrap: promoted ${email} to admin (no admins existed)`);
  }

  createSession(res, email);
  const user = getUserByEmail.get(email);
  return json(res, 200, { ok: true, email, role: user.role });
}

// POST /auth/logout
function handleLogout(req, res) {
  clearSession(req, res);
  return json(res, 200, { ok: true });
}

// POST /api/submissions — multipart file upload
async function handleCreateSubmission(req, res) {
  const email = requireAuth(req, res);
  if (!email) return;

  let parsed;
  try {
    parsed = await parseMultipart(req);
  } catch (e) {
    return apiError(res, 400, e?.message || "Upload failed");
  }

  const { fields, files } = parsed;

  if (!fields.submission_type) return apiError(res, 400, "Missing submission_type");
  if (!fields.case_title || !String(fields.case_title).trim()) return apiError(res, 400, "Missing case_title");
  if (!fields.attestation || String(fields.attestation).toLowerCase() !== "true") {
    return apiError(res, 400, "Attestation required");
  }
  if (!files.length) return apiError(res, 400, "Please attach a file");

  const pf = files[0];
  if (!allowedUpload(pf.mimeType, pf.filename)) {
    return apiError(res, 400, "Unsupported file type. Please upload PDF, DOCX, or TXT.");
  }

  const now = Date.now();
  const result = insertSubmission.run({
    created_ts: now,
    updated_ts: now,
    applicant_email: email,
    applicant_name: fields.applicant_name || "",
    program: fields.program || "",
    specialty: fields.specialty || "",
    submission_type: fields.submission_type,
    case_title: String(fields.case_title).trim(),
    species: fields.species || "",
    case_date: fields.case_date || "",
    revision_number: fields.revision_number || "",
    notes: fields.notes || "",
    attestation: 1,
    status: "submitted",
    original_filename: sanitizeFilename(pf.filename),
    stored_path: "",
    mime_type: pf.mimeType || "",
    file_size_bytes: pf.size || 0,
    reviewer_notes: "",
    ai_review_json: "",
    rmv_question_set_json: "",
    rmv_session_status: "not_started",
    final_decision: "pending",
  });

  const submissionId = Number(result.lastInsertRowid);
  const subDir = path.join(UPLOADS_DIR, String(submissionId));
  fs.mkdirSync(subDir, { recursive: true });

  const cleanName = sanitizeFilename(pf.filename);
  const storedPath = path.join(subDir, cleanName);
  fs.writeFileSync(storedPath, pf.buffer);

  updateStoredPath.run(storedPath, Date.now(), submissionId);

  trackSubEvent({
    submission_id: submissionId,
    actor_email: email,
    event_type: "submission_created",
    details: { filename: cleanName, size: pf.size, submission_type: fields.submission_type },
  });

  // Kick off text extraction in background — don't await
  runExtraction(submissionId).catch(e => console.error("Extraction error:", e));

  return json(res, 200, { ok: true, submission_id: submissionId, message: "Submission received" });
}

// GET /api/my-submissions
function handleMySubmissions(req, res) {
  const email = requireAuth(req, res);
  if (!email) return;
  const rows = getSubmissionsByApplicant.all(email);
  return json(res, 200, rows);
}

// GET /api/submissions — admin: all
function handleAllSubmissions(req, res) {
  const admin = requireFaculty(req, res);
  if (!admin) return;
  const rows = getAllSubmissions.all();
  return json(res, 200, rows);
}

// GET /api/submissions/:id
function handleSubmissionDetail(req, res, id) {
  const email = requireAuth(req, res);
  if (!email) return;

  const sub = getSubmissionById.get(id);
  if (!sub) return apiError(res, 404, "Submission not found");

  const role = getUserRole(email);
  if (role !== "faculty" && role !== "admin" && sub.applicant_email !== email) {
    return apiError(res, 403, "Forbidden");
  }

  return json(res, 200, sub);
}

// POST /api/submissions/:id/status
async function handleUpdateStatus(req, res, id) {
  const admin = requireFaculty(req, res);
  if (!admin) return;

  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch {}

  const allowed = new Set(["draft", "submitted", "under_review", "rmv_ready", "completed", "rejected"]);
  if (!allowed.has(body.status)) return apiError(res, 400, "Invalid status value");

  updateSubmissionStatus.run({
    id,
    status: body.status,
    reviewer_notes: body.reviewer_notes || null,
    final_decision: body.final_decision || null,
    updated_ts: Date.now(),
  });

  trackSubEvent({
    submission_id: Number(id),
    actor_email: admin,
    event_type: "status_updated",
    details: { status: body.status, reviewer_notes: body.reviewer_notes || "" },
  });

  return json(res, 200, { ok: true });
}

// GET /api/submissions/:id/file — serve uploaded file
function handleSubmissionFile(req, res, id) {
  const email = requireAuth(req, res);
  if (!email) return;

  const sub = getSubmissionById.get(id);
  if (!sub) return apiError(res, 404, "Submission not found");

  const role = getUserRole(email);
  if (role !== "faculty" && role !== "admin" && sub.applicant_email !== email) {
    return apiError(res, 403, "Forbidden");
  }

  if (!sub.stored_path || !fs.existsSync(sub.stored_path)) {
    return apiError(res, 404, "File not found on server");
  }

  const buf = fs.readFileSync(sub.stored_path);
  res.writeHead(200, {
    "Content-Type": sub.mime_type || "application/octet-stream",
    "Content-Disposition": `inline; filename="${sanitizeFilename(sub.original_filename)}"`,
  });
  res.end(buf);
}

// ─── Text extraction ──────────────────────────────────────────────────────────

async function extractTextFromBuffer(buffer, filename) {
  const lower = String(filename || "").toLowerCase();

  if (lower.endsWith(".pdf")) {
    const data = await pdfParse(buffer);
    return data.text || "";
  }

  if (lower.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  if (lower.endsWith(".txt")) {
    return buffer.toString("utf8");
  }

  return "";
}

async function runExtraction(submissionId) {
  const sub = getSubmissionById.get(submissionId);
  if (!sub || !sub.stored_path) return;

  db.prepare("UPDATE submissions SET extraction_status = 'running', updated_ts = ? WHERE id = ?")
    .run(Date.now(), submissionId);

  try {
    const buffer = fs.readFileSync(sub.stored_path);
    const text = await extractTextFromBuffer(buffer, sub.original_filename);

    const subDir = path.join(UPLOADS_DIR, String(submissionId));
    const extractedPath = path.join(subDir, "extracted.txt");
    fs.writeFileSync(extractedPath, text, "utf8");

    db.prepare(`
      UPDATE submissions
      SET extracted_text_path = ?, extraction_status = 'done', extraction_error = NULL, updated_ts = ?
      WHERE id = ?
    `).run(extractedPath, Date.now(), submissionId);

    console.log(`Extraction complete for submission ${submissionId} (${text.length} chars)`);
  } catch (e) {
    console.error(`Extraction failed for submission ${submissionId}:`, e.message);
    db.prepare("UPDATE submissions SET extraction_status = 'error', extraction_error = ?, updated_ts = ? WHERE id = ?")
      .run(e.message, Date.now(), submissionId);
  }
}

// GET /api/submissions/:id/text
function handleSubmissionText(req, res, id) {
  const email = requireAuth(req, res);
  if (!email) return;

  const sub = getSubmissionById.get(id);
  if (!sub) return apiError(res, 404, "Submission not found");

  const role = getUserRole(email);
  if (role !== "faculty" && role !== "admin" && sub.applicant_email !== email) {
    return apiError(res, 403, "Forbidden");
  }

  if (sub.extraction_status === "running") {
    return json(res, 202, { status: "running", text: null });
  }
  if (sub.extraction_status === "error") {
    return json(res, 200, { status: "error", error: sub.extraction_error, text: null });
  }
  if (!sub.extracted_text_path || !fs.existsSync(sub.extracted_text_path)) {
    return json(res, 200, { status: "pending", text: null });
  }

  const text = fs.readFileSync(sub.extracted_text_path, "utf8");
  return json(res, 200, { status: "done", text, word_count: text.split(/\s+/).filter(Boolean).length });
}

// POST /api/submissions/:id/extract — trigger re-extraction manually
async function handleTriggerExtraction(req, res, id) {
  const admin = requireFaculty(req, res);
  if (!admin) return;

  const sub = getSubmissionById.get(id);
  if (!sub) return apiError(res, 404, "Submission not found");

  json(res, 200, { ok: true, message: "Extraction started" });
  runExtraction(Number(id)).catch(e => console.error("Re-extraction error:", e));
}

// ─── Users CSV sync ───────────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (!lines.length) return [];
  const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_"));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = line.split(",").map(v => v.trim());
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] || ""; });
    rows.push(row);
  }
  return rows;
}

async function syncUsersFromCSV() {
  if (!USERS_CSV_URL) {
    console.log("USERS_CSV_URL not set — skipping user sync");
    return { synced: 0, skipped: 0, error: null };
  }

  let text;
  try {
    const res = await fetch(USERS_CSV_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    console.error("User CSV fetch failed:", e.message);
    return { synced: 0, skipped: 0, error: e.message };
  }

  const rows = parseCSV(text);
  const allowedRoles = new Set(["admin", "faculty", "learner"]);
  let synced = 0, skipped = 0;

  for (const row of rows) {
    const email = (row.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) { skipped++; continue; }

    const role = allowedRoles.has(row.role) ? row.role : "learner";
    const name = row.name || null;
    const program = row.program || null;

    db.prepare(`
      INSERT INTO users (email, role, name, program, created_ts, last_seen_ts)
      VALUES (@email, @role, @name, @program, @ts, @ts)
      ON CONFLICT(email) DO UPDATE SET
        role = excluded.role,
        name = COALESCE(excluded.name, name),
        program = COALESCE(excluded.program, program)
    `).run({ email, role, name, program, ts: Date.now() });

    synced++;
  }

  console.log(`User CSV sync: ${synced} upserted, ${skipped} skipped`);
  return { synced, skipped, error: null };
}

// POST /api/admin/sync-users
async function handleSyncUsers(req, res) {
  const admin = requireFaculty(req, res);
  if (!admin) return;
  const result = await syncUsersFromCSV();
  return json(res, result.error ? 500 : 200, result);
}

// GET /api/admin/users — admin: all users
function handleAllUsers(req, res) {
  const admin = requireFaculty(req, res);
  if (!admin) return;
  const rows = db.prepare("SELECT id, email, role, name, program, created_ts, last_seen_ts FROM users ORDER BY created_ts DESC").all();
  return json(res, 200, rows);
}

// POST /api/admin/users/:email/role
async function handleSetUserRole(req, res, email) {
  const admin = requireFaculty(req, res);
  if (!admin) return;

  const me = getUserByEmail.get(admin);
  if (!me || me.role !== "admin") return apiError(res, 403, "Admin role required to change user roles");

  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch {}

  const allowedRoles = new Set(["learner", "faculty", "admin"]);
  if (!allowedRoles.has(body.role)) return apiError(res, 400, "Invalid role");

  db.prepare("UPDATE users SET role = ? WHERE email = ?").run(body.role, email.toLowerCase());
  return json(res, 200, { ok: true });
}

// ─── Static file serving ──────────────────────────────────────────────────────

function serveStatic(req, res) {
  const urlPath = req.url || "/";
  const filePath = safeStaticPath(urlPath === "/" ? "/index.html" : urlPath);
  if (!filePath) return apiError(res, 400, "Bad path");
  return serveFile(res, filePath);
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function router(req, res) {
  const rawUrl = req.url || "/";
  const pathname = rawUrl.split("?")[0];
  const method = req.method;

  // Health
  if (method === "GET" && pathname === "/health") return handleHealth(req, res);

  // Auth
  if (method === "GET"  && pathname === "/auth/me")         return handleAuthMe(req, res);
  if (method === "POST" && pathname === "/auth/dev-login")  return handleDevLogin(req, res);
  if (method === "POST" && pathname === "/auth/logout")     return handleLogout(req, res);

  // Submissions API
  if (method === "POST" && pathname === "/api/submissions")       return handleCreateSubmission(req, res);
  if (method === "GET"  && pathname === "/api/my-submissions")    return handleMySubmissions(req, res);
  if (method === "GET"  && pathname === "/api/submissions")       return handleAllSubmissions(req, res);

  const detailMatch = pathname.match(/^\/api\/submissions\/(\d+)$/);
  if (detailMatch) {
    if (method === "GET") return handleSubmissionDetail(req, res, detailMatch[1]);
    return apiError(res, 405, "Method not allowed");
  }

  const statusMatch = pathname.match(/^\/api\/submissions\/(\d+)\/status$/);
  if (statusMatch && method === "POST") return handleUpdateStatus(req, res, statusMatch[1]);

  const fileMatch = pathname.match(/^\/api\/submissions\/(\d+)\/file$/);
  if (fileMatch && method === "GET") return handleSubmissionFile(req, res, fileMatch[1]);

  const textMatch = pathname.match(/^\/api\/submissions\/(\d+)\/text$/);
  if (textMatch && method === "GET") return handleSubmissionText(req, res, textMatch[1]);

  const extractMatch = pathname.match(/^\/api\/submissions\/(\d+)\/extract$/);
  if (extractMatch && method === "POST") return handleTriggerExtraction(req, res, extractMatch[1]);

  // Admin user management
  if (method === "POST" && pathname === "/api/admin/sync-users") return handleSyncUsers(req, res);
  if (method === "GET"  && pathname === "/api/admin/users") return handleAllUsers(req, res);
  const roleMatch = pathname.match(/^\/api\/admin\/users\/(.+)\/role$/);
  if (roleMatch && method === "POST") return handleSetUserRole(req, res, roleMatch[1]);

  // Page routes — serve HTML files
  if (method === "GET" && pathname === "/submit") return serveFile(res, path.join(STATIC_ROOT, "submit.html"));
  if (method === "GET" && pathname === "/admin")  return serveFile(res, path.join(STATIC_ROOT, "admin.html"));

  // Static files
  if (method === "GET") return serveStatic(req, res);

  return apiError(res, 404, "Not found");
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS for local dev
  if (req.headers.origin) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  try {
    await router(req, res);
  } catch (err) {
    console.error("Unhandled error:", err);
    if (!res.headersSent) apiError(res, 500, "Internal server error");
  }
});

server.listen(PORT, () => {
  console.log(`RMV Portal running on port ${PORT}`);
  syncUsersFromCSV().catch(e => console.error("Startup user sync error:", e));
  console.log(`  Base URL : ${BASE_URL}`);
  console.log(`  Data dir : ${DATA_DIR}`);
  console.log(`  Dev login: ${DEV_LOGIN ? "ENABLED" : "disabled"}`);
});
