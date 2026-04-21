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
import OpenAI from "openai";
import nodemailer from "nodemailer";

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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ─── Magic link tokens ────────────────────────────────────────────────────────

const MAGIC_TTL_MS = 15 * 60 * 1000;
const magicTokens = new Map(); // token -> { email, expiresAt }
setInterval(() => {
  const now = Date.now();
  for (const [t, e] of magicTokens) if (now > e.expiresAt) magicTokens.delete(t);
}, 5 * 60 * 1000);

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
  applicant_feedback TEXT,
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
  "ALTER TABLE submissions ADD COLUMN ai_review_json TEXT",
  "ALTER TABLE submissions ADD COLUMN rmv_question_set_json TEXT",
  "ALTER TABLE submissions ADD COLUMN applicant_feedback TEXT",
  "ALTER TABLE submissions ADD COLUMN rmv_questions_finalized_json TEXT",
  "ALTER TABLE submissions ADD COLUMN rmv_questions_sent_ts INTEGER",
  "ALTER TABLE submissions ADD COLUMN rmv_responses_json TEXT",
  "ALTER TABLE submissions ADD COLUMN rmv_responses_ts INTEGER",
  "ALTER TABLE submissions ADD COLUMN rmv_session_started_ts INTEGER",
  "ALTER TABLE submissions ADD COLUMN rmv_session_expires_ts INTEGER",
  "ALTER TABLE submissions ADD COLUMN rmv_timed_expired INTEGER DEFAULT 0",
  "ALTER TABLE submissions ADD COLUMN rmv_grading_json TEXT",
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
      applicant_feedback = COALESCE(@applicant_feedback, applicant_feedback),
      final_decision = COALESCE(@final_decision, final_decision),
      updated_ts = @updated_ts
  WHERE id = @id
`);

const getSubEventsBySubmission = db.prepare(
  "SELECT * FROM submission_events WHERE submission_id = ? ORDER BY ts ASC"
);

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

function isAllowedEmail(email) {
  if (ADMIN_EMAIL && email === ADMIN_EMAIL) return true;
  return !!getUserByEmail.get(email);
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

// POST /auth/request — check email is registered, send magic link
async function handleAuthRequest(req, res) {
  const raw = await readBody(req);
  let parsed = {};
  try { parsed = JSON.parse(raw || "{}"); } catch {}
  const email = (parsed.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return apiError(res, 400, "Valid email required");

  if (!isAllowedEmail(email)) {
    return json(res, 403, { registered: false });
  }

  const token = crypto.randomBytes(32).toString("hex");
  magicTokens.set(token, { email, expiresAt: Date.now() + MAGIC_TTL_MS });
  const link = `${BASE_URL}/auth/verify?token=${token}`;

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = Number(process.env.SMTP_PORT || 587);
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM || smtpUser;

  if (!smtpHost || !smtpUser || !smtpPass) {
    console.warn(`[auth] SMTP not configured — magic link for ${email}: ${link}`);
    return json(res, 200, { sent: true, dev_link: link });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost, port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });
    await transporter.sendMail({
      from: smtpFrom,
      to: email,
      subject: "Your RMV Portal sign-in link",
      text: `Click to sign in (expires in 15 minutes):\n\n${link}\n\nIf you did not request this, ignore this email.`,
      html: `<p>Click to sign in to the RMV Portal (link expires in 15 minutes):</p><p><a href="${link}">${link}</a></p><p>If you did not request this, ignore this email.</p>`,
    });
    return json(res, 200, { sent: true });
  } catch (e) {
    console.error("[auth] Magic link send failed:", e.message);
    return apiError(res, 500, "Failed to send sign-in email. Please try again.");
  }
}

// GET /auth/verify?token=... — verify magic link, create session, redirect home
function handleAuthVerify(req, res) {
  const url = new URL(req.url, BASE_URL);
  const token = url.searchParams.get("token") || "";
  const entry = magicTokens.get(token);

  if (!entry || Date.now() > entry.expiresAt) {
    magicTokens.delete(token);
    res.writeHead(302, { Location: "/?login=expired" });
    return res.end();
  }

  magicTokens.delete(token);
  getOrCreateUser(entry.email);
  createSession(res, entry.email);
  res.writeHead(302, { Location: "/" });
  res.end();
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
    applicant_feedback: body.applicant_feedback || null,
    final_decision: body.final_decision || null,
    updated_ts: Date.now(),
  });

  trackSubEvent({
    submission_id: Number(id),
    actor_email: admin,
    event_type: "status_updated",
    details: {
      status: body.status,
      reviewer_notes: body.reviewer_notes || "",
      applicant_feedback: body.applicant_feedback || "",
    },
  });

  return json(res, 200, { ok: true });
}

// GET /api/submissions/:id/events — event history (auth + ownership)
function handleSubmissionEvents(req, res, id) {
  const email = requireAuth(req, res);
  if (!email) return;

  const sub = getSubmissionById.get(id);
  if (!sub) return apiError(res, 404, "Submission not found");

  const role = getUserRole(email);
  if (role !== "faculty" && role !== "admin" && sub.applicant_email !== email) {
    return apiError(res, 403, "Forbidden");
  }

  const events = getSubEventsBySubmission.all(id).map(e => ({
    ...e,
    details: e.details_json ? JSON.parse(e.details_json) : {},
  }));
  return json(res, 200, events);
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

// ─── AI Review Engine ─────────────────────────────────────────────────────────

const CS_RUBRIC = `
CASE SUMMARY RUBRIC — ABVP 2025 (score each section 0-4):

- Title (weight 2.5%, max 10 pts):
  4=Title accurately describes the contents of the case summary
  2=Title somewhat describes the contents of the case summary
  0=Title does not accurately describe the contents of the case summary

- Introduction (weight 5%, max 20 pts):
  4=Complete, concise, and thorough description of the pathophysiology, typical history and presentation, differential diagnoses, and diagnostic approach
  3=Mostly complete and thorough; 1-2 significant omissions
  2=Somewhat complete; more than 2 significant omissions
  1=Minimal description; many significant omissions
  0=Incomplete or missing

- Treatment / Management / Prognosis (weight 20%, max 80 pts):
  4=Complete synopsis of treatment and management options for the clinical problem or diagnosis, and current recommended therapies/procedures
  3=Mostly complete; most current recommended therapies discussed; 1-2 significant omissions
  2=Somewhat complete; some current recommended therapies discussed; more than 2 significant omissions
  1=Minimal synopsis; few current recommended therapies; several significant omissions
  0=Incomplete or missing; recommended therapies not current or missing

- Case History & Presentation (weight 20%, max 80 pts):
  4=Complete brief description of the patient or population, the chief complaint, and relevant history and clinical findings
  3=Mostly complete; 1-2 significant omissions
  2=Somewhat complete; more than 2 significant omissions
  1=Minimal description; many significant omissions
  0=Incomplete or missing

- Case Management & Outcome (weight 20%, max 80 pts):
  4=All relevant procedures, medications, complications, comorbidities, and justification for deviations from standard procedure discussed; outcome includes patient/case outcome, results of clinical procedures or medical management, and full follow-up
  3=Most relevant items discussed; outcome includes most information; 1-2 significant omissions
  2=Some relevant items discussed; outcome includes some information with partial follow-up; more than 2 significant omissions
  1=Very few relevant items discussed; minimal outcome and follow-up; several significant omissions
  0=Incomplete or missing; outcome and follow-up incomplete or missing

