// server.js — AutomatON Claims Demo: Insurance Broker Case Management
// Express server with full REST API for claim lifecycle management

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./db');
const { hashPassword, verifyPassword, generateToken, authMiddleware } = require('./auth');
const claimsEngine = require('./claims-engine');
const jobWorker = require('./job-worker');

// ============================================================
// App Setup
// ============================================================

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Multer config: memory storage, 10MB limit, PDF/JPG/PNG only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, JPG, and PNG files are allowed'));
    }
  },
});

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ============================================================
// Transition Matrix
// ============================================================

const TRANSITIONS = {
  received: ['awaiting_client_docs', 'validated_by_broker', 'closed'],
  awaiting_client_docs: ['validated_by_broker', 'closed'],
  validated_by_broker: ['submitted_to_insurer', 'awaiting_client_docs'],
  submitted_to_insurer: ['insurer_requested_info', 'awaiting_insurer_decision'],
  insurer_requested_info: ['submitted_to_insurer', 'awaiting_insurer_decision', 'closed'],
  awaiting_insurer_decision: ['approved_by_insurer', 'partially_approved', 'rejected_by_insurer'],
  approved_by_insurer: ['paid', 'closed'],
  partially_approved: ['paid', 'closed'],
  rejected_by_insurer: ['submitted_to_insurer', 'closed'],
  paid: ['closed'],
  closed: [],
};

// ============================================================
// Helpers
// ============================================================

/** Generate next case number: AMR-2026-XXXX */
function generateCaseNumber() {
  const year = new Date().getFullYear();
  const last = db.getDB().prepare(
    `SELECT case_number FROM cases WHERE case_number LIKE ? ORDER BY id DESC LIMIT 1`
  ).get(`AMR-${year}-%`);

  let seq = 1;
  if (last) {
    const parts = last.case_number.split('-');
    seq = parseInt(parts[2], 10) + 1;
  }
  return `AMR-${year}-${String(seq).padStart(4, '0')}`;
}

/** Mask EGN: show only last 4 digits as ****XXXX */
function maskEGN(egn) {
  if (!egn || egn.length < 4) return egn;
  return '****' + egn.slice(-4);
}

/** Mask EGN fields in parties array */
function maskPartiesEGN(parties) {
  if (!parties) return parties;
  return parties.map(p => ({ ...p, egn: maskEGN(p.egn) }));
}

/** Save uploaded file to disk, return stored filename */
function saveFileToDisk(file) {
  const ext = path.extname(file.originalname) || '.bin';
  const filename = crypto.randomUUID() + ext;
  const filepath = path.join(uploadsDir, filename);
  fs.writeFileSync(filepath, file.buffer);
  return filename;
}

/** Insert classification + completeness jobs with dedupe */
function insertPipelineJobs(caseId) {
  const d = db.getDB();
  const jobIds = [];

  // Classification job — depends on all OCR for case
  const existingClassification = d.prepare(
    `SELECT id FROM processing_jobs WHERE case_id = ? AND job_type = 'classification' AND status IN ('queued','locked','processing')`
  ).get(caseId);

  let classificationJobId;
  if (!existingClassification) {
    const r = d.prepare(
      `INSERT INTO processing_jobs (case_id, job_type, status, depends_on_type) VALUES (?, 'classification', 'queued', 'all_ocr_for_case')`
    ).run(caseId);
    classificationJobId = r.lastInsertRowid;
    jobIds.push(classificationJobId);
  } else {
    classificationJobId = existingClassification.id;
  }

  // Completeness job — depends on classification job
  const existingCompleteness = d.prepare(
    `SELECT id FROM processing_jobs WHERE case_id = ? AND job_type = 'completeness_check' AND status IN ('queued','locked','processing')`
  ).get(caseId);

  if (!existingCompleteness) {
    const r = d.prepare(
      `INSERT INTO processing_jobs (case_id, job_type, status, depends_on_type, depends_on_job_id) VALUES (?, 'completeness_check', 'queued', 'job_id', ?)`
    ).run(caseId, classificationJobId);
    jobIds.push(r.lastInsertRowid);
  }

  return jobIds;
}

// ============================================================
// Auth Middleware — protect all /api/* except login
// ============================================================

app.use('/api', (req, res, next) => {
  // Allow login without auth
  if (req.path === '/auth/login') return next();
  return authMiddleware(req, res, next);
});

// ============================================================
// Auth Routes
// ============================================================

