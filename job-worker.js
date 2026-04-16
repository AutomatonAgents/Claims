// job-worker.js — Async pipeline worker with locking, dependency resolution, stale lock recovery
// Processes: ocr_extraction, classification, completeness_check
// Runs on setInterval(2000) — polls every 2 seconds

const dbModule = require('./db');
const claimsEngine = require('./claims-engine');

// job-worker uses raw getDb().prepare() for complex job queries
// dbModule.getDB() returns the better-sqlite3 instance
function getDb() { return dbModule.getDB(); }

const fs = require('fs');
const path = require('path');

const FIXTURE_MODE = (process.env.FIXTURE_MODE || '').toLowerCase();
const POLL_INTERVAL = 2000;      // 2 seconds
const STALE_LOCK_SECONDS = 60;   // jobs locked > 60s are considered stale
const JOB_TIMEOUT_MS = 30000;    // 30s timeout per AI call

let intervalHandle = null;
let isProcessing = false;         // prevent overlapping ticks

// ─── Worker lifecycle ─────────────────────────────────────────────────────────

function startWorker() {
  if (intervalHandle) {
    console.log('[job-worker] Worker already running');
    return;
  }
  console.log(`[job-worker] Starting worker (poll=${POLL_INTERVAL}ms, fixture_mode=${FIXTURE_MODE || 'off'})`);
  intervalHandle = setInterval(tick, POLL_INTERVAL);
  // Run first tick immediately
  tick();
}

function stopWorker() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[job-worker] Worker stopped');
  }
}

// ─── Main tick ────────────────────────────────────────────────────────────────

async function tick() {
  if (isProcessing) return; // skip if previous tick still running
  isProcessing = true;

  try {
    // Step 1: Recover stale locks
    recoverStaleLocks();

    // Step 2: Pick next eligible job
    const job = pickNextJob();
    if (!job) {
      isProcessing = false;
      return;
    }

    // Step 3: Lock the job
    lockJob(job.id);
    console.log(`[job-worker] Processing job #${job.id} (${job.job_type}, case=${job.case_id}, doc=${job.document_id})`);

    // Step 4: Execute the job
    try {
      const result = await executeJob(job);

      // Step 5: Mark completed
      markCompleted(job.id, result);
      console.log(`[job-worker] Job #${job.id} completed`);

      // Step 6: After classification completes, trigger completeness check (with dedupe)
      if (job.job_type === 'classification' && job.case_id) {
        enqueueCompletenessIfNeeded(job.case_id, job.id);
      }

    } catch (err) {
      console.error(`[job-worker] Job #${job.id} failed:`, err.message);
      handleFailure(job, err.message);
    }

  } catch (err) {
    console.error('[job-worker] Tick error:', err.message);
  } finally {
    isProcessing = false;
  }
}

// ─── Stale lock recovery ──────────────────────────────────────────────────────

function recoverStaleLocks() {
  const staleThreshold = new Date(Date.now() - STALE_LOCK_SECONDS * 1000).toISOString();

  const stale = getDb().prepare(`
    UPDATE processing_jobs
    SET status = 'queued', locked_at = NULL
    WHERE status = 'locked'
    AND locked_at IS NOT NULL
    AND locked_at < ?
  `).run(staleThreshold);

  if (stale.changes > 0) {
    console.log(`[job-worker] Recovered ${stale.changes} stale locked job(s)`);
  }
}

// ─── Job picking with dependency resolution ───────────────────────────────────

function pickNextJob() {
  // Get all queued, unlocked jobs ordered by creation time
  const candidates = getDb().prepare(`
    SELECT * FROM processing_jobs
    WHERE status = 'queued'
    AND locked_at IS NULL
    ORDER BY created_at ASC
  `).all();

  for (const job of candidates) {
    if (isDependencyReady(job)) {
      return job;
    }
  }

  return null; // no eligible jobs
}