- Discussion & Critique (weight 25%, max 100 pts):
  4=Constructive evaluation of case deficiencies, mistakes, and/or complications; identifies potential changes for future cases; demonstrates ability to learn from an imperfect case; no new material added
  3=Mostly constructive evaluation; identifies changes; demonstrates learning; minimal new material may have been added; 1-2 significant omissions
  2=Somewhat constructive evaluation; moderate ability to identify changes; demonstrates some ability to learn; new material may have been added; more than 2 significant omissions
  1=Minimal constructive evaluation; minimal changes discussed; minimal demonstration of learning; significant new material may have been added; many significant omissions
  0=Does not critically evaluate; unable to identify potential changes; does not demonstrate ability to learn; significant new material added

- References & Endnotes (weight 2.5%, max 10 pts):
  4=At least 1 but no more than 3 references from available literature, preferably peer-reviewed (well-regarded textbooks may also be included)
  2=References listed but more current, applicable, or specific references are readily available
  0=No references, more than 3 references, or inappropriate references

- Lab Data & Imaging (weight 5%, max 20 pts):
  4=Lab results are labeled, legible, relevant to the case, and in chronological order
  2=Lab results present but not entirely relevant or could be more clearly displayed or described
  0=Lab results not labeled, illegible, not relevant to the case, and/or not in chronological order

PASS/FAIL OVERRIDES (automatic fail regardless of score):
- Overall Impression A (Pass/Fail): Case demonstrates management commensurate with an ABVP diplomate level of practice — effectively displays applicant's clinical acumen, expertise, and ability to thoroughly work up a case from beginning to end
- Overall Impression B (Pass/Fail): Overall structure and presentation has minimal organizational, grammatical, or spelling errors; is of professional quality; effectively communicates all relevant case information in a succinct manner
- Word count 1,700–2,000 words (excluding tables, lab results, images, references, endnotes, and section headings) — outside this range = automatic fail
- Any section scoring 0 = automatic fail for the entire case
- Minimum passing score: 280/400 (70%)
- Formatting deductions: -5 pts each for (1) not PDF format, (2) wrong font/size (must be Times, Arial, Calibri, or Helvetica; size 11 or 12), (3) labs/tables/figures not in chronological order at end of paper
`;

const CR_RUBRIC = `
CASE REPORT RUBRIC — ABVP 2025 (score each section 0-4):

- Title (weight 5%, max 20 pts):
  4=Title accurately describes the contents of the case report
  2=Title somewhat describes the contents of the case report
  0=Title does not accurately describe the contents of the case report

- Introduction of Topic (weight 7.5%, max 30 pts):
  4=Provides a complete overview of the general concept of the paper (~1 paragraph)
  3=Mostly complete overview of the general concept of the paper (~1 paragraph)
  2=Somewhat complete overview of the general concept of the paper (may be more than ~1 paragraph)
  1=Section is an incomplete overview of the general concept of the paper (may be more than ~1 paragraph)
  0=Intro is missing or does not provide an overview of the general concept of the paper

- Literature Review (weight 20%, max 80 pts):
  4=Literature cited is current and high quality. No more than 3 top clinical problems are stated. Complete, concise, and thorough description provided for pathophysiology, typical history and presentation, differential diagnoses, and diagnostic approach for each clinical problem. Includes complete synopsis of the treatment and management options for the clinical problem or diagnosis, and current recommended therapies/procedures. Expected outcome and prognosis is discussed.
  3=Literature cited is mostly current and high quality. No more than 3 top clinical problems are stated. Mostly complete, concise, and thorough description provided. Mostly complete synopsis of treatment and management options and current recommended therapies/procedures. Expected outcome and prognosis is discussed. 1-2 significant omissions.
  2=Literature cited is somewhat current and of moderate quality. There may be more than 3 top clinical problems stated. Somewhat complete description provided. Somewhat complete synopsis of treatment and management options. Expected outcome and prognosis may not be discussed fully. More than 2 significant omissions.
  1=Literature cited is not current and is of moderate to low quality. More than 3 top clinical problems may be stated. Description is not complete, concise, or thorough. Incomplete synopsis of treatment and management options. Expected outcome and prognosis is poorly discussed. Many significant omissions.
  0=Literature cited is not current and is of low quality and incomplete for the problems discussed. May have more than 3 top clinical problems stated. Does not include complete, concise, or thorough description. Does not include complete synopsis of treatment and management options or current recommended therapies/procedures. Expected outcome and prognosis is not discussed.

- Case Report Section (weight 30%, max 120 pts):
  4=Complete description of the patient or population, the chief complaint, and relevant history and clinical findings. All relevant procedures, medications, complications, co-morbidities, and justification for deviations from standard procedures are discussed. Outcome includes patient or case outcome, results of clinical procedures or medical management, and full follow up of the case.
  3=Mostly complete description of the patient or population, the chief complaint, and relevant history and clinical findings. Most relevant procedures, medications, complications, co-morbidities, and justifications are discussed. Outcome includes most information for patient or case outcome, results of clinical procedures or medical management, and full follow up. 1-2 significant omissions.
  2=Somewhat complete description of the patient or population, the chief complaint, and relevant history and clinical findings. Some relevant procedures, medications, complications, co-morbidities, and justifications are discussed. Outcome includes some patient or case outcome with partial follow up. More than 2 significant omissions.
  1=Minimal description of the patient or population, the chief complaint, and relevant history and clinical findings. Few relevant procedures, medications, complications, co-morbidities, and justifications are discussed. Minimal discussion of patient or case outcome with minimal follow up. Many significant omissions.
  0=Description of patient or population, chief complaint, and relevant history and clinical findings are incomplete or missing. Relevant procedures, medications, complications, co-morbidities, or justifications are incomplete or missing. Case outcome, results of clinical procedures, medical management, and case follow-up are incomplete or missing.

- Discussion & Critique (weight 25%, max 100 pts):
  4=Complete constructive evaluation of case deficiencies, mistakes, and/or complications. Able to identify potential changes to be made in future cases. Demonstrates ability to learn from an imperfect case. New material has not been added.
  3=Mostly complete constructive evaluation of case deficiencies, mistakes, and/or complications. Able to identify potential changes. Demonstrates ability to learn from an imperfect case. Minimal new material may have been added. 1-2 significant omissions.
  2=Somewhat complete constructive evaluation. Moderate ability to identify potential changes. Demonstrates some ability to learn from an imperfect case. New material may have been added. More than 2 significant omissions.
  1=Minimal constructive evaluation. Minimal changes discussed for future cases. Minimal demonstration of ability to learn. Significant new material may have been added. Many significant omissions.
  0=Does not critically evaluate case deficiencies, mistakes, and/or complications. Unable to identify potential changes. Does not demonstrate ability to learn from an imperfect case. Significant new material has been added.

- Endnotes (weight 5%, max 20 pts):
  4=Endnotes are present and properly cited for all appropriate items
  2=Endnotes are mostly present and properly cited for all appropriate items
  0=Endnotes are not present and/or are improperly cited for appropriate items

- References (weight 7.5%, max 30 pts):
  4=References are current, applicable, and comprehensive for all problems identified and discussed
  3=Most relevant and current applicable references are cited
  2=References are listed, but more current, applicable, or specific references are available
  1=Includes very few relevant references for the topics of discussion
  0=References are inappropriate or incomplete for the topics of discussion

