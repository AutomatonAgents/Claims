// claims-engine.js — AI orchestration: prompts, extraction, classification, completeness, submission summary
// Uses ai/ abstraction layer for multi-provider support, db for case/document data

const ai = require('./ai');
const dbModule = require('./db');
function db() { return dbModule.getDB(); }
const path = require('path');
const fs = require('fs');

const FIXTURE_MODE = (process.env.FIXTURE_MODE || '').toLowerCase();
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * getFixture(jobType, context) — returns pre-built fixture JSON when FIXTURE_MODE=force.
 *
 * Resolution:
 *   ocr_extraction:     match by context.doc_type → fixtures/ocr/{doc_type}.json, fallback generic.json
 *   classification:     match by context.scenario → fixtures/classification/{scenario}.json
 *   completeness_check: match by context.scenario → fixtures/completeness/{scenario}.json
 */
function getFixture(jobType, context = {}) {
  let fixturePath;

  switch (jobType) {
    case 'ocr_extraction': {
      const docType = context.doc_type || 'generic';
      fixturePath = path.join(FIXTURES_DIR, 'ocr', `${docType}.json`);
      // Fallback to generic if specific doc_type fixture doesn't exist
      if (!fs.existsSync(fixturePath)) {
        fixturePath = path.join(FIXTURES_DIR, 'ocr', 'generic.json');
      }
      break;
    }

    case 'classification': {
      const scenario = context.scenario || 'auto-collision';
      fixturePath = path.join(FIXTURES_DIR, 'classification', `${scenario}.json`);
      break;
    }

    case 'completeness_check': {
      // scenario should be like "auto-collision-complete" or "auto-collision-incomplete"
      const scenario = context.scenario || 'auto-collision-incomplete';
      fixturePath = path.join(FIXTURES_DIR, 'completeness', `${scenario}.json`);
      break;
    }

    default:
      throw new Error(`Unknown job type for fixture: ${jobType}`);
  }

  if (!fs.existsSync(fixturePath)) {
    return _getFallbackFixture(jobType, context);
  }

  try {
    const raw = fs.readFileSync(fixturePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[claims-engine] Failed to parse fixture ${fixturePath}:`, err.message);
    return _getFallbackFixture(jobType, context);
  }
}

/**
 * Built-in fallback fixtures when no file exists on disk.
 * Ensures demo never fails even without fixture files.
 */
function _getFallbackFixture(jobType, context = {}) {
  switch (jobType) {
    case 'ocr_extraction':
      return {
        document_type: context.doc_type || 'other',
        extraction_confidence: 0.3,
        extracted_fields: {
          incident_date: null,
          incident_location: null,
          parties: [],
          vehicles: [],
          policy_number: null,
          kat_protocol_number: null,
          damage_description: 'Не може да се извлече информация (fixture fallback)',
          amounts: []
        },
        quality_issues: ['low_quality_fixture_fallback'],
        low_confidence_fields: []
      };

    case 'classification':
      return {
        claim_type: 'auto_collision',
        policy_type: 'casco',
        priority: 'normal',
        reasoning: 'Автоматична класификация (fixture fallback)'
      };

    case 'completeness_check':
      return {
        complete: false,
        missing_required: [],
        missing_conditional: [],
        missing_optional: [],
        inconsistencies: [],
        next_recommended_action: 'Проверете документите ръчно (fixture fallback)',
        ready_to_submit: false
      };

    default:
      return { error: 'Unknown job type', job_type: jobType };
  }
}

// ─── OCR Extraction ───────────────────────────────────────────────────────────

const OCR_SYSTEM_PROMPT = `You are an AI assistant for an insurance broker in Bulgaria.
Extract structured data from this claim document. Return JSON:
{
  "document_type": "bilateral_statement|kat_protocol|damage_photo|repair_invoice|police_report|policy_copy|id_copy|vehicle_registration|vehicle_keys_declaration|ownership_proof|incident_report|expert_assessment|power_of_attorney|other",
  "extraction_confidence": 0.0-1.0,
  "extracted_fields": {
    "incident_date": "DD.MM.YYYY or null",
    "incident_location": "string or null",
    "parties": [
      {
        "name": "string",
        "role": "driver|owner|witness|counterparty_driver|counterparty_owner",
        "egn": "string or null",
        "vehicle_reg": "string or null",
        "is_at_fault": true/false/null
      }
    ],
    "vehicles": [
      {
        "role": "claimant_vehicle|counterparty_vehicle",
        "reg_no": "string or null",
        "make_model": "string or null",
        "vin": "string or null",
        "damage_description": "string or null"
      }
    ],
    "policy_number": "string or null",
    "kat_protocol_number": "string or null",
    "damage_description": "string in Bulgarian",
    "amounts": [{"description": "...", "amount": 0.00, "currency": "BGN"}]
  },
  "quality_issues": ["blurry_image", "partially_obscured", "handwritten_hard_to_read", "missing_signature"],
  "low_confidence_fields": ["field_name_1", "field_name_2"]
}
Focus on accuracy. Flag uncertain fields. Do NOT guess — return null and flag it.`;

/**
 * extractDocument(fileBuffer, mimetype, originalName) — OCR extraction via AI vision.
 * Returns parsed JSON extraction result.
 */
async function extractDocument(fileBuffer, mimetype, originalName) {
  // In fixture mode, resolve doc_type from filename heuristics
  if (FIXTURE_MODE === 'force') {
    const docType = _guessDocTypeFromFilename(originalName, mimetype);
    return getFixture('ocr_extraction', { doc_type: docType });
  }

  const prompt = `${OCR_SYSTEM_PROMPT}\n\nDocument filename: ${originalName}`;
  const result = await ai.callVision(fileBuffer, mimetype, prompt, {
    maxTokens: 3000,
    timeoutMs: 60000
  });
  return result;
}

/**
 * Guess doc_type from filename patterns for fixture resolution.
 */
function _guessDocTypeFromFilename(filename, mimetype) {
  const lower = (filename || '').toLowerCase();

  if (lower.includes('bilateral') || lower.includes('двустранен') || lower.includes('protokol'))
    return 'bilateral_statement';
  if (lower.includes('kat') || lower.includes('кат'))
    return 'kat_protocol';
  if (lower.includes('police') || lower.includes('полиц') || lower.includes('мвр'))
    return 'police_report';
  if (lower.includes('damage') || lower.includes('щета') || lower.includes('photo') || lower.includes('снимк'))
    return 'damage_photo';
  if (lower.includes('invoice') || lower.includes('фактура') || lower.includes('repair') || lower.includes('сервиз'))
    return 'repair_invoice';
  if (lower.includes('expert') || lower.includes('вещо') || lower.includes('оценка'))
    return 'expert_assessment';
  if (lower.includes('policy') || lower.includes('полица') || lower.includes('полицa'))
    return 'policy_copy';
  if (lower.includes('id_copy') || lower.includes('лична_карта') || lower.includes('лк'))
    return 'id_copy';
  if (lower.includes('registration') || lower.includes('талон'))
    return 'vehicle_registration';
  if (lower.includes('keys') || lower.includes('ключове'))
    return 'vehicle_keys_declaration';
  if (lower.includes('ownership') || lower.includes('собственост'))
    return 'ownership_proof';
  if (lower.includes('incident') || lower.includes('описание') || lower.includes('report'))
    return 'incident_report';
  if (lower.includes('power') || lower.includes('пълномощно'))
    return 'power_of_attorney';

  // Image files are likely damage photos
  if (mimetype && mimetype.startsWith('image/'))
    return 'damage_photo';

  return 'other';
}

// ─── Classification ───────────────────────────────────────────────────────────

const CLASSIFICATION_PROMPT = `Based on extracted data from all documents, classify this insurance claim.
Return JSON only:
{
  "claim_type": "auto_collision|auto_theft|auto_glass|property_fire|property_flood|property_theft",
  "policy_type": "casco|mtpl|property",
  "priority": "urgent|high|normal|low",
  "reasoning": "brief explanation in Bulgarian"
}`;

/**
 * classifyCase(caseId) — reads all completed OCR extractions for a case,
 * builds combined context, calls AI with classification prompt.
 * Returns classification JSON.
 */
async function classifyCase(caseId) {
  // Gather all completed OCR results for this case
  const ocrJobs = db().prepare(`
    SELECT pj.result, d.doc_type, d.original_name
    FROM processing_jobs pj
    LEFT JOIN documents d ON d.id = pj.document_id
    WHERE pj.case_id = ? AND pj.job_type = 'ocr_extraction' AND pj.status = 'completed' AND pj.result IS NOT NULL
  `).all(caseId);

  const extractions = ocrJobs.map(j => {
    try {
      return {
        doc_type: j.doc_type,
        original_name: j.original_name,
        extraction: JSON.parse(j.result)
      };
    } catch {
      return { doc_type: j.doc_type, original_name: j.original_name, extraction: null };
    }
  }).filter(e => e.extraction);

  // In fixture mode, determine scenario from document types
  if (FIXTURE_MODE === 'force') {
    const caseRow = db().prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
    const scenario = _inferClassificationScenario(extractions);
    const fixturePath = path.join(FIXTURES_DIR, 'classification', `${scenario}.json`);
    if (fs.existsSync(fixturePath)) {
      return getFixture('classification', { scenario, caseRow });
    }
    return _buildClassificationFixture(scenario, caseRow);
  }

  // Build combined context for AI
  const contextLines = extractions.map((e, i) =>
    `Document ${i + 1} (${e.doc_type || 'unknown'}, ${e.original_name}):\n${JSON.stringify(e.extraction.extracted_fields || e.extraction, null, 2)}`
  ).join('\n\n---\n\n');

  const caseRow = db().prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  const caseContext = caseRow
    ? `Case info: incident_date=${caseRow.incident_date || 'unknown'}, location=${caseRow.incident_location || 'unknown'}, description=${caseRow.incident_description || 'none'}`
    : '';

  const userMessage = `${caseContext}\n\nExtracted data from ${extractions.length} documents:\n\n${contextLines}`;

  const rawResponse = await ai.callChat(CLASSIFICATION_PROMPT, userMessage, {
    maxTokens: 500,
    timeoutMs: 30000
  });

  return ai.extractJSON(rawResponse);
}

/**
 * Infer classification scenario from document types (for fixture mode).
 */
function _inferClassificationScenario(extractions) {
  const docTypes = new Set(extractions.map(e => {
    const extraction = e.extraction;
    return extraction.document_type || e.doc_type || 'other';
  }));

  // Auto theft indicators
  if (docTypes.has('vehicle_keys_declaration')) return 'auto-theft';

  // Property indicators
  if (docTypes.has('ownership_proof')) {
    // Check extracted descriptions for fire/flood/theft keywords
    for (const e of extractions) {
      const desc = JSON.stringify(e.extraction).toLowerCase();
      if (desc.includes('пожар') || desc.includes('fire')) return 'property-fire';
      if (desc.includes('наводнение') || desc.includes('flood')) return 'property-flood';
      if (desc.includes('кражба') && docTypes.has('police_report')) return 'property-theft';
    }
    return 'property-fire'; // default property
  }

  // Auto glass — only damage photos + no bilateral/kat
  if (docTypes.has('damage_photo') && !docTypes.has('bilateral_statement') && !docTypes.has('kat_protocol') && extractions.length <= 3) {
    return 'auto-glass';
  }

  // Default: auto collision (most common)
  return 'auto-collision';
}

// ─── Completeness Check ───────────────────────────────────────────────────────

const COMPLETENESS_PROMPT_TEMPLATE = `Given case with claim_type={claim_type}, insurer={insurer}, and uploaded documents: {doc_list_with_counts},
check against required document checklist: {requirements}.
Return JSON only:
{
  "complete": true/false,
  "missing_required": [{"doc_type": "...", "description_bg": "...", "min_needed": N, "have": N, "suggestion": "how to obtain"}],
  "missing_conditional": [{"doc_type": "...", "description_bg": "...", "condition": "...", "likely_needed": true/false, "reasoning": "..."}],
  "missing_optional": [{"doc_type": "...", "description_bg": "...", "benefit": "why it helps the claim"}],
  "inconsistencies": [{"field": "...", "doc1_value": "...", "doc2_value": "...", "issue_bg": "..."}],
  "next_recommended_action": "string in Bulgarian",
  "ready_to_submit": true/false
}`;

/**
 * checkCompleteness(caseId) — reads case data + documents + requirements,
 * calls AI with completeness prompt. Returns completeness JSON.
 */
async function checkCompleteness(caseId) {
  const caseRow = db().prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!caseRow) throw new Error(`Case not found: ${caseId}`);

  const claimType = caseRow.claim_type || 'auto_collision';
  const insurer = caseRow.insurer_name || 'неизвестен';
  const policyType = caseRow.policy_type || null;

  // Get uploaded documents with counts per doc_type
  const docs = db().prepare(`
    SELECT doc_type, COUNT(*) as count
    FROM documents
    WHERE case_id = ? AND doc_type IS NOT NULL
    GROUP BY doc_type
  `).all(caseId);

  const docCountMap = {};
  docs.forEach(d => { docCountMap[d.doc_type] = d.count; });

  // Get document requirements for this claim_type
  const requirements = db().prepare(`
    SELECT * FROM document_requirements
    WHERE claim_type = ?
    AND (policy_type IS NULL OR policy_type = ?)
    AND (insurer_specific IS NULL OR insurer_specific = ?)
    ORDER BY requirement ASC, doc_type ASC
  `).all(claimType, policyType, insurer);

  // Also get insurer-specific overrides
  const insurerOverrides = db().prepare(`
    SELECT * FROM document_requirements
    WHERE claim_type = ? AND insurer_specific = ?
  `).all(claimType, insurer);

  // Merge overrides into requirements
  const reqMap = new Map();
  for (const r of requirements) {
    reqMap.set(r.doc_type, r);
  }
  for (const o of insurerOverrides) {
    reqMap.set(o.doc_type, o); // override
  }
  const mergedRequirements = Array.from(reqMap.values());

  // In fixture mode, determine scenario
  if (FIXTURE_MODE === 'force') {
    const scenario = _inferCompletenessScenario(claimType, docCountMap, mergedRequirements);
    const fixturePath = path.join(FIXTURES_DIR, 'completeness', `${scenario}.json`);
    if (fs.existsSync(fixturePath)) {
      return getFixture('completeness_check', { scenario, docCountMap, requirements: mergedRequirements });
    }
    return _buildCompletenessFixture(docCountMap, mergedRequirements);
  }

  // Build AI prompt
  const docListStr = Object.entries(docCountMap)
    .map(([type, count]) => `${type}: ${count}`)
    .join(', ') || 'няма качени документи';

  const reqListStr = mergedRequirements.map(r =>
    `${r.doc_type} (${r.requirement}, мин. ${r.min_count}${r.condition_description ? ', условие: ' + r.condition_description : ''}) — ${r.description_bg}`
  ).join('\n');

  // Get OCR extraction results for inconsistency checking
  const ocrResults = db().prepare(`
    SELECT pj.result, d.doc_type, d.original_name
    FROM processing_jobs pj
    LEFT JOIN documents d ON d.id = pj.document_id
    WHERE pj.case_id = ? AND pj.job_type = 'ocr_extraction' AND pj.status = 'completed' AND pj.result IS NOT NULL
  `).all(caseId);

  const extractionsSummary = ocrResults.map(j => {
    try {
      const parsed = JSON.parse(j.result);
      return `${j.doc_type}: ${JSON.stringify(parsed.extracted_fields || {}, null, 2)}`;
    } catch { return null; }
  }).filter(Boolean).join('\n\n');

  const prompt = COMPLETENESS_PROMPT_TEMPLATE
    .replace('{claim_type}', claimType)
    .replace('{insurer}', insurer)
    .replace('{doc_list_with_counts}', docListStr)
    .replace('{requirements}', reqListStr);

  const userMessage = `${prompt}\n\nExtracted data from documents:\n${extractionsSummary}`;

  const rawResponse = await ai.callChat(
    'You are a completeness checker for an insurance broker in Bulgaria. Analyze documents against requirements.',
    userMessage,
    { maxTokens: 2000, timeoutMs: 30000 }
  );

  return ai.extractJSON(rawResponse);
}

/**
 * Infer completeness scenario for fixture mode.
 */
function _inferCompletenessScenario(claimType, docCountMap, requirements) {
  const typeSlug = claimType.replace(/_/g, '-'); // auto_collision → auto-collision

  // Check if all required docs meet min_count
  const requiredDocs = requirements.filter(r => r.requirement === 'required');
  let allMet = true;
  for (const req of requiredDocs) {
    const have = docCountMap[req.doc_type] || 0;
    if (have < req.min_count) {
      allMet = false;
      break;
    }
  }

  return `${typeSlug}-${allMet ? 'complete' : 'incomplete'}`;
}

// ─── Submission Summary ───────────────────────────────────────────────────────

function _buildClassificationFixture(scenario, caseRow) {
  const fallback = {
    claim_type: 'auto_collision',
    policy_type: caseRow && caseRow.policy_type ? caseRow.policy_type : 'casco',
    priority: caseRow && caseRow.priority ? caseRow.priority : 'normal',
    reasoning: 'Автоматична класификация (fixture fallback)'
  };

  const byScenario = {
    'auto-collision': { claim_type: 'auto_collision', policy_type: caseRow && caseRow.policy_type ? caseRow.policy_type : 'casco', priority: 'normal' },
    'auto-theft': { claim_type: 'auto_theft', policy_type: 'casco', priority: 'high' },
    'auto-glass': { claim_type: 'auto_glass', policy_type: 'casco', priority: 'normal' },
    'property-fire': { claim_type: 'property_fire', policy_type: 'property', priority: 'high' },
    'property-flood': { claim_type: 'property_flood', policy_type: 'property', priority: 'normal' },
    'property-theft': { claim_type: 'property_theft', policy_type: 'property', priority: 'high' }
  };

  return {
    ...fallback,
    ...(byScenario[scenario] || {}),
    reasoning: 'Автоматична класификация (fixture fallback)'
  };
}

function _buildCompletenessFixture(docCountMap = {}, requirements = []) {
  const requirementList = Array.isArray(requirements) ? requirements : [];
  const missingRequired = requirementList
    .filter(req => req.requirement === 'required')
    .filter(req => (docCountMap[req.doc_type] || 0) < (req.min_count || 1))
    .map(req => ({
      doc_type: req.doc_type,
      description_bg: req.description_bg,
      min_needed: req.min_count || 1,
      have: docCountMap[req.doc_type] || 0,
      suggestion: 'Изискайте документа от клиента'
    }));

  const missingConditional = requirementList
    .filter(req => req.requirement === 'conditional')
    .filter(req => (docCountMap[req.doc_type] || 0) < (req.min_count || 1))
    .map(req => ({
      doc_type: req.doc_type,
      description_bg: req.description_bg,
      condition: req.condition_description || '',
      likely_needed: false,
      reasoning: 'Нужен е само ако условието е изпълнено'
    }));

  const missingOptional = requirementList
    .filter(req => req.requirement === 'optional')
    .filter(req => (docCountMap[req.doc_type] || 0) < (req.min_count || 1))
    .map(req => ({
      doc_type: req.doc_type,
      description_bg: req.description_bg,
      benefit: 'Подсилва доказателствата по щетата'
    }));

  const readyToSubmit = missingRequired.length === 0;
  return {
    complete: readyToSubmit,
    missing_required: missingRequired,
    missing_conditional: missingConditional,
    missing_optional: missingOptional,
    inconsistencies: [],
    next_recommended_action: readyToSubmit
      ? 'Случаят е готов за изпращане към застрахователя'
      : 'Изискайте липсващите задължителни документи от клиента',
    ready_to_submit: readyToSubmit
  };
}

const SUBMISSION_SUMMARY_PROMPT = `Generate structured summary for insurer submission package.
Return JSON only:
{
  "case_summary_bg": "professional paragraph in Bulgarian",
  "key_facts": ["fact1", "fact2"],
  "documents_included": [{"doc_type": "...", "description": "...", "count": N}],
  "parties_summary": [{"name": "...", "role": "...", "vehicle": "..."}],
  "total_claimed_amount": 0.00,
  "supporting_evidence_strength": "strong|adequate|weak"
}`;

/**
 * generateSubmissionSummary(caseId) — reads full case data, calls AI.
 * Returns submission summary JSON.
 */
async function generateSubmissionSummary(caseId) {
  const caseRow = db().prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!caseRow) throw new Error(`Case not found: ${caseId}`);

  const parties = db().prepare('SELECT * FROM parties WHERE case_id = ?').all(caseId);
  const vehicles = db().prepare('SELECT * FROM vehicles WHERE case_id = ?').all(caseId);
  const docs = db().prepare('SELECT doc_type, COUNT(*) as count FROM documents WHERE case_id = ? GROUP BY doc_type').all(caseId);

  // Get OCR extraction results
  const ocrResults = db().prepare(`
    SELECT pj.result, d.doc_type
    FROM processing_jobs pj
    LEFT JOIN documents d ON d.id = pj.document_id
    WHERE pj.case_id = ? AND pj.job_type = 'ocr_extraction' AND pj.status = 'completed' AND pj.result IS NOT NULL
  `).all(caseId);

  // Get classification result
  const classificationJob = db().prepare(`
    SELECT result FROM processing_jobs
    WHERE case_id = ? AND job_type = 'classification' AND status = 'completed' AND result IS NOT NULL
    ORDER BY completed_at DESC LIMIT 1
  `).get(caseId);

  const classification = classificationJob ? _safeParseJSON(classificationJob.result) : null;

  // Build context
  const caseContext = {
    case_number: caseRow.case_number,
    claim_type: caseRow.claim_type || (classification ? classification.claim_type : 'unknown'),
    policy_type: caseRow.policy_type || (classification ? classification.policy_type : 'unknown'),
    insurer: caseRow.insurer_name,
    incident_date: caseRow.incident_date,
    incident_location: caseRow.incident_location,
    incident_description: caseRow.incident_description,
    estimated_amount: caseRow.estimated_amount,
    policy_number: caseRow.policy_number
  };

  const partiesSummary = parties.map(p => ({
    name: p.name,
    role: p.role,
    egn: p.egn ? `****${p.egn.slice(-4)}` : null
  }));

  const vehiclesSummary = vehicles.map(v => ({
    role: v.role,
    reg_no: v.reg_no,
    make_model: `${v.make || ''} ${v.model || ''}`.trim(),
    damage: v.damage_description
  }));

  const extractionsSummary = ocrResults.map(j => {
    try {
      const parsed = JSON.parse(j.result);
      return { doc_type: j.doc_type, extracted: parsed.extracted_fields || {} };
    } catch { return null; }
  }).filter(Boolean);

  // In fixture mode, return a generic submission summary
  if (FIXTURE_MODE === 'force') {
    return {
      case_summary_bg: `Застрахователен случай ${caseRow.case_number}. ${caseRow.incident_description || 'Произшествие без допълнително описание.'}`,
      key_facts: [
        `Дата на произшествие: ${caseRow.incident_date || 'неизвестна'}`,
        `Място: ${caseRow.incident_location || 'неизвестно'}`,
        `Тип: ${caseRow.claim_type || 'неопределен'}`,
        `Застраховател: ${caseRow.insurer_name || 'неизвестен'}`
      ],
      documents_included: docs.map(d => ({
        doc_type: d.doc_type,
        description: d.doc_type,
        count: d.count
      })),
      parties_summary: parties.map(p => ({
        name: p.name,
        role: p.role,
        vehicle: vehicles.find(v => v.owner_party_id === p.id || v.driver_party_id === p.id)?.reg_no || null
      })),
      total_claimed_amount: caseRow.estimated_amount || 0,
      supporting_evidence_strength: docs.length >= 4 ? 'strong' : docs.length >= 2 ? 'adequate' : 'weak'
    };
  }

  const userMessage = `Case data:
${JSON.stringify(caseContext, null, 2)}

Parties:
${JSON.stringify(partiesSummary, null, 2)}

Vehicles:
${JSON.stringify(vehiclesSummary, null, 2)}

Documents (${docs.length} types):
${docs.map(d => `${d.doc_type}: ${d.count}`).join(', ')}

Extraction summaries:
${JSON.stringify(extractionsSummary, null, 2)}`;

  const rawResponse = await ai.callChat(
    SUBMISSION_SUMMARY_PROMPT,
    userMessage,
    { maxTokens: 2000, timeoutMs: 30000 }
  );

  return ai.extractJSON(rawResponse);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  extractDocument,
  classifyCase,
  checkCompleteness,
  generateSubmissionSummary,
  getFixture
};