/**
 * Dependency resolution per PLAN.md:
 *   depends_on_type NULL → ready
 *   depends_on_type 'job_id' → depends_on_job_id must be completed
 *   depends_on_type 'all_ocr_for_case' → all OCR jobs for case completed/failed (handles deadlock)
 */
function isDependencyReady(job) {
  if (!job.depends_on_type) {
    return true; // no dependency
  }

  if (job.depends_on_type === 'job_id') {
    if (!job.depends_on_job_id) return true; // broken dependency, treat as ready
    const depJob = getDb().prepare('SELECT status FROM processing_jobs WHERE id = ?').get(job.depends_on_job_id);
    return depJob && depJob.status === 'completed';
  }

  if (job.depends_on_type === 'all_ocr_for_case') {
    if (!job.case_id) return true; // no case_id, treat as ready

    // Count OCR jobs that are NOT yet done (still queued/locked/processing)
    const pending = getDb().prepare(`
      SELECT COUNT(*) as count FROM processing_jobs
      WHERE case_id = ? AND job_type = 'ocr_extraction' AND status NOT IN ('completed', 'failed')
    `).get(job.case_id);

    if (pending.count > 0) {
      return false; // still waiting for OCR jobs to finish
    }

    // All OCR jobs are completed or failed — check for failures
    const failed = getDb().prepare(`
      SELECT COUNT(*) as count FROM processing_jobs
      WHERE case_id = ? AND job_type = 'ocr_extraction' AND status = 'failed'
    `).get(job.case_id);

    if (failed.count > 0) {
      // Run anyway with partial data, but log a note
      console.log(`[job-worker] Running ${job.job_type} for case ${job.case_id} with ${failed.count} failed OCR job(s) — partial data`);
      // Store note on the case about failed OCR
      try {
        getDb().prepare(`UPDATE cases SET ai_notes = COALESCE(ai_notes || '; ', '') || ? WHERE id = ?`)
          .run(`${failed.count} документ(а) не бяха разпознати (OCR failed)`, job.case_id);
      } catch { /* non-critical */ }
    }

    return true; // all OCR done (completed or failed)
  }

  // Unknown dependency type — treat as ready
  console.warn(`[job-worker] Unknown depends_on_type: ${job.depends_on_type}`);
  return true;
}

// ─── Job locking ──────────────────────────────────────────────────────────────

function lockJob(jobId) {
  getDb().prepare(`
    UPDATE processing_jobs
    SET status = 'locked', locked_at = datetime('now')
    WHERE id = ?
  `).run(jobId);
}

// ─── Job execution ────────────────────────────────────────────────────────────

async function executeJob(job) {
  switch (job.job_type) {
    case 'ocr_extraction':
      return await executeOCR(job);
    case 'classification':
      return await executeClassification(job);
    case 'completeness_check':
      return await executeCompleteness(job);
    default:
      throw new Error(`Unknown job type: ${job.job_type}`);
  }
}

/**
 * OCR extraction — process a single document.
 */
async function executeOCR(job) {
  if (!job.document_id) throw new Error('ocr_extraction job missing document_id');

  const doc = getDb().prepare('SELECT * FROM documents WHERE id = ?').get(job.document_id);
  if (!doc) throw new Error(`Document not found: ${job.document_id}`);

  // In fixture mode, use claims-engine fixture directly
  if (FIXTURE_MODE === 'force') {
    const docType = doc.doc_type || 'other';
    const result = claimsEngine.getFixture('ocr_extraction', { doc_type: docType });

    // Update document with extracted data
    _updateDocumentFromOCR(doc.id, result);

    return result;
  }

  // Read the file from disk
  const filePath = path.join(__dirname, 'uploads', doc.filename);
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const fileBuffer = fs.readFileSync(filePath);
  const result = await claimsEngine.extractDocument(fileBuffer, doc.mimetype, doc.original_name);

  // Update document with OCR results
  _updateDocumentFromOCR(doc.id, result);

  return result;
}