- Labs/Tables (weight 5%, max 20 pts):
  4=Lab results presented in the report are relevant to the case and are clearly displayed and described in the case report
  2=Lab results are present in the report, but are not entirely relevant to the case or could be more clearly displayed or described in the case report
  0=Lab results are missing OR results are not relevant to the case OR are illegible without description in the case report

PASS/FAIL OVERRIDES (automatic fail regardless of score):
- Overall Impression A (Pass/Fail): Case demonstrates management commensurate with an ABVP diplomate level of practice by effectively displaying applicant's clinical acumen, expertise and ability to thoroughly work-up a case and follow it from beginning to end
- Overall Impression B (Pass/Fail): Overall structure and presentation of the document has minimal organizational, grammatical or spelling errors and is of professional quality
- Word count must NOT exceed 19,000 words (excluding tables, lab results, images, references, endnotes, and section headings) — exceeding this limit = automatic fail
- Any section scoring 0 = automatic fail for the entire case
- Minimum passing score: 294/420 (70%)
- Formatting deductions: -5 pts each for (1) not PDF format, (2) wrong font/size (must be Times, Arial, Calibri, or Helvetica; size 11 or 12), (3) labs/tables/figures not in chronological order at end of paper
`;

const SYSTEM_PROMPT = `You are an expert ABVP credentials reviewer with deep knowledge of veterinary clinical practice and the ABVP certification process. You evaluate case submissions using official ABVP rubric criteria and identify strengths, weaknesses, and areas for improvement. You also generate targeted Reflective Mastery Verification (RMV) questions designed to probe whether the applicant truly authored and understands their submission.

Your evaluations must be:
- Rigorous and fair, consistent with ABVP Diplomate standards
- Specific to the actual content of the submission
- Focused on clinical reasoning, completeness, and defensibility
- Formatted as valid JSON only — no prose outside the JSON`;

function buildReviewPrompt(submissionType, caseText, metadata) {
  const rubric = submissionType === "case_summary" ? CS_RUBRIC : CR_RUBRIC;
  const sections = submissionType === "case_summary"
    ? ["title", "introduction", "treatment_management_prognosis", "case_history_presentation", "case_management_outcome", "discussion_critique", "references_endnotes", "lab_data_imaging"]
    : ["title", "introduction_of_topic", "literature_review", "case_report_section", "discussion_critique", "endnotes", "references", "labs_tables"];
  const maxScore = submissionType === "case_summary" ? 400 : 420;
  const passScore = submissionType === "case_summary" ? 280 : 294;
  const wcRule = submissionType === "case_summary"
    ? "Word count must be 1,700-2,000 words"
    : "Word count must not exceed 19,000 words";

  return `You are reviewing a veterinary ${submissionType === "case_summary" ? "Case Summary" : "Case Report"} submission for ABVP credentialing.

METADATA:
- Applicant specialty: ${metadata.specialty || "not specified"}
- Species: ${metadata.species || "not specified"}
- Case title: ${metadata.case_title || "not specified"}
- Revision: ${metadata.revision_number || "v1"}

RUBRIC:
${rubric}

SUBMISSION TEXT:
---
${caseText.slice(0, 12000)}${caseText.length > 12000 ? "\n[... text truncated for length ...]" : ""}
---

Respond with ONLY a valid JSON object in this exact structure:
{
  "submission_type": "${submissionType}",
  "section_scores": {
    ${sections.map(s => `"${s}": {"score": 0, "rationale": "..."}`).join(",\n    ")}
  },
  "overall_impression_a": {"pass": true, "rationale": "..."},
  "overall_impression_b": {"pass": true, "rationale": "..."},
  "word_count_estimate": 0,
  "word_count_pass": true,
  "word_count_note": "${wcRule}",
  "formatting_deductions": 0,
  "formatting_notes": [],
  "estimated_total": 0,
  "estimated_max": ${maxScore},
  "estimated_pass_score": ${passScore},
  "estimated_pct": 0,
  "estimated_pass": false,
  "auto_fail_reasons": [],
  "flags": [],
  "strengths": [],
  "weaknesses": [],
  "rmv_questions": [],
  "rmv_readiness": "not_ready",
  "reviewed_at": ${Date.now()}
}

