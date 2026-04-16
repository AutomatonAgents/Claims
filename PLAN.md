# AutomatON Claims — Insurance Broker Case Management Demo
## Target: Amarant Bulgaria (Застрахователен брокер)

## Context
Amarant is an insurance BROKER — they do NOT approve or reject claims. They:
1. Receive client's incident report + documents
2. Validate completeness (are all required docs present?)
3. Package and submit to the insurer
4. Follow up with the insurer on behalf of the client
5. Communicate insurer decisions back to the client
6. Track payments

The broker's value = speed of intake, completeness checking, organized submission, follow-up tracking.

## What the Demo Must Show (to close the deal)
1. **Upload claim documents** (photos, PDFs — damage photos, KAT protocol, bilateral statement, repair invoices)
2. **AI OCR extraction** — extract structured data from messy documents (dates, names, EGN, policy #, vehicle reg, amounts)
3. **Missing document detection** — AI checks what's uploaded vs what's required for this claim type, flags gaps
4. **Auto-classification** — claim type (Каско, ГО/MTPL, имущество, здраве, пътуване)
5. **Broker case pipeline** — received → awaiting docs → validated → submitted to insurer → awaiting decision → approved/rejected by insurer → paid → closed
6. **Insurer submission package** — one-click generate organized package for the insurer
7. **Professional UI** — inbox/work queue, not just dashboards. Bulgarian language throughout.

## Broker Workflow (State Machine)
```
received                    — client reported incident, case opened
  ↓
awaiting_client_docs        — some required documents missing, waiting on client
  ↓
validated_by_broker         — all docs present, data extracted, ready to submit
  ↓
submitted_to_insurer        — package sent to insurance company
  ↓
insurer_requested_info      — insurer asked for additional evidence/clarification
  ↓
awaiting_insurer_decision   — complete package with insurer, waiting for ruling
  ↓
approved_by_insurer         — insurer approved the claim
rejected_by_insurer         — insurer rejected (with reason)
  ↓
paid                        — payment received by client
  ↓
closed                      — case archived
```
Transitions are role-restricted. Every transition logged in timeline with actor + notes.

## Database Schema (SQLite)

```sql
-- Cases (broker's internal case tracking)
cases (
  id INTEGER PRIMARY KEY,
  case_number TEXT UNIQUE NOT NULL,        -- broker's internal number (e.g., AMR-2026-0001)
  insurer_claim_number TEXT,               -- insurer's reference number (assigned after submission)
  status TEXT NOT NULL DEFAULT 'received', -- state machine above
  priority TEXT DEFAULT 'normal',          -- urgent/high/normal/low
  assigned_to INTEGER REFERENCES users(id),

  -- Claimant (the person making the claim)
  claimant_name TEXT NOT NULL,
  claimant_egn TEXT,                       -- masked in UI, full in DB
  claimant_phone TEXT,
  claimant_email TEXT,
  claimant_iban TEXT,                      -- for payment
  power_of_attorney INTEGER DEFAULT 0,    -- does broker have PoA?

  -- Policy info
  policy_number TEXT,
  policy_type TEXT,                        -- casco, mtpl, property, health, travel, liability, cargo
  insurer_name TEXT,                       -- e.g., ДЗИ, Алианц, Булстрад, Армеец, Лев Инс
  insurer_branch TEXT,
  insurer_contact TEXT,

  -- Incident
  incident_date TEXT,
  incident_location TEXT,
  incident_description TEXT,
  claim_type TEXT,                         -- auto_collision, auto_theft, auto_glass, property_fire, etc.
  sub_type TEXT,

  -- Vehicle (for auto claims)
  vehicle_reg_no TEXT,                     -- рег. номер
  vehicle_vin TEXT,
  vehicle_make_model TEXT,
  service_center TEXT,                     -- preferred repair shop

  -- Amounts
  estimated_amount REAL,
  insurer_approved_amount REAL,
  paid_amount REAL,
  currency TEXT DEFAULT 'BGN',

  -- AI
  extraction_confidence REAL,              -- 0.0-1.0, how confident AI is in extracted data
  ai_notes TEXT,                           -- AI observations (missing info, inconsistencies)

  -- Dates
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  submitted_to_insurer_at TEXT,
  insurer_decision_at TEXT,
  paid_at TEXT,
  closed_at TEXT,
  created_by INTEGER REFERENCES users(id)
);

-- Documents with requirement tracking
documents (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mimetype TEXT,
  size_bytes INTEGER,
  doc_type TEXT NOT NULL,                  -- kat_protocol, bilateral_statement, damage_photo,
                                           -- repair_invoice, medical_report, police_report,
                                           -- policy_copy, id_copy, power_of_attorney,
                                           -- expert_assessment, other
  ocr_raw TEXT,                            -- raw AI extraction JSON
  ocr_confidence REAL,                     -- per-document confidence 0.0-1.0
  uploaded_at TEXT DEFAULT (datetime('now')),
  uploaded_by INTEGER REFERENCES users(id)
);

-- What documents are required per claim type
document_requirements (
  id INTEGER PRIMARY KEY,
  claim_type TEXT NOT NULL,                -- auto_collision, auto_theft, property_fire, etc.
  doc_type TEXT NOT NULL,                  -- kat_protocol, bilateral_statement, etc.
  required INTEGER DEFAULT 1,             -- 1=mandatory, 0=optional but recommended
  description TEXT                         -- Bulgarian description shown to user
);

-- Case timeline (every action logged)
case_timeline (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  action TEXT NOT NULL,                    -- status_change, document_added, note_added, assigned,
                                           -- submitted_to_insurer, insurer_response, ai_analysis
  old_status TEXT,
  new_status TEXT,
  actor TEXT NOT NULL,                     -- username or 'system'
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Communications with insurer
communications (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  direction TEXT NOT NULL,                 -- outbound (to insurer) / inbound (from insurer)
  channel TEXT,                            -- email, phone, portal, in_person
  subject TEXT,
  body TEXT,
  insurer_response_type TEXT,              -- info_request, decision, payment_notice, other
  created_at TEXT DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id)
);

-- Insurer decisions
decisions (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  decision_type TEXT NOT NULL,             -- approved, partially_approved, rejected
  approved_amount REAL,
  rejection_reason TEXT,
  decision_date TEXT,
  decision_document TEXT,                  -- filename of decision letter
  created_at TEXT DEFAULT (datetime('now'))
);

-- Payments
payments (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  amount REAL NOT NULL,
  payment_date TEXT,
  payment_method TEXT,                     -- bank_transfer, check
  reference TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Processing jobs (async AI work)
processing_jobs (
  id INTEGER PRIMARY KEY,
  case_id INTEGER,
  document_id INTEGER,
  job_type TEXT NOT NULL,                  -- ocr_extraction, classification, completeness_check
  status TEXT DEFAULT 'queued',            -- queued, processing, completed, failed
  result TEXT,                             -- JSON result
  error TEXT,
  attempts INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

-- Platform
users (id, username, password_hash, role, full_name, created_at);
settings (key TEXT PRIMARY KEY, value TEXT);
audit_log (id, user_id, action, entity_type, entity_id, details, ip_address, created_at);
```

## Document Requirements (seed data)

### Auto Collision (Каско/ГО — ПТП)
| Doc Type | Required | Description |
|----------|----------|-------------|
| bilateral_statement | Yes | Двустранен констативен протокол |
| kat_protocol | Conditional | КАТ протокол (ако има пострадали/спор) |
| damage_photo | Yes | Снимки на щетите (мин. 4 ъгъла + детайл) |
| police_report | Conditional | Полицейски протокол |
| id_copy | Yes | Копие на лична карта |
| policy_copy | Yes | Копие на полицата |
| repair_invoice | Optional | Фактура от сервиз (ако вече е ремонтирано) |
| expert_assessment | Optional | Оценка от вещо лице |

### Auto Theft (Каско — кражба)
| Doc Type | Required | Description |
|----------|----------|-------------|
| police_report | Yes | Протокол от МВР за кражба |
| policy_copy | Yes | Копие на полицата |
| id_copy | Yes | Копие на лична карта |
| vehicle_keys | Yes | Всички ключове на автомобила |
| vehicle_registration | Yes | Талон на МПС |

### Property Damage (Имущество)
| Doc Type | Required | Description |
|----------|----------|-------------|
| damage_photo | Yes | Снимки на щетите |
| policy_copy | Yes | Копие на полицата |
| expert_assessment | Yes | Оценка от вещо лице |
| ownership_proof | Yes | Документ за собственост |
| incident_report | Yes | Описание на събитието |

## AI Design — Extraction + Completeness (NOT fraud)

### 1. Document OCR + Extraction
```
You are an AI assistant for an insurance broker in Bulgaria.
Extract structured data from this claim document. Return JSON:
{
  "document_type": "bilateral_statement|kat_protocol|damage_photo|repair_invoice|medical_report|police_report|policy_copy|id_copy|other",
  "extraction_confidence": 0.0-1.0,
  "extracted_fields": {
    "incident_date": "DD.MM.YYYY or null",
    "incident_location": "string or null",
    "parties": [{"name": "...", "role": "driver|passenger|pedestrian|owner|witness", "egn": "...", "vehicle_reg": "..."}],
    "policy_number": "string or null",
    "damage_description": "string in Bulgarian",
    "amounts": [{"description": "...", "amount": 0.00, "currency": "BGN"}],
    "kat_protocol_number": "string or null",
    "other_details": "string or null"
  },
  "quality_issues": ["blurry_image", "partially_obscured", "handwritten_hard_to_read", "missing_signature"],
  "low_confidence_fields": ["field_name_1", "field_name_2"]
}
Focus on accuracy. Flag uncertain fields in low_confidence_fields. Do NOT guess — if unsure, return null and flag it.
```

### 2. Claim Classification
```
Based on the extracted data from all documents in this case, classify:
{
  "claim_type": "auto_collision|auto_theft|auto_glass|auto_third_party|property_fire|property_flood|property_theft|health_accident|health_illness|travel|liability|cargo",
  "policy_type": "casco|mtpl|property|health|travel|liability|cargo",
  "priority": "urgent|high|normal|low",
  "reasoning": "brief explanation in Bulgarian"
}
```

### 3. Completeness Check (the killer feature)
```
Given this case with claim_type={type} and these uploaded documents: {doc_list},
check against the required document checklist.
Return:
{
  "complete": true/false,
  "missing_required": [{"doc_type": "...", "description": "...", "suggestion": "how/where to obtain"}],
  "missing_optional": [{"doc_type": "...", "description": "...", "benefit": "why it helps"}],
  "inconsistencies": [{"field": "...", "doc1": "...", "doc2": "...", "issue": "..."}],
  "next_recommended_action": "string in Bulgarian",
  "ready_to_submit": true/false
}
```

### 4. Insurer Submission Summary
```
Generate a structured summary for insurer submission:
{
  "case_summary": "professional paragraph in Bulgarian describing the claim",
  "key_facts": ["fact1", "fact2"],
  "documents_included": ["doc1", "doc2"],
  "total_claimed_amount": 0.00,
  "supporting_evidence": "brief note on strength of documentation"
}
```

## API Endpoints

### Cases CRUD
- POST /api/cases — create new case (manual)
- POST /api/cases/intake — upload documents → AI OCR → auto-create case (async)
- GET /api/cases — list cases (filterable: status, type, assignee, date, insurer)
- GET /api/cases/:id — full case with documents + timeline + communications
- PUT /api/cases/:id — update case fields
- DELETE /api/cases/:id — soft delete (archived)

### Case Pipeline
- POST /api/cases/:id/transition — move to next status (validates allowed transitions)
- GET /api/cases/:id/timeline — full history
- POST /api/cases/:id/assign — assign to broker user

### Documents
- POST /api/cases/:id/documents — upload documents (triggers async OCR)
- GET /api/cases/:id/documents — list with requirement status (uploaded/missing/optional)
- GET /api/cases/:id/completeness — AI completeness check
- GET /api/cases/:id/submission-package — generate insurer submission PDF/ZIP

### Processing Jobs
- GET /api/jobs/:id — check job status (for async OCR polling)
- GET /api/cases/:id/jobs — all jobs for a case

### Communications
- POST /api/cases/:id/communications — log communication with insurer
- GET /api/cases/:id/communications — communication history

### Decisions & Payments
- POST /api/cases/:id/decisions — record insurer decision
- POST /api/cases/:id/payments — record payment

### Dashboard
- GET /api/dashboard — KPIs (open cases, awaiting docs, submitted, overdue, avg processing days)
- GET /api/dashboard/workqueue — prioritized list of cases needing action

### Auth (reuse from Argus)
- POST /api/auth/login
- POST /api/auth/register
- GET /api/auth/me

## Frontend Pages

### 1. Work Queue / Inbox (main page)
- **This is the hero screen** — not a dashboard with charts
- Prioritized list of cases needing broker action
- Grouped by: "Needs my attention", "Awaiting client docs", "Awaiting insurer", "Recently closed"
- Each row: case #, claimant, type badge, status badge, days open, assigned to, missing docs count
- Quick filters: my cases, all, by insurer, by type, overdue
- Click → case detail

### 2. Case Detail
- **Header**: case #, status badge with transition buttons, priority, assigned to
- **Left panel**: claimant info (EGN masked as ****1234), policy info, vehicle info, insurer info
- **Center**:
  - Document checklist (required ✅/❌, optional ⚪, upload button per type)
  - Uploaded documents with thumbnails + OCR confidence badge
  - AI extraction results (editable fields, low-confidence highlighted yellow)
- **Right panel**: timeline (status changes, docs added, communications, AI analyses)
- **Bottom actions**: Transition, Add Communication, Generate Submission Package, Add Note

### 3. New Case / Intake
- Drag & drop zone for documents (multi-file)
- Progress indicator for async AI processing
- After processing: auto-populated form with confidence indicators
- Missing document alerts immediately visible
- "Save as Draft" / "Create Case" buttons

### 4. Dashboard (secondary)
- KPI cards: Open Cases, Awaiting Client Docs, Submitted to Insurer, Overdue (>30 days), Avg Processing Days
- Cases by insurer (bar chart — who we submit to most)
- Cases by type (donut)
- Monthly throughput trend

### 5. Settings
- User management + roles
- Branding (logo, colors, company name)
- Document requirement templates (per claim type)
- Insurer directory (names, contacts, branches)
- AI provider selection

## Color Scheme / Branding
- Primary: #1E40AF (professional blue)
- Accent: #059669 (green for complete/approved), #DC2626 (red for rejected/overdue), #F59E0B (amber for awaiting/attention)
- Background: #F8FAFC
- Sidebar: #0F172A (dark)
- EGN/sensitive: masked by default, click to reveal (logged in audit)

## Privacy & Compliance
- EGN masked in UI (****1234), full value only on click + audit log entry
- Sensitive field access logged in audit_log with IP
- File uploads stored locally (not cloud) for demo
- Role-based: only assigned broker + admin can see case details
- Data retention note in settings (configurable)

## Async Processing Architecture
```
Upload → save file → insert processing_job (status: queued)
         → return job_id to frontend immediately

Background worker (setInterval 2s):
  → pick oldest queued job
  → set status: processing
  → call AI provider (with timeout 30s + retry 2x)
  → on success: set status: completed, store result
  → on failure: increment attempts, if attempts >= 3 → status: failed

Frontend polls GET /api/jobs/:id every 2s until completed/failed
  → on completed: refresh case data, show extraction results
  → on failed: show error with "Retry" button
```
For demo: also support `FIXTURE_MODE=force` that returns pre-built fixtures instantly (no AI call, no delay risk).

## File Structure
```
D:\AutomatON\claims-demo\
├── server.js              (routes + business logic)
├── db.js                  (SQLite schema + queries + seed data)
├── auth.js                (JWT + bcrypt, from Argus)
├── rbac.js                (role-based access)
├── claims-engine.js       (AI orchestration: extraction, classification, completeness)
├── job-worker.js          (async processing worker)
├── ai/                    (from Argus)
│   ├── index.js
│   ├── anthropic.js
│   ├── google.js
│   └── openai.js
├── public/
│   ├── index.html         (SPA frontend)
│   └── login.html
├── data/
│   ├── claim-types.json   (taxonomy + document requirements)
│   └── insurers.json      (BG insurer directory: ДЗИ, Алианц, Булстрад, Армеец, Лев Инс, etc.)
├── fixtures/              (pre-built AI responses for demo mode)
│   ├── auto-collision.json
│   └── incomplete-claim.json
├── uploads/
├── test.js
├── package.json
├── .env
├── CONTEXT.md
└── PLAN.md
```

## Demo Script (for Amarant meeting)
1. Open **Work Queue** — show clean inbox, explain the broker workflow
2. **Case 1: Clean Каско ПТП** — Upload bilateral statement + 4 damage photos + policy copy
   - Watch AI extract: date, parties, vehicles, reg numbers, policy # (with confidence badges)
   - Show document checklist: all green ✅, "Ready to submit"
   - Generate insurer submission package (organized summary)
   - Transition: received → validated → submitted to insurer
3. **Case 2: Incomplete claim** — Upload only 1 damage photo + verbal description
   - AI flags: missing bilateral statement ❌, missing policy copy ❌, missing ID ❌
   - Show "Next action: Contact client for missing documents"
   - Transition: received → awaiting client docs
   - Add communication: "Called client, docs coming tomorrow"
   - Later: upload missing docs → checklist goes green → ready to submit
4. Show **Dashboard** — KPIs, cases by insurer distribution
5. Show **branding** — swap to Amarant logo + colors in 10 seconds
6. "This took us 2 weeks to build. For you it would take 6 months with a team of 5."

## Success Criteria
- Upload documents → AI extraction starts immediately, results within 15-30 seconds (async with progress indicator)
- Missing document detection is the "wow" moment — client sees immediate value
- Fixture mode ensures demo NEVER fails (pre-built responses as fallback)
- Professional, polished UI focused on broker daily work (inbox, not charts)
- Bulgarian language throughout
- Works on localhost, demoable via screen share

## Implementation Priority
P0 (must have for demo):
- Cases CRUD + document upload + async OCR extraction
- Document requirements + completeness checking (THE killer feature)
- Broker pipeline state machine with transitions
- Work queue / inbox (main page)
- Case detail with document checklist + timeline
- Fixture mode for reliable demo
- Seed data (2-3 pre-loaded cases in different states)

P1 (nice to have):
- Insurer submission package generation
- Communications log
- Dashboard with KPIs
- Excel export
- Branding customization

P2 (post-demo):
- Email ingestion
- Multi-tenant
- Insurer portal integration
- Payment tracking
- Reporting