/**
 * Update document record with OCR extraction results.
 */
function _updateDocumentFromOCR(docId, result) {
  try {
    const updates = {
      ocr_raw: JSON.stringify(result),
      ocr_confidence: result.extraction_confidence || null
    };

    // Update doc_type if AI detected a different type
    if (result.document_type && result.document_type !== 'other') {
      updates.doc_type = result.document_type;
    }

    getDb().prepare(`
      UPDATE documents
      SET ocr_raw = ?, ocr_confidence = ?${updates.doc_type ? ', doc_type = ?' : ''}
      WHERE id = ?
    `).run(
      updates.ocr_raw,
      updates.ocr_confidence,
      ...(updates.doc_type ? [updates.doc_type] : []),
      docId
    );
  } catch (err) {
    console.error(`[job-worker] Failed to update document ${docId} with OCR result:`, err.message);
  }
}

/**
 * Classification — classify the case based on all OCR results.
 */
async function executeClassification(job) {
  if (!job.case_id) throw new Error('classification job missing case_id');

  const result = await claimsEngine.classifyCase(job.case_id);

  // Update case with classification results
  try {
    getDb().prepare(`
      UPDATE cases
      SET claim_type = ?, policy_type = ?, priority = ?, ai_notes = COALESCE(ai_notes || '; ', '') || ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      result.claim_type || null,
      result.policy_type || null,
      result.priority || 'normal',
      `Класификация: ${result.reasoning || ''}`,
      job.case_id
    );
  } catch (err) {
    console.error(`[job-worker] Failed to update case ${job.case_id} with classification:`, err.message);
  }

  return result;
}

/**
 * Completeness check — verify all required documents are present.
 */
async function executeCompleteness(job) {
  if (!job.case_id) throw new Error('completeness_check job missing case_id');

  const result = await claimsEngine.checkCompleteness(job.case_id);

  // Update case based on completeness
  try {
    const nextAction = result.ready_to_submit
      ? 'Случаят е готов за изпращане към застрахователя'
      : result.next_recommended_action || 'Проверете липсващи документи';

    getDb().prepare(`
      UPDATE cases
      SET ai_notes = COALESCE(ai_notes || '; ', '') || ?,
          next_action = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      `Пълнота: ${result.complete ? 'пълен' : 'непълен'}, липсващи задължителни: ${(result.missing_required || []).length}`,
      nextAction,
      job.case_id
    );
  } catch (err) {
    console.error(`[job-worker] Failed to update case ${job.case_id} with completeness:`, err.message);
  }

  return result;
}

// ─── Job completion & failure ─────────────────────────────────────────────────

function markCompleted(jobId, result) {
  getDb().prepare(`
    UPDATE processing_jobs
    SET status = 'completed',
        result = ?,
        completed_at = datetime('now'),
        locked_at = NULL
    WHERE id = ?
  `).run(JSON.stringify(result), jobId);
}

function handleFailure(job, errorMessage) {
  const newAttempts = (job.attempts || 0) + 1;

  if (newAttempts >= (job.max_attempts || 3)) {
    // Max attempts reached — mark as failed
    getDb().prepare(`
      UPDATE processing_jobs
      SET status = 'failed',
          error = ?,
          attempts = ?,
          locked_at = NULL
      WHERE id = ?
    `).run(errorMessage, newAttempts, job.id);
    console.log(`[job-worker] Job #${job.id} failed permanently after ${newAttempts} attempts`);
  } else {
    // Requeue for retry
    getDb().prepare(`
      UPDATE processing_jobs
      SET status = 'queued',
          error = ?,
          attempts = ?,
          locked_at = NULL
      WHERE id = ?
    `).run(errorMessage, newAttempts, job.id);
    console.log(`[job-worker] Job #${job.id} requeued (attempt ${newAttempts}/${job.max_attempts || 3})`);
  }
}

// ─── Job dedupe + enqueue helpers ─────────────────────────────────────────────