Rules:
- section_scores: score each section 0-4 per rubric. Rationale must be specific to this submission.
- auto_fail_reasons: list any automatic fail conditions triggered (0 score, impression fail, word count violation)
- flags: specific technical issues (missing drug routes, no lab tables, identifying info present, etc.)
- strengths: 2-4 specific strengths of this submission
- weaknesses: 2-4 specific areas needing improvement
- rmv_questions: exactly 8 targeted questions drawn directly from THIS case — mix of clinical reasoning, counterfactual, justification, error detection, and internal consistency types. Each question should cite a specific detail from the case.
- rmv_readiness: "ready" (passes all criteria), "borderline" (minor issues), or "not_ready" (fails one or more criteria)
- estimated_total: sum of (score × section_weight) across all sections minus formatting_deductions`;
}

async function runAIReview(submissionId) {
  if (!openai) {
    console.log("OPENAI_API_KEY not set — skipping AI review");
    return;
  }

  const sub = getSubmissionById.get(submissionId);
  if (!sub) return;

  // Need extracted text
  if (!sub.extracted_text_path || !fs.existsSync(sub.extracted_text_path)) {
    console.log(`AI review for ${submissionId}: no extracted text yet, skipping`);
    return;
  }

  db.prepare("UPDATE submissions SET ai_review_json = 'running', updated_ts = ? WHERE id = ?")
    .run(Date.now(), submissionId);

  try {
    const caseText = fs.readFileSync(sub.extracted_text_path, "utf8");
    const prompt = buildReviewPrompt(sub.submission_type, caseText, {
      specialty: sub.specialty,
      species: sub.species,
      case_title: sub.case_title,
      revision_number: sub.revision_number,
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content || "{}";
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = { error: "Failed to parse AI response", raw }; }

    parsed.reviewed_at = Date.now();

    db.prepare("UPDATE submissions SET ai_review_json = ?, updated_ts = ? WHERE id = ?")
      .run(JSON.stringify(parsed), Date.now(), submissionId);

    // Also generate and save RMV question set separately
    if (parsed.rmv_questions?.length) {
      db.prepare("UPDATE submissions SET rmv_question_set_json = ?, updated_ts = ? WHERE id = ?")
        .run(JSON.stringify(parsed.rmv_questions), Date.now(), submissionId);
    }

    console.log(`AI review complete for submission ${submissionId} — readiness: ${parsed.rmv_readiness}`);
  } catch (e) {
    console.error(`AI review failed for submission ${submissionId}:`, e.message);
    db.prepare("UPDATE submissions SET ai_review_json = ?, updated_ts = ? WHERE id = ?")
      .run(JSON.stringify({ error: e.message, reviewed_at: Date.now() }), Date.now(), submissionId);
  }
}

// POST /api/submissions/:id/ai-review — trigger review
async function handleTriggerAIReview(req, res, id) {
  const admin = requireFaculty(req, res);
  if (!admin) return;

  if (!openai) return apiError(res, 503, "OPENAI_API_KEY not configured");

  const sub = getSubmissionById.get(id);
  if (!sub) return apiError(res, 404, "Submission not found");

  json(res, 200, { ok: true, message: "AI review started" });
  runAIReview(Number(id)).catch(e => console.error("AI review error:", e));
}

// GET /api/submissions/:id/ai-review — get results
function handleGetAIReview(req, res, id) {
  const admin = requireFaculty(req, res);
  if (!admin) return;

  const sub = getSubmissionById.get(id);
  if (!sub) return apiError(res, 404, "Submission not found");

  if (!sub.ai_review_json) return json(res, 200, { status: "none" });
  if (sub.ai_review_json === "running") return json(res, 200, { status: "running" });

  let review;
  try { review = JSON.parse(sub.ai_review_json); } catch { return json(res, 200, { status: "error", error: "Corrupt review data" }); }

  return json(res, 200, { status: "done", review });
}

// ─── RMV Session ─────────────────────────────────────────────────────────────

// GET /api/submissions/:id/rmv
function handleGetRMVSession(req, res, id) {
  const email = requireAuth(req, res);
  if (!email) return;

  const sub = getSubmissionById.get(id);
  if (!sub) return apiError(res, 404, "Submission not found");

  const role = getUserRole(email);
  if (role !== "faculty" && role !== "admin" && sub.applicant_email !== email) {
    return apiError(res, 403, "Forbidden");
  }

  let questions = null;
  let responses = null;
  let aiQuestions = null;
  let grading = null;
  try { questions    = sub.rmv_questions_finalized_json ? JSON.parse(sub.rmv_questions_finalized_json) : null; } catch {}
  try { responses    = sub.rmv_responses_json           ? JSON.parse(sub.rmv_responses_json)           : null; } catch {}
  try { aiQuestions  = sub.rmv_question_set_json        ? JSON.parse(sub.rmv_question_set_json)        : null; } catch {}
  try { grading      = sub.rmv_grading_json && sub.rmv_grading_json !== "running" ? JSON.parse(sub.rmv_grading_json) : null; } catch {}

  return json(res, 200, {
    session_status: sub.rmv_session_status || "not_started",
    questions,
    ai_questions:   aiQuestions,
    responses,
    sent_ts:        sub.rmv_questions_sent_ts    || null,
    started_ts:     sub.rmv_session_started_ts   || null,
    expires_ts:     sub.rmv_session_expires_ts   || null,
    responses_ts:   sub.rmv_responses_ts         || null,
    timed_expired:  sub.rmv_timed_expired ? true : false,
    grading_status: sub.rmv_grading_json === "running" ? "running" : grading ? "done" : "none",
    grading,
  });
}

// POST /api/submissions/:id/rmv/send — faculty finalizes and sends questions to applicant
async function handleSendRMVQuestions(req, res, id) {
  const admin = requireFaculty(req, res);
  if (!admin) return;

  const sub = getSubmissionById.get(id);
  if (!sub) return apiError(res, 404, "Submission not found");

  if (sub.rmv_session_status === "responses_submitted") {
    return apiError(res, 400, "Applicant has already submitted responses — cannot replace questions");
  }

  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch {}

  const questions = body.questions;
  if (!Array.isArray(questions) || !questions.length) return apiError(res, 400, "questions array required");
  const cleaned = questions.map(q => String(q).trim()).filter(Boolean);
  if (!cleaned.length) return apiError(res, 400, "No valid questions provided");

  const now = Date.now();
  db.prepare(`
    UPDATE submissions
    SET rmv_questions_finalized_json = ?,
        rmv_questions_sent_ts = ?,
        rmv_session_status = 'questions_sent',
        updated_ts = ?
    WHERE id = ?
  `).run(JSON.stringify(cleaned), now, now, id);

  trackSubEvent({
    submission_id: Number(id),
    actor_email: admin,
    event_type: "rmv_questions_sent",
    details: { count: cleaned.length },
  });

  return json(res, 200, { ok: true, count: cleaned.length });
}

// POST /api/submissions/:id/rmv/begin — applicant starts the timed session
async function handleBeginRMVSession(req, res, id) {
  const email = requireAuth(req, res);
  if (!email) return;

  const sub = getSubmissionById.get(id);
  if (!sub) return apiError(res, 404, "Submission not found");
  if (sub.applicant_email !== email) return apiError(res, 403, "Forbidden");

  if (sub.rmv_session_status === "in_progress") {
    // Already started — return existing expiry so client can sync
    return json(res, 200, {
      ok: true,
      started_ts: sub.rmv_session_started_ts,
      expires_ts: sub.rmv_session_expires_ts,
    });
  }
  if (sub.rmv_session_status !== "questions_sent") {
    return apiError(res, 400, "Session is not in the correct state to begin");
  }

  const now = Date.now();
  const DURATION_MS = 50 * 60 * 1000; // 50 minutes
  const expires = now + DURATION_MS;

  db.prepare(`
    UPDATE submissions
    SET rmv_session_started_ts = ?,
        rmv_session_expires_ts = ?,
        rmv_session_status = 'in_progress',
        updated_ts = ?
    WHERE id = ?
  `).run(now, expires, now, id);

  trackSubEvent({
    submission_id: Number(id),
    actor_email: email,
    event_type: "rmv_session_started",
    details: { expires_ts: expires },
  });

  return json(res, 200, { ok: true, started_ts: now, expires_ts: expires });
}

// POST /api/submissions/:id/rmv/respond — applicant submits responses
async function handleSubmitRMVResponses(req, res, id) {
  const email = requireAuth(req, res);
  if (!email) return;

  const sub = getSubmissionById.get(id);
  if (!sub) return apiError(res, 404, "Submission not found");
  if (sub.applicant_email !== email) return apiError(res, 403, "Forbidden");

  if (sub.rmv_session_status === "responses_submitted") {
    return apiError(res, 400, "You have already submitted your responses");
  }
  if (sub.rmv_session_status !== "in_progress") {
    return apiError(res, 400, "No active timed session — click Begin Session first");
  }

  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch {}

  const responses = body.responses;
  if (!Array.isArray(responses) || !responses.length) return apiError(res, 400, "responses array required");

  const cleaned = responses.map(r => ({
    q: String(r.q || "").trim(),
    a: String(r.a || "").trim(),
  }));

  // Server-side expiry check — accept auto-submits even if a few seconds over
  const now = Date.now();
  const expired = sub.rmv_session_expires_ts && now > (sub.rmv_session_expires_ts + 10000); // 10s grace
  const timedExpired = body.timed_expired === true || (sub.rmv_session_expires_ts && now > sub.rmv_session_expires_ts);

  if (expired) {
    return apiError(res, 400, "Session has expired — responses can no longer be submitted");
  }

  db.prepare(`
    UPDATE submissions
    SET rmv_responses_json = ?,
        rmv_responses_ts = ?,
        rmv_timed_expired = ?,
        rmv_session_status = 'responses_submitted',
        updated_ts = ?
    WHERE id = ?
  `).run(JSON.stringify(cleaned), now, timedExpired ? 1 : 0, now, id);

  trackSubEvent({
    submission_id: Number(id),
    actor_email: email,
    event_type: "rmv_responses_submitted",
    details: { count: cleaned.length, timed_expired: timedExpired },
  });

  // Auto-trigger AI grading in background
  runAIGrading(Number(id)).catch(e => console.error("RMV grading error:", e));

  return json(res, 200, { ok: true });
}

// ─── RMV AI Grading ───────────────────────────────────────────────────────────

const RMV_GRADING_SYSTEM = `You are a veterinary ABVP credentials examiner evaluating whether an applicant genuinely authored the case they submitted. You have been given the original case text, the RMV questions asked, and the applicant's timed responses (50-minute exam, no references allowed).