// POST /api/auth/login — username+password -> JWT
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    const user = db.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = generateToken({ id: user.id, email: user.username, role: user.role });
    res.json({
      success: true,
      token,
      user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role },
    });
  } catch (err) {
    console.error('[LOGIN ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// POST /api/auth/register — create user (admin only)
app.post('/api/auth/register', (req, res) => {
  try {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { username, password, role, full_name } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    const existing = db.getUserByUsername(username);
    if (existing) {
      return res.status(409).json({ success: false, error: 'Username already exists' });
    }

    const hash = hashPassword(password);
    const d = db.getDB();
    const r = d.prepare(
      `INSERT INTO users (username, password_hash, role, full_name, created_at) VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(username, hash, role || 'broker', full_name || username);

    res.status(201).json({ success: true, user: { id: r.lastInsertRowid, username, role: role || 'broker', full_name: full_name || username } });
  } catch (err) {
    console.error('[REGISTER ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/auth/me — current user from token
app.get('/api/auth/me', (req, res) => {
  try {
    const user = db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({
      success: true,
      user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role },
    });
  } catch (err) {
    console.error('[ME ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================
// Cases CRUD
// ============================================================

// POST /api/cases — create case manually
app.post('/api/cases', (req, res) => {
  try {
    const d = db.getDB();
    const caseNumber = generateCaseNumber();
    const {
      insurer_claim_number, priority, assigned_to,
      next_action, next_action_due_date,
      policy_number, policy_type, insurer_name, insurer_branch, insurer_contact,
      incident_date, incident_location, incident_description,
      claim_type, sub_type,
      estimated_amount, currency,
    } = req.body;

    const r = d.prepare(`
      INSERT INTO cases (
        case_number, insurer_claim_number, status, priority, assigned_to,
        next_action, next_action_due_date,
        policy_number, policy_type, insurer_name, insurer_branch, insurer_contact,
        incident_date, incident_location, incident_description,
        claim_type, sub_type,
        estimated_amount, currency,
        created_by
      ) VALUES (?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      caseNumber,
      insurer_claim_number || null,
      priority || 'normal',
      assigned_to || req.user.id,
      next_action || null,
      next_action_due_date || null,
      policy_number || null,
      policy_type || null,
      insurer_name || null,
      insurer_branch || null,
      insurer_contact || null,
      incident_date || null,
      incident_location || null,
      incident_description || null,
      claim_type || null,
      sub_type || null,
      estimated_amount || null,
      currency || 'BGN',
      req.user.id
    );

    // Timeline entry
    d.prepare(
      `INSERT INTO case_timeline (case_id, action, new_status, actor, notes) VALUES (?, 'case_created', 'received', ?, ?)`
    ).run(r.lastInsertRowid, req.user.name || req.user.email || 'system', 'Case created manually');

    res.status(201).json({ success: true, case_id: r.lastInsertRowid, case_number: caseNumber });
  } catch (err) {
    console.error('[CREATE CASE ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// POST /api/cases/intake — upload documents, create case, trigger AI pipeline
app.post('/api/cases/intake', upload.array('documents', 20), (req, res) => {
  try {
    const d = db.getDB();
    const caseNumber = generateCaseNumber();

    // Create case
    const caseResult = d.prepare(`
      INSERT INTO cases (case_number, status, priority, assigned_to, claim_type, created_by)
      VALUES (?, 'received', 'normal', ?, ?, ?)
    `).run(
      caseNumber,
      req.user.id,
      req.body.claim_type || null,
      req.user.id
    );
    const caseId = caseResult.lastInsertRowid;

    // Timeline
    d.prepare(
      `INSERT INTO case_timeline (case_id, action, new_status, actor, notes) VALUES (?, 'case_created', 'received', ?, 'Case created via document intake')`
    ).run(caseId, req.user.name || req.user.email || 'system');

    const jobIds = [];
    const docIds = [];

    // Save each uploaded file
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const filename = saveFileToDisk(file);

        const docResult = d.prepare(`
          INSERT INTO documents (case_id, filename, original_name, mimetype, size_bytes, doc_type, uploaded_by)
          VALUES (?, ?, ?, ?, ?, 'other', ?)
        `).run(caseId, filename, file.originalname, file.mimetype, file.size, req.user.id);
        docIds.push(docResult.lastInsertRowid);

        // Create OCR job for each document
        const jobResult = d.prepare(`
          INSERT INTO processing_jobs (case_id, document_id, job_type, status) VALUES (?, ?, 'ocr_extraction', 'queued')
        `).run(caseId, docResult.lastInsertRowid);
        jobIds.push(jobResult.lastInsertRowid);
      }
    }

    // Insert classification + completeness pipeline jobs
    const pipelineJobIds = insertPipelineJobs(caseId);
    jobIds.push(...pipelineJobIds);

    res.status(201).json({
      success: true,
      case_id: caseId,
      case_number: caseNumber,
      document_ids: docIds,
      job_ids: jobIds,
    });
  } catch (err) {
    console.error('[INTAKE ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/cases — list with filters
app.get('/api/cases', (req, res) => {
  try {
    const d = db.getDB();
    const { status, claim_type, assignee, insurer, overdue, search, limit, offset } = req.query;

    let sql = `SELECT c.*, u.full_name as assignee_name FROM cases c LEFT JOIN users u ON c.assigned_to = u.id WHERE c.is_deleted = 0`;
    const params = [];

    if (status) {
      sql += ` AND c.status = ?`;
      params.push(status);
    }
    if (claim_type) {
      sql += ` AND c.claim_type = ?`;
      params.push(claim_type);
    }
    if (assignee) {
      sql += ` AND c.assigned_to = ?`;
      params.push(Number(assignee));
    }
    if (insurer) {
      sql += ` AND c.insurer_name = ?`;
      params.push(insurer);
    }
    if (overdue === 'true') {
      sql += ` AND c.next_action_due_date < date('now') AND c.status NOT IN ('closed', 'paid')`;
    }
    if (search) {
      sql += ` AND (c.case_number LIKE ? OR c.insurer_claim_number LIKE ? OR c.incident_description LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    sql += ` ORDER BY c.created_at DESC`;

    if (limit) {
      sql += ` LIMIT ?`;
      params.push(Number(limit));
      if (offset) {
        sql += ` OFFSET ?`;
        params.push(Number(offset));
      }
    }

    const cases = d.prepare(sql).all(...params);
    res.json({ success: true, cases });
  } catch (err) {
    console.error('[LIST CASES ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/cases/:id — full case with parties, vehicles, documents, timeline, communications
app.get('/api/cases/:id', (req, res) => {
  try {
    const d = db.getDB();
    const caseId = Number(req.params.id);

    const caseRow = d.prepare(`SELECT c.*, u.full_name as assignee_name FROM cases c LEFT JOIN users u ON c.assigned_to = u.id WHERE c.id = ? AND c.is_deleted = 0`).get(caseId);
    if (!caseRow) return res.status(404).json({ success: false, error: 'Case not found' });

    // Parties — mask EGN
    const parties = maskPartiesEGN(
      d.prepare(`SELECT * FROM parties WHERE case_id = ?`).all(caseId)
    );

    // Vehicles
    const vehicles = d.prepare(`SELECT * FROM vehicles WHERE case_id = ?`).all(caseId);

    // Documents with requirement status
    const documents = d.prepare(`SELECT * FROM documents WHERE case_id = ? ORDER BY uploaded_at DESC`).all(caseId);

    // Document requirements for this claim type
    let requirements = [];
    if (caseRow.claim_type) {
      let reqSql = `SELECT * FROM document_requirements WHERE claim_type = ?`;
      const reqParams = [caseRow.claim_type];

      if (caseRow.policy_type) {
        reqSql += ` AND (policy_type IS NULL OR policy_type = ?)`;
        reqParams.push(caseRow.policy_type);
      } else {
        reqSql += ` AND policy_type IS NULL`;
      }

      // Include insurer-specific and general
      if (caseRow.insurer_name) {
        reqSql += ` AND (insurer_specific IS NULL OR insurer_specific = ?)`;
        reqParams.push(caseRow.insurer_name);
      } else {
        reqSql += ` AND insurer_specific IS NULL`;
      }

      requirements = d.prepare(reqSql).all(...reqParams);

      // Build requirement status: count uploaded vs min_count
      const docCountByType = {};
      for (const doc of documents) {
        docCountByType[doc.doc_type] = (docCountByType[doc.doc_type] || 0) + 1;
      }
      requirements = requirements.map(r => ({
        ...r,
        uploaded_count: docCountByType[r.doc_type] || 0,
        satisfied: (docCountByType[r.doc_type] || 0) >= r.min_count,
      }));
    }

    // Timeline
    const timeline = d.prepare(`SELECT * FROM case_timeline WHERE case_id = ? ORDER BY created_at DESC`).all(caseId);

    // Communications
    const communications = d.prepare(`SELECT * FROM communications WHERE case_id = ? ORDER BY created_at DESC`).all(caseId);

    res.json({
      success: true,
      case: caseRow,
      parties,
      vehicles,
      documents,
      document_requirements: requirements,
      timeline,
      communications,
    });
  } catch (err) {
    console.error('[GET CASE ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// PUT /api/cases/:id — update case fields
app.put('/api/cases/:id', (req, res) => {
  try {
    const d = db.getDB();
    const caseId = Number(req.params.id);

    const caseRow = d.prepare(`SELECT * FROM cases WHERE id = ? AND is_deleted = 0`).get(caseId);
    if (!caseRow) return res.status(404).json({ success: false, error: 'Case not found' });

    // Updatable fields
    const updatable = [
      'insurer_claim_number', 'priority', 'assigned_to',
      'next_action', 'next_action_due_date', 'last_contact_date', 'overdue_reason',
      'policy_number', 'policy_type', 'insurer_name', 'insurer_branch', 'insurer_contact',
      'incident_date', 'incident_location', 'incident_description',
      'claim_type', 'sub_type',
      'estimated_amount', 'insurer_approved_amount', 'paid_amount', 'currency',
      'extraction_confidence', 'ai_notes',
    ];

    const setClauses = [];
    const values = [];

    for (const field of updatable) {
      if (req.body[field] !== undefined) {
        setClauses.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    setClauses.push(`updated_at = datetime('now')`);
    values.push(caseId);

    d.prepare(`UPDATE cases SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

    // Timeline entry for update
    d.prepare(
      `INSERT INTO case_timeline (case_id, action, actor, notes) VALUES (?, 'case_updated', ?, ?)`
    ).run(caseId, req.user.name || req.user.email || 'system', `Updated fields: ${Object.keys(req.body).filter(k => updatable.includes(k)).join(', ')}`);

    res.json({ success: true, case_id: caseId });
  } catch (err) {
    console.error('[UPDATE CASE ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// DELETE /api/cases/:id — soft delete
app.delete('/api/cases/:id', (req, res) => {
  try {
    const d = db.getDB();
    const caseId = Number(req.params.id);

    const { cancellation_reason } = req.body;
    if (!cancellation_reason) {
      return res.status(400).json({ success: false, error: 'cancellation_reason is required' });
    }

    const caseRow = d.prepare(`SELECT * FROM cases WHERE id = ? AND is_deleted = 0`).get(caseId);
    if (!caseRow) return res.status(404).json({ success: false, error: 'Case not found' });

    d.prepare(
      `UPDATE cases SET is_deleted = 1, cancelled_at = datetime('now'), cancellation_reason = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(cancellation_reason, caseId);

    d.prepare(
      `INSERT INTO case_timeline (case_id, action, actor, notes) VALUES (?, 'case_deleted', ?, ?)`
    ).run(caseId, req.user.name || req.user.email || 'system', `Soft deleted: ${cancellation_reason}`);

    res.json({ success: true, case_id: caseId });
  } catch (err) {
    console.error('[DELETE CASE ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================
// Case Pipeline
// ============================================================

// POST /api/cases/:id/transition — validate against transition matrix
app.post('/api/cases/:id/transition', (req, res) => {
  try {
    const d = db.getDB();
    const caseId = Number(req.params.id);
    const { new_status, notes } = req.body;

    if (!new_status) {
      return res.status(400).json({ success: false, error: 'new_status is required' });
    }

    const caseRow = d.prepare(`SELECT * FROM cases WHERE id = ? AND is_deleted = 0`).get(caseId);
    if (!caseRow) return res.status(404).json({ success: false, error: 'Case not found' });

    const currentStatus = caseRow.status;
    const allowed = TRANSITIONS[currentStatus];

    if (!allowed || !allowed.includes(new_status)) {
      return res.status(400).json({
        success: false,
        error: `Transition from '${currentStatus}' to '${new_status}' is not allowed`,
        allowed_transitions: allowed || [],
      });
    }

    // Special validation for validated_by_broker: require ready_to_submit=true from latest completeness check
    if (new_status === 'validated_by_broker') {
      const latestCompleteness = d.prepare(
        `SELECT result FROM processing_jobs WHERE case_id = ? AND job_type = 'completeness_check' AND status = 'completed' ORDER BY completed_at DESC LIMIT 1`
      ).get(caseId);

      if (latestCompleteness && latestCompleteness.result) {
        try {
          const parsed = JSON.parse(latestCompleteness.result);
          if (parsed.ready_to_submit !== true) {
            return res.status(400).json({
              success: false,
              error: 'Cannot validate: completeness check indicates case is not ready to submit. Missing documents may exist.',
            });
          }
        } catch (_) {
          // If result can't be parsed, allow transition (no completeness data available)
        }
      }
      // If no completeness check exists, allow transition (broker's manual override)
    }

    // Update status + relevant timestamp
    let extraUpdate = '';
    if (new_status === 'submitted_to_insurer') {
      extraUpdate = `, submitted_to_insurer_at = datetime('now')`;
    } else if (['approved_by_insurer', 'partially_approved', 'rejected_by_insurer'].includes(new_status)) {
      extraUpdate = `, insurer_decision_at = datetime('now')`;
    } else if (new_status === 'paid') {
      extraUpdate = `, paid_at = datetime('now')`;
    } else if (new_status === 'closed') {
      extraUpdate = `, closed_at = datetime('now')`;
    }

    d.prepare(
      `UPDATE cases SET status = ?, updated_at = datetime('now') ${extraUpdate} WHERE id = ?`
    ).run(new_status, caseId);

    // Timeline entry
    d.prepare(
      `INSERT INTO case_timeline (case_id, action, old_status, new_status, actor, notes) VALUES (?, 'status_transition', ?, ?, ?, ?)`
    ).run(caseId, currentStatus, new_status, req.user.name || req.user.email || 'system', notes || null);

    res.json({ success: true, case_id: caseId, old_status: currentStatus, new_status });
  } catch (err) {
    console.error('[TRANSITION ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/cases/:id/timeline
app.get('/api/cases/:id/timeline', (req, res) => {
  try {
    const d = db.getDB();
    const caseId = Number(req.params.id);
    const timeline = d.prepare(`SELECT * FROM case_timeline WHERE case_id = ? ORDER BY created_at DESC`).all(caseId);
    res.json({ success: true, timeline });
  } catch (err) {
    console.error('[TIMELINE ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// POST /api/cases/:id/assign
app.post('/api/cases/:id/assign', (req, res) => {
  try {
    const d = db.getDB();
    const caseId = Number(req.params.id);
    const { assigned_to, next_action, next_action_due_date } = req.body;

    const caseRow = d.prepare(`SELECT * FROM cases WHERE id = ? AND is_deleted = 0`).get(caseId);
    if (!caseRow) return res.status(404).json({ success: false, error: 'Case not found' });

    if (!assigned_to) {
      return res.status(400).json({ success: false, error: 'assigned_to is required' });
    }

    const assignee = db.getUserById(Number(assigned_to));
    if (!assignee) return res.status(404).json({ success: false, error: 'User not found' });

    const setClauses = ['assigned_to = ?', "updated_at = datetime('now')"];
    const values = [Number(assigned_to)];

    if (next_action !== undefined) {
      setClauses.push('next_action = ?');
      values.push(next_action);
    }
    if (next_action_due_date !== undefined) {
      setClauses.push('next_action_due_date = ?');
      values.push(next_action_due_date);
    }

    values.push(caseId);
    d.prepare(`UPDATE cases SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

    d.prepare(
      `INSERT INTO case_timeline (case_id, action, actor, notes) VALUES (?, 'case_assigned', ?, ?)`
    ).run(caseId, req.user.name || req.user.email || 'system', `Assigned to ${assignee.full_name || assignee.username}`);

    res.json({ success: true, case_id: caseId, assigned_to: Number(assigned_to) });
  } catch (err) {
    console.error('[ASSIGN ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================
// Documents
// ============================================================

// POST /api/cases/:id/documents — upload docs
app.post('/api/cases/:id/documents', upload.array('documents', 20), (req, res) => {
  try {
    const d = db.getDB();
    const caseId = Number(req.params.id);

    const caseRow = d.prepare(`SELECT * FROM cases WHERE id = ? AND is_deleted = 0`).get(caseId);
    if (!caseRow) return res.status(404).json({ success: false, error: 'Case not found' });

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    const docIds = [];
    const jobIds = [];

    for (const file of req.files) {
      const filename = saveFileToDisk(file);
      const docType = req.body.doc_type || 'other';

      const docResult = d.prepare(`
        INSERT INTO documents (case_id, filename, original_name, mimetype, size_bytes, doc_type, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(caseId, filename, file.originalname, file.mimetype, file.size, docType, req.user.id);
      docIds.push(docResult.lastInsertRowid);

      // Create OCR job
      const jobResult = d.prepare(`
        INSERT INTO processing_jobs (case_id, document_id, job_type, status) VALUES (?, ?, 'ocr_extraction', 'queued')
      `).run(caseId, docResult.lastInsertRowid);
      jobIds.push(jobResult.lastInsertRowid);
    }

    // Re-trigger classification + completeness with dedupe
    const pipelineJobIds = insertPipelineJobs(caseId);
    jobIds.push(...pipelineJobIds);

    // Timeline
    d.prepare(
      `INSERT INTO case_timeline (case_id, action, actor, notes) VALUES (?, 'documents_uploaded', ?, ?)`
    ).run(caseId, req.user.name || req.user.email || 'system', `${req.files.length} document(s) uploaded`);

    res.status(201).json({ success: true, document_ids: docIds, job_ids: jobIds });
  } catch (err) {
    console.error('[UPLOAD DOCS ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/cases/:id/documents — list with requirement status
app.get('/api/cases/:id/documents', (req, res) => {
  try {
    const d = db.getDB();
    const caseId = Number(req.params.id);

    const caseRow = d.prepare(`SELECT claim_type, policy_type, insurer_name FROM cases WHERE id = ? AND is_deleted = 0`).get(caseId);
    if (!caseRow) return res.status(404).json({ success: false, error: 'Case not found' });

    const documents = d.prepare(`SELECT * FROM documents WHERE case_id = ? ORDER BY uploaded_at DESC`).all(caseId);

    // Count by doc_type
    const docCountByType = {};
    for (const doc of documents) {
      docCountByType[doc.doc_type] = (docCountByType[doc.doc_type] || 0) + 1;
    }

    // Requirements with status
    let requirements = [];
    if (caseRow.claim_type) {
      let reqSql = `SELECT * FROM document_requirements WHERE claim_type = ?`;
      const reqParams = [caseRow.claim_type];

      if (caseRow.policy_type) {
        reqSql += ` AND (policy_type IS NULL OR policy_type = ?)`;
        reqParams.push(caseRow.policy_type);
      } else {
        reqSql += ` AND policy_type IS NULL`;
      }

      if (caseRow.insurer_name) {
        reqSql += ` AND (insurer_specific IS NULL OR insurer_specific = ?)`;
        reqParams.push(caseRow.insurer_name);
      } else {
        reqSql += ` AND insurer_specific IS NULL`;
      }

      requirements = d.prepare(reqSql).all(...reqParams).map(r => ({
        ...r,
        uploaded_count: docCountByType[r.doc_type] || 0,
        satisfied: (docCountByType[r.doc_type] || 0) >= r.min_count,
      }));
    }

    res.json({ success: true, documents, requirements });
  } catch (err) {
    console.error('[GET DOCS ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/cases/:id/completeness — latest completeness result or trigger new
app.get('/api/cases/:id/completeness', (req, res) => {
  try {
    const d = db.getDB();
    const caseId = Number(req.params.id);

    const caseRow = d.prepare(`SELECT * FROM cases WHERE id = ? AND is_deleted = 0`).get(caseId);
    if (!caseRow) return res.status(404).json({ success: false, error: 'Case not found' });

    // Find latest completed completeness check
    const latest = d.prepare(
      `SELECT * FROM processing_jobs WHERE case_id = ? AND job_type = 'completeness_check' AND status = 'completed' ORDER BY completed_at DESC LIMIT 1`
    ).get(caseId);

    if (latest && latest.result) {
      let parsed;
      try {
        parsed = JSON.parse(latest.result);
      } catch (_) {
        parsed = latest.result;
      }
      return res.json({ success: true, completeness: parsed, job_id: latest.id, completed_at: latest.completed_at });
    }

    // Check if there's an active job
    const active = d.prepare(
      `SELECT id FROM processing_jobs WHERE case_id = ? AND job_type = 'completeness_check' AND status IN ('queued','locked','processing')`
    ).get(caseId);

    if (active) {
      return res.json({ success: true, completeness: null, job_id: active.id, status: 'processing', message: 'Completeness check in progress' });
    }

    // Trigger new completeness check
    const pipelineJobIds = insertPipelineJobs(caseId);
    const newJobId = pipelineJobIds.length > 0 ? pipelineJobIds[pipelineJobIds.length - 1] : null;

    res.json({ success: true, completeness: null, job_id: newJobId, status: 'queued', message: 'Completeness check triggered' });
  } catch (err) {
    console.error('[COMPLETENESS ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/cases/:id/submission-package — generate insurer submission summary
app.get('/api/cases/:id/submission-package', (req, res) => {
  try {
    const d = db.getDB();
    const caseId = Number(req.params.id);

    const caseRow = d.prepare(`SELECT * FROM cases WHERE id = ? AND is_deleted = 0`).get(caseId);
    if (!caseRow) return res.status(404).json({ success: false, error: 'Case not found' });

    const parties = d.prepare(`SELECT * FROM parties WHERE case_id = ?`).all(caseId);
    const vehicles = d.prepare(`SELECT * FROM vehicles WHERE case_id = ?`).all(caseId);
    const documents = d.prepare(`SELECT * FROM documents WHERE case_id = ?`).all(caseId);

    const summary = claimsEngine.generateSubmissionSummary({
      caseData: caseRow,
      parties,
      vehicles,
      documents,
    });

    // Timeline entry
    d.prepare(
      `INSERT INTO case_timeline (case_id, action, actor, notes) VALUES (?, 'submission_package_generated', ?, 'Insurer submission package generated')`
    ).run(caseId, req.user.name || req.user.email || 'system');

    res.json({ success: true, submission_package: summary });
  } catch (err) {
    console.error('[SUBMISSION PACKAGE ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================
// Processing Jobs
// ============================================================

// GET /api/jobs/:id — single job status
app.get('/api/jobs/:id', (req, res) => {
  try {
    const d = db.getDB();
    const jobId = Number(req.params.id);
    const job = d.prepare(`SELECT * FROM processing_jobs WHERE id = ?`).get(jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    // Parse result JSON if completed
    if (job.result) {
      try { job.result = JSON.parse(job.result); } catch (_) {}
    }

    res.json({ success: true, job });
  } catch (err) {
    console.error('[GET JOB ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/cases/:id/jobs — all jobs for case
app.get('/api/cases/:id/jobs', (req, res) => {
  try {
    const d = db.getDB();
    const caseId = Number(req.params.id);
    const jobs = d.prepare(`SELECT * FROM processing_jobs WHERE case_id = ? ORDER BY created_at ASC`).all(caseId);

    // Parse result JSON
    for (const job of jobs) {
      if (job.result) {
        try { job.result = JSON.parse(job.result); } catch (_) {}
      }
    }

    res.json({ success: true, jobs });
  } catch (err) {
    console.error('[GET CASE JOBS ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================
// Communications
// ============================================================

// POST /api/cases/:id/communications
app.post('/api/cases/:id/communications', (req, res) => {
  try {
    const d = db.getDB();
    const caseId = Number(req.params.id);

    const caseRow = d.prepare(`SELECT * FROM cases WHERE id = ? AND is_deleted = 0`).get(caseId);
    if (!caseRow) return res.status(404).json({ success: false, error: 'Case not found' });

    const { direction, channel, subject, body, response_type, follow_up_date } = req.body;
    if (!direction) {
      return res.status(400).json({ success: false, error: 'direction is required' });
    }

    const r = d.prepare(`
      INSERT INTO communications (case_id, direction, channel, subject, body, response_type, follow_up_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(caseId, direction, channel || null, subject || null, body || null, response_type || null, follow_up_date || null, req.user.id);

    // Auto-update last_contact_date on case
    d.prepare(`UPDATE cases SET last_contact_date = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(caseId);

    // Timeline
    d.prepare(
      `INSERT INTO case_timeline (case_id, action, actor, notes) VALUES (?, 'communication_added', ?, ?)`
    ).run(caseId, req.user.name || req.user.email || 'system', `${direction} via ${channel || 'unknown'}: ${subject || '(no subject)'}`);

    res.status(201).json({ success: true, communication_id: r.lastInsertRowid });
  } catch (err) {
    console.error('[ADD COMM ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/cases/:id/communications
app.get('/api/cases/:id/communications', (req, res) => {
  try {
    const d = db.getDB();
    const caseId = Number(req.params.id);
    const comms = d.prepare(`SELECT * FROM communications WHERE case_id = ? ORDER BY created_at DESC`).all(caseId);
    res.json({ success: true, communications: comms });
  } catch (err) {
    console.error('[GET COMMS ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================
// Decisions & Payments
// ============================================================

// POST /api/cases/:id/decisions — record insurer decision
app.post('/api/cases/:id/decisions', (req, res) => {
  try {
    const d = db.getDB();
    const caseId = Number(req.params.id);

    const caseRow = d.prepare(`SELECT * FROM cases WHERE id = ? AND is_deleted = 0`).get(caseId);
    if (!caseRow) return res.status(404).json({ success: false, error: 'Case not found' });

    const { decision_type, approved_amount, rejection_reason, decision_date, decision_document } = req.body;
    if (!decision_type) {
      return res.status(400).json({ success: false, error: 'decision_type is required' });
    }

    const r = d.prepare(`
      INSERT INTO decisions (case_id, decision_type, approved_amount, rejection_reason, decision_date, decision_document)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(caseId, decision_type, approved_amount || null, rejection_reason || null, decision_date || null, decision_document || null);

    // Auto-transition status based on decision type
    const statusMap = {
      approved: 'approved_by_insurer',
      partially_approved: 'partially_approved',
      rejected: 'rejected_by_insurer',
    };
    const newStatus = statusMap[decision_type];

    if (newStatus) {
      const allowed = TRANSITIONS[caseRow.status];
      if (allowed && allowed.includes(newStatus)) {
        const oldStatus = caseRow.status;
        d.prepare(`UPDATE cases SET status = ?, insurer_decision_at = datetime('now'), insurer_approved_amount = COALESCE(?, insurer_approved_amount), updated_at = datetime('now') WHERE id = ?`)
          .run(newStatus, approved_amount || null, caseId);

        d.prepare(
          `INSERT INTO case_timeline (case_id, action, old_status, new_status, actor, notes) VALUES (?, 'status_transition', ?, ?, ?, ?)`
        ).run(caseId, oldStatus, newStatus, req.user.name || req.user.email || 'system', `Insurer decision: ${decision_type}`);
      }
    }

    // Timeline entry for decision
    d.prepare(
      `INSERT INTO case_timeline (case_id, action, actor, notes) VALUES (?, 'decision_recorded', ?, ?)`
    ).run(caseId, req.user.name || req.user.email || 'system', `Decision: ${decision_type}${approved_amount ? `, amount: ${approved_amount}` : ''}${rejection_reason ? `, reason: ${rejection_reason}` : ''}`);

    res.status(201).json({ success: true, decision_id: r.lastInsertRowid });
  } catch (err) {
    console.error('[DECISION ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// POST /api/cases/:id/payments — record payment
app.post('/api/cases/:id/payments', (req, res) => {
  try {
    const d = db.getDB();
    const caseId = Number(req.params.id);

    const caseRow = d.prepare(`SELECT * FROM cases WHERE id = ? AND is_deleted = 0`).get(caseId);
    if (!caseRow) return res.status(404).json({ success: false, error: 'Case not found' });

    const { amount, payment_date, payment_method, reference, recipient_party_id } = req.body;
    if (!amount) {
      return res.status(400).json({ success: false, error: 'amount is required' });
    }

    const r = d.prepare(`
      INSERT INTO payments (case_id, amount, payment_date, payment_method, reference, recipient_party_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(caseId, amount, payment_date || null, payment_method || null, reference || null, recipient_party_id || null);

    // Calculate total paid
    const totalPaid = d.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE case_id = ?`).get(caseId).total;

    // Update paid_amount on case
    d.prepare(`UPDATE cases SET paid_amount = ?, updated_at = datetime('now') WHERE id = ?`).run(totalPaid, caseId);

    // Auto-transition to paid if total paid >= approved amount
    const approvedAmount = caseRow.insurer_approved_amount || caseRow.estimated_amount || 0;
    if (approvedAmount > 0 && totalPaid >= approvedAmount) {
      const allowed = TRANSITIONS[caseRow.status];
      if (allowed && allowed.includes('paid')) {
        const oldStatus = caseRow.status;
        d.prepare(`UPDATE cases SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(caseId);

        d.prepare(
          `INSERT INTO case_timeline (case_id, action, old_status, new_status, actor, notes) VALUES (?, 'status_transition', ?, 'paid', ?, ?)`
        ).run(caseId, oldStatus, req.user.name || req.user.email || 'system', `Auto-transitioned to paid: total ${totalPaid} >= approved ${approvedAmount}`);
      }
    }

    // Timeline
    d.prepare(
      `INSERT INTO case_timeline (case_id, action, actor, notes) VALUES (?, 'payment_recorded', ?, ?)`
    ).run(caseId, req.user.name || req.user.email || 'system', `Payment: ${amount} ${caseRow.currency || 'BGN'} via ${payment_method || 'unknown'}`);

    res.status(201).json({ success: true, payment_id: r.lastInsertRowid, total_paid: totalPaid });
  } catch (err) {
    console.error('[PAYMENT ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================
// Dashboard
// ============================================================

// GET /api/dashboard — KPIs
app.get('/api/dashboard', (req, res) => {
  try {
    const d = db.getDB();

    const openCount = d.prepare(
      `SELECT COUNT(*) as count FROM cases WHERE is_deleted = 0 AND status NOT IN ('closed', 'paid')`
    ).get().count;

    const awaitingDocsCount = d.prepare(
      `SELECT COUNT(*) as count FROM cases WHERE is_deleted = 0 AND status = 'awaiting_client_docs'`
    ).get().count;

    const submittedCount = d.prepare(
      `SELECT COUNT(*) as count FROM cases WHERE is_deleted = 0 AND status = 'submitted_to_insurer'`
    ).get().count;

    const overdueCount = d.prepare(
      `SELECT COUNT(*) as count FROM cases WHERE is_deleted = 0 AND next_action_due_date < date('now') AND status NOT IN ('closed', 'paid')`
    ).get().count;

    const avgDays = d.prepare(
      `SELECT AVG(JULIANDAY(COALESCE(closed_at, datetime('now'))) - JULIANDAY(created_at)) as avg_days FROM cases WHERE is_deleted = 0`
    ).get().avg_days;

    res.json({
      success: true,
      dashboard: {
        open: openCount,
        awaiting_docs: awaitingDocsCount,
        submitted: submittedCount,
        overdue: overdueCount,
        avg_days: avgDays ? Math.round(avgDays * 10) / 10 : 0,
      },
    });
  } catch (err) {
    console.error('[DASHBOARD ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/dashboard/workqueue — cases sorted by urgency
app.get('/api/dashboard/workqueue', (req, res) => {
  try {
    const d = db.getDB();
    const cases = d.prepare(`
      SELECT c.*, u.full_name as assignee_name,
        CASE
          WHEN c.next_action_due_date < date('now') AND c.status NOT IN ('closed', 'paid') THEN 1
          ELSE 0
        END as is_overdue
      FROM cases c
      LEFT JOIN users u ON c.assigned_to = u.id
      WHERE c.is_deleted = 0 AND c.status NOT IN ('closed', 'paid')
      ORDER BY
        is_overdue DESC,
        c.next_action_due_date ASC NULLS LAST,
        c.created_at ASC
    `).all();

    res.json({ success: true, cases });
  } catch (err) {
    console.error('[WORKQUEUE ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================
// EGN Reveal (audit-logged)
// ============================================================

// POST /api/cases/:id/reveal-egn — reveal full EGN for a party, log to audit_log
app.post('/api/cases/:id/reveal-egn', (req, res) => {
  try {
    const d = db.getDB();
    const caseId = Number(req.params.id);
    const { party_id } = req.body;

    if (!party_id) {
      return res.status(400).json({ success: false, error: 'party_id is required' });
    }

    const party = d.prepare(`SELECT * FROM parties WHERE id = ? AND case_id = ?`).get(Number(party_id), caseId);
    if (!party) return res.status(404).json({ success: false, error: 'Party not found' });

    // Log to audit_log
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    d.prepare(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, ip_address) VALUES (?, 'reveal_egn', 'party', ?, ?, ?)`
    ).run(req.user.id, party.id, JSON.stringify({ case_id: caseId, party_name: party.name }), ip);

    res.json({ success: true, egn: party.egn });
  } catch (err) {
    console.error('[REVEAL EGN ERROR]', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================
// Serve uploaded files (with auth)
// ============================================================

app.get('/uploads/:filename', (req, res) => {
  const filepath = path.join(uploadsDir, req.params.filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ success: false, error: 'File not found' });
  }
  res.sendFile(filepath);
});

// ============================================================
// Settings
// ============================================================

app.get('/api/settings', (req, res) => {
  try {
    const dbConn = db.getDB();
    const rows = dbConn.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    for (const r of rows) {
      try { settings[r.key] = JSON.parse(r.value); } catch { settings[r.key] = r.value; }
    }
    res.json({ success: true, settings });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.put('/api/settings', (req, res) => {
  try {
    const dbConn = db.getDB();
    const upsert = dbConn.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const entries = Object.entries(req.body);
    for (const [key, value] of entries) {
      upsert.run(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/settings/users', (req, res) => {
  try {
    const users = db.getUsers();
    res.json({ success: true, users: users.map(u => ({ id: u.id, username: u.username, full_name: u.full_name, role: u.role, created_at: u.created_at })) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// SPA Fallback
// ============================================================

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// Multer error handler
// ============================================================

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, error: 'File too large (max 10MB)' });
    }
    return res.status(400).json({ success: false, error: err.message });
  }
  if (err.message && err.message.includes('Only PDF, JPG, and PNG')) {
    return res.status(400).json({ success: false, error: err.message });
  }
  console.error('[UNHANDLED ERROR]', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ============================================================
// Startup
// ============================================================

db.initDB();
jobWorker.startWorker();

const server = app.listen(PORT, () => {
  console.log(`[AutomatON Claims] Server running on http://localhost:${PORT}`);
  console.log(`[AutomatON Claims] Fixture mode: ${process.env.FIXTURE_MODE || 'off'}`);
});

// ============================================================
// Graceful Shutdown
// ============================================================

function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  jobWorker.stopWorker();
  server.close(() => {
    console.log('[AutomatON Claims] HTTP server closed.');
    try {
      db.closeDB();
      console.log('[AutomatON Claims] Database closed.');
    } catch (_) {}
    process.exit(0);
  });
  // Force exit if graceful shutdown takes too long
  setTimeout(() => {
    console.error('[AutomatON Claims] Forced shutdown after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