/**
 * Check if an active (queued/locked/processing) job of the given type exists for the case.
 * Returns true if a duplicate exists.
 */
function hasActiveJob(caseId, jobType) {
  const existing = getDb().prepare(`
    SELECT id FROM processing_jobs
    WHERE case_id = ? AND job_type = ? AND status IN ('queued', 'locked', 'processing')
    LIMIT 1
  `).get(caseId, jobType);
  return !!existing;
}

/**
 * Enqueue a classification job for a case (with dedupe).
 * depends_on_type = 'all_ocr_for_case'
 * Returns the job id or null if duplicate.
 */
function enqueueClassificationIfNeeded(caseId) {
  if (hasActiveJob(caseId, 'classification')) {
    console.log(`[job-worker] Skipping classification enqueue for case ${caseId} — active job exists`);
    return null;
  }

  const result = getDb().prepare(`
    INSERT INTO processing_jobs (case_id, job_type, status, depends_on_type)
    VALUES (?, 'classification', 'queued', 'all_ocr_for_case')
  `).run(caseId);

  console.log(`[job-worker] Enqueued classification job #${result.lastInsertRowid} for case ${caseId}`);
  return result.lastInsertRowid;
}

/**
 * Enqueue a completeness_check job for a case (with dedupe).
 * depends_on_type = 'job_id', depends on the classification job.
 * Returns the job id or null if duplicate.
 */
function enqueueCompletenessIfNeeded(caseId, classificationJobId) {
  if (hasActiveJob(caseId, 'completeness_check')) {
    console.log(`[job-worker] Skipping completeness enqueue for case ${caseId} — active job exists`);
    return null;
  }

  const result = getDb().prepare(`
    INSERT INTO processing_jobs (case_id, job_type, status, depends_on_type, depends_on_job_id)
    VALUES (?, 'completeness_check', 'queued', 'job_id', ?)
  `).run(caseId, classificationJobId);

  console.log(`[job-worker] Enqueued completeness job #${result.lastInsertRowid} for case ${caseId} (depends on classification #${classificationJobId})`);
  return result.lastInsertRowid;
}

/**
 * Enqueue the full pipeline for a document upload:
 *   1. OCR extraction job (no dependency)
 *   2. Classification job with all_ocr_for_case dependency (deduped)
 *   3. Completeness job depending on classification (deduped)
 */
function enqueuePipeline(caseId, documentId) {
  // 1. OCR extraction — always created per document
  const ocrResult = getDb().prepare(`
    INSERT INTO processing_jobs (case_id, document_id, job_type, status, depends_on_type)
    VALUES (?, ?, 'ocr_extraction', 'queued', NULL)
  `).run(caseId, documentId);
  const ocrJobId = ocrResult.lastInsertRowid;
  console.log(`[job-worker] Enqueued OCR job #${ocrJobId} for doc ${documentId}, case ${caseId}`);

  // 2. Classification — deduped, depends on all OCR for case
  const classJobId = enqueueClassificationIfNeeded(caseId);

  // 3. Completeness — deduped, depends on classification
  // If classification was just enqueued, depend on it; otherwise find existing active one
  if (classJobId) {
    enqueueCompletenessIfNeeded(caseId, classJobId);
  } else {
    // Find the existing active classification job to depend on
    const existingClassJob = getDb().prepare(`
      SELECT id FROM processing_jobs
      WHERE case_id = ? AND job_type = 'classification' AND status IN ('queued', 'locked', 'processing')
      ORDER BY created_at DESC LIMIT 1
    `).get(caseId);

    if (existingClassJob) {
      enqueueCompletenessIfNeeded(caseId, existingClassJob.id);
    }
  }

  return { ocrJobId, classJobId };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  startWorker,
  stopWorker,
  enqueuePipeline,
  enqueueClassificationIfNeeded,
  enqueueCompletenessIfNeeded,
  hasActiveJob
};