Your task is to grade each response and assess overall authorship confidence. Be rigorous — this is a high-stakes credentialing exam. Generic answers that could apply to any case should score low. Answers that cite specific details from THIS case (drug names, doses, exact findings, timeline, outcome) should score high.

Respond with valid JSON only.`;

function buildGradingPrompt(sub, questions, responses, caseText) {
  return `CASE SUBMISSION:
Type: ${sub.submission_type}
Specialty: ${sub.specialty || "not specified"}
Title: ${sub.case_title || "not specified"}

CASE TEXT (first 8000 chars):
---
${(caseText || "").slice(0, 8000)}
---

RMV QUESTIONS AND APPLICANT RESPONSES:
${responses.map((r, i) => `
Q${i + 1}: ${r.q}
A${i + 1}: ${r.a || "(no response — auto-submitted at time expiry)"}
`).join("")}

Grade each response and respond with ONLY this JSON:
{
  "response_grades": [
    ${responses.map((_, i) => `{
      "question_num": ${i + 1},
      "score": 0,
      "rationale": "...",
      "flags": []
    }`).join(",\n    ")}
  ],
  "authorship_confidence": "high",
  "authorship_rationale": "...",
  "concerns": [],
  "recommendation": "pass"
}

Scoring rubric per response (0–4):
- 4: Specific to this case, accurate, demonstrates direct clinical experience and ownership
- 3: Mostly specific with minor gaps or one vague element
- 2: Partially specific — some case details cited but relies on general knowledge
- 1: Generic — could apply to any similar case, no case-specific details
- 0: No meaningful response, incorrect, or contradicts the case as written

flags (array of strings): cite specific concerns like "contradicts stated diagnosis", "dose not mentioned in case", "no case-specific detail", "copied rubric language"

authorship_confidence: "high" | "medium" | "low" | "concerning"
- high: majority of responses are specific and accurate
- medium: mix of specific and generic responses
- low: most responses are generic or vague
- concerning: responses contradict the case or suggest applicant did not write it

recommendation: "pass" | "borderline" | "fail"

concerns: overall red flags (e.g., "3 of 8 responses contain no case-specific detail", "applicant could not recall treatment timeline")`;
}

async function runAIGrading(submissionId) {
  if (!openai) return;

  const sub = getSubmissionById.get(submissionId);
  if (!sub || !sub.rmv_responses_json) return;

  let responses, questions;
  try { responses = JSON.parse(sub.rmv_responses_json); } catch { return; }
  try { questions = sub.rmv_questions_finalized_json ? JSON.parse(sub.rmv_questions_finalized_json) : []; } catch { questions = []; }

  if (!responses.length) return;

  // Get extracted case text
  let caseText = "";
  if (sub.extracted_text_path && fs.existsSync(sub.extracted_text_path)) {
    try { caseText = fs.readFileSync(sub.extracted_text_path, "utf8"); } catch {}
  }

  db.prepare("UPDATE submissions SET rmv_grading_json = 'running', updated_ts = ? WHERE id = ?")
    .run(Date.now(), submissionId);

  try {
    const prompt = buildGradingPrompt(sub, questions, responses, caseText);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: RMV_GRADING_SYSTEM },
        { role: "user",   content: prompt },
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content || "{}";
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = { error: "Failed to parse grading response", raw }; }
    parsed.graded_at = Date.now();
    parsed.timed_expired = sub.rmv_timed_expired ? true : false;

    db.prepare("UPDATE submissions SET rmv_grading_json = ?, updated_ts = ? WHERE id = ?")
      .run(JSON.stringify(parsed), Date.now(), submissionId);

    console.log(`RMV grading complete for submission ${submissionId} — confidence: ${parsed.authorship_confidence}`);
  } catch (e) {
    console.error(`RMV grading failed for submission ${submissionId}:`, e.message);
    db.prepare("UPDATE submissions SET rmv_grading_json = ?, updated_ts = ? WHERE id = ?")
      .run(JSON.stringify({ error: e.message, graded_at: Date.now() }), Date.now(), submissionId);
  }
}

// ─── RMV Report ───────────────────────────────────────────────────────────────

// GET /api/submissions/:id/report — standalone print-optimized HTML report
function handleSubmissionReport(req, res, id) {
  const email = requireFaculty(req, res);
  if (!email) return;

  const sub = getSubmissionById.get(id);
  if (!sub) return apiError(res, 404, "Submission not found");

  let aiReview = null;
  let rmvGrading = null;
  let rmvResponses = null;
  let rmvQuestions = null;

  try { aiReview   = sub.ai_review_json && sub.ai_review_json !== "running" ? JSON.parse(sub.ai_review_json) : null; } catch {}
  try { rmvGrading = sub.rmv_grading_json && sub.rmv_grading_json !== "running" ? JSON.parse(sub.rmv_grading_json) : null; } catch {}
  try { rmvResponses = sub.rmv_responses_json ? JSON.parse(sub.rmv_responses_json) : null; } catch {}
  try { rmvQuestions = sub.rmv_questions_finalized_json ? JSON.parse(sub.rmv_questions_finalized_json) : null; } catch {}

  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fmt = (ts) => ts ? new Date(ts).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—";
  const fmtDate = (ts) => ts ? new Date(ts).toLocaleDateString("en-US", { dateStyle: "long" }) : "—";

  const SCORE_LABELS = ["Missing / Fail (0)", "Minimal (1)", "Partial (2)", "Mostly Complete (3)", "Complete (4)"];

  // Section score rows
  let aiSectionRows = "";
  if (aiReview?.section_scores) {
    const maxScore = sub.submission_type === "case_summary" ? 400 : 420;
    const entries = Object.entries(aiReview.section_scores);
    aiSectionRows = entries.map(([key, val]) => {
      const barPct = Math.round((val.score / 4) * 100);
      const scoreColors = ["#c0392b","#e67e22","#f39c12","#2980b9","#27ae60"];
      const color = scoreColors[val.score] || "#888";
      return `<tr>
        <td style="padding:6px 10px;font-size:11px;text-transform:capitalize;white-space:nowrap;">${esc(key.replace(/_/g, " "))}</td>
        <td style="padding:6px 10px;min-width:100px;">
          <div style="display:flex;align-items:center;gap:6px;">
            <div style="flex:1;height:7px;border-radius:4px;background:#e0e0e0;min-width:60px;">
              <div style="width:${barPct}%;height:100%;border-radius:4px;background:${color};"></div>
            </div>
            <span style="font-size:11px;font-weight:700;color:${color};min-width:24px;">${val.score}/4</span>
          </div>
        </td>
        <td style="padding:6px 10px;font-size:11px;color:#444;line-height:1.5;">${esc(val.rationale || "")}</td>
      </tr>`;
    }).join("");
  }

  // RMV Q&A rows
  let rmvQARows = "";
  if (rmvResponses?.length) {
    const grades = rmvGrading?.response_grades || [];
    const gradeColors = ["#c0392b","#e67e22","#f39c12","#2980b9","#27ae60"];
    rmvQARows = rmvResponses.map((item, i) => {
      const grade = grades[i];
      const gradeColor = grade ? (gradeColors[grade.score] || "#888") : null;
      const wc = (item.a || "").trim().split(/\s+/).filter(Boolean).length;
      return `
        <div class="qa-block" style="border:1px solid #ddd;border-radius:8px;overflow:hidden;margin-bottom:12px;page-break-inside:avoid;">
          <div style="background:#f5f5f5;padding:8px 12px;border-bottom:1px solid #ddd;display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
            <div style="font-size:11px;font-weight:700;color:#1a4078;line-height:1.5;flex:1;"><strong>Q${i+1}:</strong> ${esc(item.q)}</div>
            ${grade ? `<div style="flex-shrink:0;text-align:right;">
              <span style="font-size:13px;font-weight:800;color:${gradeColor};">${grade.score}/4</span>
              ${(grade.flags||[]).length ? `<div style="font-size:9px;color:#c0392b;margin-top:2px;">${grade.flags.map(f=>esc(f)).join(" · ")}</div>` : ""}
            </div>` : ""}
          </div>
          <div style="padding:10px 12px;font-size:11px;color:#222;line-height:1.65;white-space:pre-wrap;">${item.a ? esc(item.a) : '<em style="color:#aaa;">No response recorded</em>'}</div>
          ${grade?.rationale ? `<div style="padding:6px 12px;background:#fafafa;border-top:1px solid #eee;font-size:10px;color:#666;display:flex;justify-content:space-between;">
            <span>${wc} words</span>
            <em>${esc(grade.rationale)}</em>
          </div>` : `<div style="padding:4px 12px;background:#fafafa;border-top:1px solid #eee;font-size:10px;color:#999;">${wc} words</div>`}
        </div>`;
    }).join("");
  }

  // Confidence colors (print-friendly)
  const confPrintColors = { high: "#27ae60", medium: "#2980b9", low: "#e67e22", concerning: "#c0392b" };
  const recPrintColors  = { pass: "#27ae60", borderline: "#e67e22", fail: "#c0392b" };
  const decisionPrintColors = { pass: "#27ae60", fail: "#c0392b", pending: "#888" };

  const submittedDate = fmtDate(sub.created_ts);
  const reportDate    = fmt(Date.now());

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>RMV Report — ${esc(sub.case_title || `Submission #${sub.id}`)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Times New Roman', Times, serif;
    font-size: 11pt;
    color: #111;
    background: #fff;
    padding: 0;
  }
  .page {
    max-width: 760px;
    margin: 0 auto;
    padding: 32px 36px;
  }
  h1 { font-size: 17pt; color: #1a2e54; margin-bottom: 4px; }
  h2 { font-size: 12pt; color: #1a2e54; margin: 18px 0 6px; border-bottom: 1.5px solid #c8d6ea; padding-bottom: 3px; }
  h3 { font-size: 10.5pt; color: #333; margin: 12px 0 4px; }
  .header-bar {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: 2.5px solid #1a2e54;
    padding-bottom: 10px;
    margin-bottom: 16px;
    gap: 16px;
    flex-wrap: wrap;
  }
  .report-title { font-size: 9pt; color: #888; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 3px; }
  .meta-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 8px 16px;
    background: #f7f9fc;
    border: 1px solid #dde4ef;
    border-radius: 6px;
    padding: 12px 14px;
    margin-bottom: 14px;
  }
  .meta-item label { font-size: 8.5pt; color: #888; display: block; margin-bottom: 1px; text-transform: uppercase; letter-spacing: 0.05em; }
  .meta-item .val  { font-size: 10.5pt; font-weight: 600; color: #111; }
  .badge {
    display: inline-block;
    font-size: 9pt;
    font-weight: 700;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1.5px solid currentColor;
    letter-spacing: 0.03em;
  }
  table { width: 100%; border-collapse: collapse; font-size: 10.5pt; }
  th {
    background: #eef2f8;
    color: #444;
    text-align: left;
    padding: 6px 10px;
    font-size: 9pt;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  td { vertical-align: top; border-bottom: 1px solid #eee; }
  .impressions-row {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .impression-box {
    flex: 1 1 200px;
    border: 1.5px solid;
    border-radius: 7px;
    padding: 8px 12px;
  }
  .score-summary {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .score-box {
    flex: 1 1 150px;
    border: 1.5px solid;
    border-radius: 7px;
    padding: 8px 12px;
  }
  .score-box label { font-size: 8.5pt; color: #888; display: block; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.04em; }
  .score-box .big  { font-size: 18pt; font-weight: 800; line-height: 1; }
  .score-box .sub  { font-size: 9pt; margin-top: 2px; }
  .tag-list { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 4px; }
  .tag { font-size: 9pt; padding: 2px 8px; border-radius: 4px; border: 1px solid; }
  .section-header { font-size: 8.5pt; font-weight: 700; color: #666; text-transform: uppercase; letter-spacing: 0.07em; margin: 4px 0 3px; }
  .disclaimer {
    margin-top: 20px;
    padding: 8px 12px;
    background: #f5f5f5;
    border-left: 3px solid #aaa;
    font-size: 9pt;
    color: #666;
    line-height: 1.5;
  }
  .print-btn {
    position: fixed;
    top: 16px;
    right: 16px;
    padding: 9px 20px;
    background: #1a2e54;
    color: #fff;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
    font-family: system-ui, sans-serif;
    z-index: 999;
    box-shadow: 0 2px 8px rgba(0,0,0,0.18);
  }
  .print-btn:hover { background: #253f72; }
  @media print {
    .print-btn { display: none; }
    .page { max-width: 100%; padding: 16px 20px; }
    body { font-size: 9.5pt; }
    h1 { font-size: 14pt; }
    h2 { font-size: 10.5pt; }
    .qa-block { page-break-inside: avoid; }
    .score-summary, .impressions-row { break-inside: avoid; }
  }
</style>
</head>
<body>
<button class="print-btn" onclick="window.print()">🖨 Print / Save PDF</button>
<div class="page">

  <!-- Header -->
  <div class="header-bar">
    <div>
      <div class="report-title">Reflective Mastery Verification — Official Review Report</div>
      <h1>${esc(sub.case_title || "Untitled Case")}</h1>
      <div style="font-size:9.5pt;color:#555;margin-top:3px;">
        ${esc(sub.submission_type === "case_summary" ? "Case Summary" : "Case Report")}
        &nbsp;·&nbsp; Submission #${sub.id}
        &nbsp;·&nbsp; Submitted ${submittedDate}
      </div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:8.5pt;color:#888;">Report generated</div>
      <div style="font-size:9.5pt;font-weight:600;">${reportDate}</div>
      <div style="font-size:8.5pt;color:#888;margin-top:6px;">Final Decision</div>
      <span class="badge" style="color:${decisionPrintColors[sub.final_decision] || "#888"};font-size:10pt;">
        ${esc((sub.final_decision || "pending").toUpperCase())}
      </span>
    </div>
  </div>

  <!-- Submission Metadata -->
  <div class="meta-grid">
    ${[
      ["Applicant", sub.applicant_name || sub.applicant_email],
      ["Email", sub.applicant_email],
      ["Program", sub.program],
      ["Specialty", sub.specialty],
      ["Species", sub.species],
      ["Case date", sub.case_date],
      ["Revision", sub.revision_number || "v1"],
      ["RMV session", sub.rmv_session_status],
    ].filter(([,v]) => v).map(([k,v]) => `
      <div class="meta-item"><label>${esc(k)}</label><div class="val">${esc(v)}</div></div>
    `).join("")}
  </div>

  ${aiReview ? `
  <!-- ═══ AI REVIEW SECTION ════════════════════════════════════════ -->
  <h2>AI Review — Written Submission Assessment</h2>
  <div style="font-size:9pt;color:#888;margin-bottom:10px;">Reviewed ${aiReview.reviewed_at ? fmt(aiReview.reviewed_at) : "—"} · AI assessment is advisory only, for use by faculty reviewer</div>

  <!-- Score summary boxes -->
  <div class="score-summary">
    <div class="score-box" style="border-color:${aiReview.estimated_pass ? "#27ae60" : "#c0392b"};">
      <label>Estimated Score</label>
      <div class="big" style="color:${aiReview.estimated_pass ? "#27ae60" : "#c0392b"};">${aiReview.estimated_total || 0}/${aiReview.estimated_max || (sub.submission_type === "case_summary" ? 400 : 420)}</div>
      <div class="sub" style="color:${aiReview.estimated_pass ? "#27ae60" : "#c0392b"};">${(aiReview.estimated_pct||0).toFixed(1)}% — ${aiReview.estimated_pass ? "PASS" : "FAIL"}</div>
    </div>
    <div class="score-box" style="border-color:#aaa;">
      <label>Word Count</label>
      <div class="big" style="color:${aiReview.word_count_pass ? "#27ae60" : "#c0392b"};">${(aiReview.word_count_estimate||0).toLocaleString()}</div>
      <div class="sub" style="color:#666;">${esc(aiReview.word_count_note || "")}</div>
    </div>
  </div>
  <div style="font-size:8.5pt;color:#aaa;margin-top:-6px;margin-bottom:10px;font-style:italic;">
    * Pre-session document assessment (recorded at time of AI review): RMV readiness — <strong style="color:${aiReview.rmv_readiness === "ready" ? "#27ae60" : aiReview.rmv_readiness === "borderline" ? "#b8860b" : aiReview.rmv_readiness === "not_ready" ? "#c0392b" : "#888"};">${esc((aiReview.rmv_readiness || "unknown").toLowerCase())}</strong>
  </div>

  <!-- Overall Impressions -->
  <h3>Overall Impressions (Pass/Fail)</h3>
  <div class="impressions-row">
    <div class="impression-box" style="border-color:${aiReview.overall_impression_a?.pass ? "#27ae60" : "#c0392b"};">
      <div style="font-size:9pt;font-weight:700;color:${aiReview.overall_impression_a?.pass ? "#27ae60" : "#c0392b"};margin-bottom:4px;">
        Impression A — ${aiReview.overall_impression_a?.pass ? "PASS" : "FAIL"}
      </div>
      <div style="font-size:10pt;color:#333;line-height:1.5;">${esc(aiReview.overall_impression_a?.rationale || "Not evaluated")}</div>
      <div style="font-size:9pt;color:#666;margin-top:4px;font-style:italic;">Demonstrates diplomate-level clinical management and acumen</div>
    </div>
    <div class="impression-box" style="border-color:${aiReview.overall_impression_b?.pass ? "#27ae60" : "#c0392b"};">
      <div style="font-size:9pt;font-weight:700;color:${aiReview.overall_impression_b?.pass ? "#27ae60" : "#c0392b"};margin-bottom:4px;">
        Impression B — ${aiReview.overall_impression_b?.pass ? "PASS" : "FAIL"}
      </div>
      <div style="font-size:10pt;color:#333;line-height:1.5;">${esc(aiReview.overall_impression_b?.rationale || "Not evaluated")}</div>
      <div style="font-size:9pt;color:#666;margin-top:4px;font-style:italic;">Professional quality; minimal organizational/grammatical errors</div>
    </div>
  </div>

  ${(aiReview.auto_fail_reasons||[]).length ? `
  <div style="padding:8px 12px;border-radius:6px;border:1.5px solid #c0392b;background:#fdf3f2;font-size:10pt;color:#c0392b;margin-bottom:10px;">
    <strong>Auto-fail conditions triggered:</strong> ${aiReview.auto_fail_reasons.map(f => esc(f)).join(" · ")}
  </div>` : ""}

  ${(aiReview.formatting_deductions||0) > 0 ? `
  <div style="padding:6px 12px;border-radius:6px;border:1px solid #e67e22;background:#fef9f2;font-size:9.5pt;color:#b45309;margin-bottom:10px;">
    Formatting deductions: <strong>−${aiReview.formatting_deductions} pts</strong> — ${(aiReview.formatting_notes||[]).map(n=>esc(n)).join(", ")}
  </div>` : ""}

  <!-- Section Scores -->
  <h3>Section Scores</h3>
  <table style="margin-bottom:12px;">
    <thead><tr><th style="width:22%;">Section</th><th style="width:18%;">Score</th><th>Rationale</th></tr></thead>
    <tbody>${aiSectionRows}</tbody>
  </table>

  <!-- Strengths & Weaknesses -->
  <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:12px;">
    <div style="flex:1 1 200px;">
      <div class="section-header" style="color:#27ae60;">Strengths</div>
      ${(aiReview.strengths||[]).map(s=>`<div style="font-size:10pt;padding:4px 8px;border-left:3px solid #27ae60;margin-bottom:4px;color:#222;">${esc(s)}</div>`).join("") || "<div style='font-size:10pt;color:#aaa;'>None identified</div>"}
    </div>
    <div style="flex:1 1 200px;">
      <div class="section-header" style="color:#c0392b;">Weaknesses</div>
      ${(aiReview.weaknesses||[]).map(w=>`<div style="font-size:10pt;padding:4px 8px;border-left:3px solid #c0392b;margin-bottom:4px;color:#222;">${esc(w)}</div>`).join("") || "<div style='font-size:10pt;color:#aaa;'>None identified</div>"}
    </div>
  </div>

  ${(aiReview.flags||[]).length ? `
  <div style="margin-bottom:12px;">
    <div class="section-header" style="color:#e67e22;">Flags</div>
    <div class="tag-list">
      ${aiReview.flags.map(f=>`<span class="tag" style="color:#b45309;border-color:#e67e22;background:#fef9f2;">${esc(f)}</span>`).join("")}
    </div>
  </div>` : ""}

  ` : `<div style="font-size:10pt;color:#aaa;margin:10px 0;">No AI review data available for this submission.</div>`}

  ${(rmvGrading || rmvResponses) ? `
  <!-- ═══ RMV SESSION SECTION ══════════════════════════════════════ -->
  <h2 style="margin-top:22px;">RMV Session — Authorship Verification</h2>
  <div style="font-size:9pt;color:#888;margin-bottom:10px;">
    ${sub.rmv_session_started_ts ? `Session started ${fmt(sub.rmv_session_started_ts)}` : ""}
    ${sub.rmv_responses_ts ? ` · Responses submitted ${fmt(sub.rmv_responses_ts)}` : ""}
    ${sub.rmv_timed_expired ? " · ⏱ Auto-submitted at time expiry" : ""}
  </div>

  ${rmvGrading ? `
  <!-- Authorship Assessment -->
  <div class="score-summary">
    <div class="score-box" style="border-color:${confPrintColors[rmvGrading.authorship_confidence] || "#888"};">
      <label>Authorship Confidence</label>
      <div class="big" style="color:${confPrintColors[rmvGrading.authorship_confidence] || "#888"};font-size:14pt;">${esc((rmvGrading.authorship_confidence||"unknown").toUpperCase())}</div>
    </div>
    <div class="score-box" style="border-color:${recPrintColors[rmvGrading.recommendation] || "#888"};">
      <label>AI Recommendation</label>
      <div class="big" style="color:${recPrintColors[rmvGrading.recommendation] || "#888"};font-size:14pt;">${esc((rmvGrading.recommendation||"unknown").toUpperCase())}</div>
    </div>
    ${rmvGrading.response_grades?.length ? `
    <div class="score-box" style="border-color:#aaa;">
      <label>Average Response Score</label>
      <div class="big" style="color:#1a2e54;font-size:14pt;">
        ${(rmvGrading.response_grades.reduce((s,g) => s + (g.score||0), 0) / rmvGrading.response_grades.length).toFixed(1)}/4
      </div>
    </div>` : ""}
  </div>

  <div style="font-size:10.5pt;color:#333;line-height:1.65;margin-bottom:10px;padding:10px 12px;background:#f7f9fc;border-left:4px solid #1a2e54;border-radius:0 6px 6px 0;">
    <strong>Authorship rationale:</strong> ${esc(rmvGrading.authorship_rationale || "")}
  </div>

  ${(rmvGrading.concerns||[]).length ? `
  <div style="margin-bottom:12px;">
    <div class="section-header" style="color:#c0392b;">Concerns Identified</div>
    ${rmvGrading.concerns.map(c => `<div style="font-size:10pt;padding:4px 8px;border-left:3px solid #c0392b;margin-bottom:4px;color:#333;">${esc(c)}</div>`).join("")}
  </div>` : ""}
  ` : ""}

  ${rmvResponses?.length ? `
  <!-- Q&A Detail -->
  <h3>Question-by-Question Responses</h3>
  <div style="font-size:9pt;color:#888;margin-bottom:8px;">Scored 0–4: 0=No/incorrect response, 1=Generic, 2=Partial, 3=Mostly specific, 4=Case-specific &amp; accurate</div>
  ${rmvQARows}
  ` : ""}
  ` : `<div style="font-size:10pt;color:#aaa;margin:10px 0;">RMV session not yet completed.</div>`}

  <!-- ═══ FACULTY DECISION ═══════════════════════════════════════════ -->
  <h2 style="margin-top:22px;">Faculty Decision</h2>
  <div class="impressions-row" style="margin-bottom:12px;">
    <div class="impression-box" style="flex:0 0 auto;min-width:140px;border-color:${decisionPrintColors[sub.final_decision] || "#888"};">
      <label style="font-size:8.5pt;color:#888;text-transform:uppercase;letter-spacing:0.05em;display:block;margin-bottom:4px;">Final Decision</label>
      <div style="font-size:17pt;font-weight:800;color:${decisionPrintColors[sub.final_decision] || "#888"};">${esc((sub.final_decision||"Pending").toUpperCase())}</div>
    </div>
    ${sub.reviewer_notes ? `
    <div style="flex:1 1 200px;border:1px solid #ddd;border-radius:7px;padding:8px 12px;">
      <div style="font-size:8.5pt;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:5px;">Reviewer Notes <em style="color:#aaa;text-transform:none;">(internal)</em></div>
      <div style="font-size:10.5pt;color:#333;line-height:1.6;white-space:pre-wrap;">${esc(sub.reviewer_notes)}</div>
    </div>` : ""}
  </div>

  ${sub.applicant_feedback ? `
  <div style="border:1px solid #c8d6ea;border-radius:7px;padding:10px 14px;margin-bottom:12px;">
    <div style="font-size:8.5pt;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:5px;">Applicant Feedback</div>
    <div style="font-size:10.5pt;color:#333;line-height:1.6;white-space:pre-wrap;">${esc(sub.applicant_feedback)}</div>
  </div>` : ""}

  <div class="disclaimer">
    <strong>Disclaimer:</strong> AI-generated scores and rationale are provided as a decision-support tool only. All final determinations are made by credentialed ABVP faculty reviewers. This report is confidential and intended for internal credentialing use only. Generated by the RMV Portal — Reflective Mastery Verification Platform.
  </div>

</div>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
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
    const vals = line.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
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
  if (method === "POST" && pathname === "/auth/request")    return handleAuthRequest(req, res);
  if (method === "GET"  && pathname === "/auth/verify")     return handleAuthVerify(req, res);
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

  const eventsMatch = pathname.match(/^\/api\/submissions\/(\d+)\/events$/);
  if (eventsMatch && method === "GET") return handleSubmissionEvents(req, res, eventsMatch[1]);

  const textMatch = pathname.match(/^\/api\/submissions\/(\d+)\/text$/);
  if (textMatch && method === "GET") return handleSubmissionText(req, res, textMatch[1]);

  const extractMatch = pathname.match(/^\/api\/submissions\/(\d+)\/extract$/);
  if (extractMatch && method === "POST") return handleTriggerExtraction(req, res, extractMatch[1]);

  const aiReviewMatch = pathname.match(/^\/api\/submissions\/(\d+)\/ai-review$/);
  if (aiReviewMatch && method === "POST") return handleTriggerAIReview(req, res, aiReviewMatch[1]);
  if (aiReviewMatch && method === "GET")  return handleGetAIReview(req, res, aiReviewMatch[1]);

  const rmvMatch = pathname.match(/^\/api\/submissions\/(\d+)\/rmv$/);
  if (rmvMatch && method === "GET") return handleGetRMVSession(req, res, rmvMatch[1]);

  const rmvSendMatch = pathname.match(/^\/api\/submissions\/(\d+)\/rmv\/send$/);
  if (rmvSendMatch && method === "POST") return handleSendRMVQuestions(req, res, rmvSendMatch[1]);

  const rmvBeginMatch = pathname.match(/^\/api\/submissions\/(\d+)\/rmv\/begin$/);
  if (rmvBeginMatch && method === "POST") return handleBeginRMVSession(req, res, rmvBeginMatch[1]);

  const rmvRespondMatch = pathname.match(/^\/api\/submissions\/(\d+)\/rmv\/respond$/);
  if (rmvRespondMatch && method === "POST") return handleSubmitRMVResponses(req, res, rmvRespondMatch[1]);

  const reportMatch = pathname.match(/^\/api\/submissions\/(\d+)\/report$/);
  if (reportMatch && method === "GET") return handleSubmissionReport(req, res, reportMatch[1]);

  // Admin user management
  if (method === "POST" && pathname === "/api/admin/sync-users") return handleSyncUsers(req, res);
  if (method === "GET"  && pathname === "/api/admin/users") return handleAllUsers(req, res);
  const roleMatch = pathname.match(/^\/api\/admin\/users\/(.+)\/role$/);
  if (roleMatch && method === "POST") return handleSetUserRole(req, res, roleMatch[1]);

  // Page routes — serve HTML files
  if (method === "GET" && pathname === "/submit") return serveFile(res, path.join(STATIC_ROOT, "submit.html"));
  if (method === "GET" && pathname === "/admin")  return serveFile(res, path.join(STATIC_ROOT, "admin.html"));
  if (method === "GET" && pathname === "/portal") return serveFile(res, path.join(STATIC_ROOT, "portal.html"));

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
