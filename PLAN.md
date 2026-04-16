# AutomatON Claims — Insurance Broker Case Management Demo
## Target: Amarant Bulgaria (Застрахователен брокер)
## Scope: Auto (Каско + ГО/MTPL) and Property claims only — the 90% case for brokers

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
3. **Missing document detection** — AI checks uploaded vs required for this claim type + insurer, flags gaps with min counts
4. **Auto-classification** — claim type (Каско ПТП, Каско кражба, ГО/MTPL, имущество)
5. **Broker case pipeline** — explicit state machine with transition matrix
6. **Insurer submission package** — one-click generate organized package for the insurer
7. **Professional UI** — inbox/work queue driven by next_action + next_action_due_date. Bulgarian language throughout.

## Broker Workflow (State Machine + Transition Matrix)

### States
```
received                    — client reported incident, case opened
awaiting_client_docs        — some required documents missing, waiting on client
validated_by_broker         — all docs present, data extracted, ready to submit
submitted_to_insurer        — package sent to insurance company
insurer_requested_info      — insurer asked for additional evidence/clarification
awaiting_insurer_decision   — complete package with insurer, waiting for ruling
approved_by_insurer         — insurer approved the claim
partially_approved          — insurer approved partial amount
rejected_by_insurer         — insurer rejected (with reason)
paid                        — payment received by client
closed                      — case archived
```

### Transition Matrix (from → allowed targets)
```
received               → [awaiting_client_docs, validated_by_broker, closed]
awaiting_client_docs   → [validated_by_broker, closed]
validated_by_broker    → [submitted_to_insurer, awaiting_client_docs]  // can go back if docs found incomplete
submitted_to_insurer   → [insurer_requested_info, awaiting_insurer_decision]
insurer_requested_info → [submitted_to_insurer, awaiting_insurer_decision, closed]  // resubmission loop
awaiting_insurer_decision → [approved_by_insurer, partially_approved, rejected_by_insurer]
approved_by_insurer    → [paid, closed]
partially_approved     → [paid, closed]  // client may accept partial
rejected_by_insurer    → [submitted_to_insurer, closed]  // appeal = resubmit, or close
paid                   → [closed]
closed                 → []  // terminal
```
Every transition: role-restricted (broker/admin), logged in timeline with actor + notes + timestamp.

## Database Schema (SQLite)

```sql
-- Cases (broker's internal case tracking)
cases (
  id INTEGER PRIMARY KEY,
  case_number TEXT UNIQUE NOT NULL,        -- broker's internal (e.g., AMR-2026-0001)
  insurer_claim_number TEXT,               -- insurer's reference (assigned after submission)
  status TEXT NOT NULL DEFAULT 'received',
  priority TEXT DEFAULT 'normal',          -- urgent/high/normal/low
  assigned_to INTEGER REFERENCES users(id),

  -- Operational fields (drive the work queue)
  next_action TEXT,                        -- e.g., "Обадете се на клиента за липсващи документи"
  next_action_next_action_due_date TEXT,               -- when this action is due
  last_contact_date TEXT,                  -- last communication with client or insurer
  overdue_reason TEXT,                     -- why this case is delayed (if overdue)

  -- Policy info
  policy_number TEXT,
  policy_type TEXT,                        -- casco, mtpl, property
  insurer_name TEXT,                       -- ДЗИ, Алианц, Булстрад, Армеец, Лев Инс, Евроинс, Уника
  insurer_branch TEXT,
  insurer_contact TEXT,

  -- Incident
  incident_date TEXT,
  incident_location TEXT,
  incident_description TEXT,
  claim_type TEXT,                         -- auto_collision, auto_theft, auto_glass, property_fire, property_flood, property_theft
  sub_type TEXT,

  -- Amounts
  estimated_amount REAL,
  insurer_approved_amount REAL,
  paid_amount REAL,
  currency TEXT DEFAULT 'BGN',

  -- AI
  extraction_confidence REAL,              -- 0.0-1.0 aggregate
  ai_notes TEXT,                           -- AI observations

  -- Dates
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  submitted_to_insurer_at TEXT,
  insurer_decision_at TEXT,
  paid_at TEXT,
  closed_at TEXT,
  cancelled_at TEXT,                       -- if cancelled (distinct from closed)
  cancellation_reason TEXT,                -- why cancelled
  is_deleted INTEGER DEFAULT 0,           -- soft delete flag
  created_by INTEGER REFERENCES users(id)
);

-- Parties (claimant, insured, driver, counterparty, owner, witness)
parties (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  role TEXT NOT NULL,                      -- claimant, insured, driver, counterparty_driver,
                                           -- counterparty_owner, vehicle_owner, witness, beneficiary
  name TEXT NOT NULL,
  egn TEXT,                                -- masked in UI as ****1234
  phone TEXT,
  email TEXT,
  iban TEXT,                               -- for payment (claimant/beneficiary)
  address TEXT,
  power_of_attorney INTEGER DEFAULT 0,    -- does broker have PoA for this party?
  is_at_fault INTEGER,                    -- 1=at fault, 0=not, NULL=unknown
  notes TEXT
);

-- Vehicles (supports multiple — claimant's + counterparty's)
vehicles (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  owner_party_id INTEGER REFERENCES parties(id),  -- who OWNS this vehicle
  driver_party_id INTEGER REFERENCES parties(id), -- who DROVE at time of incident (may differ from owner)
  role TEXT NOT NULL,                      -- claimant_vehicle, counterparty_vehicle
  reg_no TEXT,                             -- рег. номер (e.g., СА 1234 ВК)
  vin TEXT,
  make TEXT,                               -- марка
  model TEXT,                              -- модел
  year INTEGER,
  color TEXT,
  damage_description TEXT,
  service_center TEXT,                     -- preferred repair shop
  insurer_name TEXT,                       -- which insurer covers THIS vehicle (for ГО counterparty)
  policy_number TEXT                       -- counterparty's policy (for ГО)
);

-- Documents
documents (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mimetype TEXT,
  size_bytes INTEGER,
  doc_type TEXT NOT NULL,                  -- UNIFIED TAXONOMY (see below)
  ocr_raw TEXT,                            -- raw AI extraction JSON
  ocr_confidence REAL,                     -- per-document 0.0-1.0
  uploaded_at TEXT DEFAULT (datetime('now')),
  uploaded_by INTEGER REFERENCES users(id)
);

-- UNIFIED Document Taxonomy (used in documents.doc_type, document_requirements.doc_type, AI prompts)
-- bilateral_statement      Двустранен констативен протокол
-- kat_protocol             КАТ протокол (при пострадали/спор)
-- police_report            Полицейски протокол / МВР доклад
-- damage_photo             Снимка на щета
-- repair_invoice           Фактура от сервиз
-- expert_assessment        Оценка от вещо лице
-- policy_copy              Копие на полицата
-- id_copy                  Копие на лична карта
-- vehicle_registration     Талон на МПС
-- vehicle_keys_declaration Декларация за предадени ключове
-- ownership_proof          Документ за собственост (имущество)
-- incident_report          Писмено описание на събитието
-- power_of_attorney        Пълномощно
-- other                    Друг документ

-- Document Requirements (what's needed per claim_type, with rules)
document_requirements (
  id INTEGER PRIMARY KEY,
  claim_type TEXT NOT NULL,                -- auto_collision, auto_theft, auto_glass, property_fire, etc.
  doc_type TEXT NOT NULL,                  -- from unified taxonomy above
  requirement TEXT NOT NULL DEFAULT 'required',  -- required, conditional, optional
  min_count INTEGER DEFAULT 1,            -- e.g., damage_photo needs min 4
  condition_description TEXT,              -- when this doc is conditional (e.g., "ако има пострадали")
  insurer_specific TEXT,                   -- NULL = all insurers, or specific insurer name
  description_bg TEXT NOT NULL             -- Bulgarian label shown in UI checklist
);

-- Case timeline
case_timeline (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  action TEXT NOT NULL,
  old_status TEXT,
  new_status TEXT,
  actor TEXT NOT NULL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Communications with insurer/client
communications (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  direction TEXT NOT NULL,                 -- outbound_insurer, inbound_insurer, outbound_client, inbound_client
  channel TEXT,                            -- email, phone, portal, in_person
  subject TEXT,
  body TEXT,
  response_type TEXT,                      -- info_request, decision, payment_notice, acknowledgment, other
  follow_up_date TEXT,                     -- when to follow up if no response
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
  decision_document TEXT,
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
  recipient_party_id INTEGER REFERENCES parties(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Processing jobs (async AI pipeline)
processing_jobs (
  id INTEGER PRIMARY KEY,
  case_id INTEGER,
  document_id INTEGER,
  job_type TEXT NOT NULL,                  -- ocr_extraction, classification, completeness_check
  status TEXT DEFAULT 'queued',            -- queued, locked, processing, completed, failed
  locked_at TEXT,                          -- when worker picked it up (prevents double-processing)
  depends_on_type TEXT,                    -- NULL, 'all_ocr_for_case', 'job_id'
  depends_on_job_id INTEGER REFERENCES processing_jobs(id),  -- if depends_on_type='job_id'
  -- depends_on_type='all_ocr_for_case': worker checks ALL ocr_extraction jobs for this case_id are completed before starting
  result TEXT,                             -- JSON result
  error TEXT,
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

-- Platform
users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, role TEXT, full_name TEXT, created_at TEXT);
settings (key TEXT PRIMARY KEY, value TEXT);
audit_log (id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT, entity_type TEXT, entity_id INTEGER, details TEXT, ip_address TEXT, created_at TEXT DEFAULT (datetime('now')));
```

## Document Requirements (seed data)

### Auto Collision (Каско/ГО — ПТП)
| doc_type | requirement | min_count | condition | description_bg |
|----------|------------|-----------|-----------|----------------|
| bilateral_statement | required | 1 | — | Двустранен констативен протокол |
| kat_protocol | conditional | 1 | Ако има пострадали или спор за вина | КАТ протокол |
| damage_photo | required | 4 | — | Снимки на щетите (мин. 4: преден, заден, 2 странични + детайл) |
| police_report | conditional | 1 | Ако има пострадали | Полицейски протокол |
| id_copy | required | 1 | — | Копие на лична карта на застрахования |
| policy_copy | required | 1 | — | Копие на полицата |
| vehicle_registration | required | 1 | — | Талон на МПС |
| repair_invoice | optional | 1 | — | Фактура от сервиз (ако вече е ремонтирано) |
| expert_assessment | optional | 1 | — | Оценка от вещо лице |

### Auto Theft (Каско — кражба)
| doc_type | requirement | min_count | condition | description_bg |
|----------|------------|-----------|-----------|----------------|
| police_report | required | 1 | — | Протокол от МВР за кражба |
| policy_copy | required | 1 | — | Копие на полицата |
| id_copy | required | 1 | — | Копие на лична карта |
| vehicle_keys_declaration | required | 1 | — | Декларация за предадени ключове |
| vehicle_registration | required | 1 | — | Талон на МПС |

### Auto Glass (Каско — счупено стъкло)
| doc_type | requirement | min_count | condition | description_bg |
|----------|------------|-----------|-----------|----------------|
| damage_photo | required | 2 | — | Снимки на счупеното стъкло |
| policy_copy | required | 1 | — | Копие на полицата |
| id_copy | required | 1 | — | Копие на лична карта |
| vehicle_registration | required | 1 | — | Талон на МПС |
| repair_invoice | optional | 1 | — | Фактура от сервиз (ако вече е сменено) |

### Property Fire (Имущество — пожар)
| doc_type | requirement | min_count | condition | description_bg |
|----------|------------|-----------|-----------|----------------|
| damage_photo | required | 4 | — | Снимки на щетите |
| policy_copy | required | 1 | — | Копие на полицата |
| expert_assessment | required | 1 | — | Оценка от вещо лице |
| ownership_proof | required | 1 | — | Документ за собственост |
| incident_report | required | 1 | — | Писмено описание на събитието |
| police_report | conditional | 1 | Ако има съмнение за умишлен палеж | Полицейски протокол |

### Property Flood (Имущество — наводнение)
| doc_type | requirement | min_count | condition | description_bg |
|----------|------------|-----------|-----------|----------------|
| damage_photo | required | 4 | — | Снимки на щетите |
| policy_copy | required | 1 | — | Копие на полицата |
| expert_assessment | required | 1 | — | Оценка от вещо лице |
| ownership_proof | required | 1 | — | Документ за собственост |
| incident_report | required | 1 | — | Писмено описание на събитието |

### Property Theft (Имущество — кражба)
| doc_type | requirement | min_count | condition | description_bg |
|----------|------------|-----------|-----------|----------------|
| damage_photo | required | 4 | — | Снимки на щетите |
| policy_copy | required | 1 | — | Копие на полицата |
| expert_assessment | required | 1 | — | Оценка от вещо лице |
| ownership_proof | required | 1 | — | Документ за собственост |
| incident_report | required | 1 | — | Писмено описание на събитието |
| police_report | required | 1 | — | Полицейски протокол за кражба |

### Insurer-specific overrides (examples)
| insurer | claim_type | doc_type | override | notes |
|---------|-----------|----------|----------|-------|
| ДЗИ | auto_collision | damage_photo | min_count=6 | ДЗИ изисква 6 снимки (4 ъгъла + 2 детайла) |
| Алианц | auto_collision | expert_assessment | requirement=required | Алианц винаги иска вещо лице |
| Булстрад | auto_theft | police_report | min_count=2 | Булстрад иска и протокол от районно |

## AI Design — Extraction + Completeness (NOT fraud)

### 1. Document OCR + Extraction
```
You are an AI assistant for an insurance broker in Bulgaria.
Extract structured data from this claim document. Return JSON:
{
  "document_type": "bilateral_statement|kat_protocol|damage_photo|repair_invoice|
                    police_report|policy_copy|id_copy|vehicle_registration|
                    vehicle_keys_declaration|ownership_proof|incident_report|
                    expert_assessment|power_of_attorney|other",
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
Focus on accuracy. Flag uncertain fields. Do NOT guess — return null and flag it.
```

### 2. Claim Classification
```
Based on extracted data from all documents, classify:
{
  "claim_type": "auto_collision|auto_theft|auto_glass|property_fire|property_flood|property_theft",
  "policy_type": "casco|mtpl|property",
  "priority": "urgent|high|normal|low",
  "reasoning": "brief explanation in Bulgarian"
}
```

### 3. Completeness Check (the killer feature)
```
Given case with claim_type={type}, insurer={insurer}, and uploaded documents: {doc_list_with_counts},
check against required document checklist: {requirements_for_this_type}.
Return:
{
  "complete": true/false,
  "missing_required": [{"doc_type": "...", "description_bg": "...", "min_needed": N, "have": N, "suggestion": "how to obtain"}],
  "missing_conditional": [{"doc_type": "...", "description_bg": "...", "condition": "...", "likely_needed": true/false, "reasoning": "..."}],
  "missing_optional": [{"doc_type": "...", "description_bg": "...", "benefit": "why it helps the claim"}],
  "inconsistencies": [{"field": "...", "doc1_value": "...", "doc2_value": "...", "issue_bg": "..."}],
  "next_recommended_action": "string in Bulgarian",
  "ready_to_submit": true/false
}
```

### 4. Insurer Submission Summary
```
Generate structured summary for insurer submission package:
{
  "case_summary_bg": "professional paragraph in Bulgarian",
  "key_facts": ["fact1", "fact2"],
  "documents_included": [{"doc_type": "...", "description": "...", "count": N}],
  "parties_summary": [{"name": "...", "role": "...", "vehicle": "..."}],
  "total_claimed_amount": 0.00,
  "supporting_evidence_strength": "strong|adequate|weak"
}
```

## Async Processing Pipeline

```
Document Upload:
  1. Save file to disk
  2. Insert processing_job: type=ocr_extraction, status=queued, document_id=X, case_id=Y
  3. Return job_id immediately to frontend

Classification + Completeness (triggered automatically):
  4. Insert processing_job: type=classification, status=queued, case_id=Y,
     depends_on_type='all_ocr_for_case'  (worker won't start until ALL ocr jobs for this case_id are completed)
  5. Insert processing_job: type=completeness_check, status=queued, case_id=Y,
     depends_on_type='job_id', depends_on_job_id=classification_job_id

Pipeline: OCR (per doc, parallel) → Classification (per case, waits for ALL OCR) → Completeness (per case)
```

### Worker dependency resolution
```
For each queued job:
  if depends_on_type IS NULL → ready to run
  if depends_on_type = 'job_id' → check depends_on_job_id status = 'completed'
  if depends_on_type = 'all_ocr_for_case' → SELECT COUNT(*) FROM processing_jobs
     WHERE case_id=X AND job_type='ocr_extraction' AND status != 'completed'
     → if count = 0, all OCR done, ready to run
     → if count > 0, skip (will retry next cycle)
```

### Job Worker (job-worker.js)
```
setInterval(2000):
  1. BEGIN TRANSACTION
  2. SELECT oldest job WHERE status='queued' AND (depends_on IS NULL OR depends_on job is completed)
     AND locked_at IS NULL
  3. UPDATE status='locked', locked_at=now()  -- prevents double-processing
  4. COMMIT
  5. Run the job (AI call with 30s timeout)
  6. On success: status='completed', result=JSON, completed_at=now()
  7. On failure: attempts++, if attempts >= max_attempts → status='failed', else status='queued', locked_at=NULL
  8. Stale lock recovery: any job locked > 60s with status='locked' → reset to queued
```

### Fixture Mode (FIXTURE_MODE=force)
Skip AI calls entirely. Return pre-built JSON from `fixtures/` directory matched by doc_type.
Ensures demo NEVER fails regardless of API availability or latency.

## API Endpoints

### Cases CRUD
- POST /api/cases — create new case (manual entry)
- POST /api/cases/intake — upload docs → async OCR → auto-create case (returns case_id + job_ids)
- GET /api/cases — list (filters: status, claim_type, assignee, insurer, overdue, date range)
- GET /api/cases/:id — full case with parties, vehicles, documents, timeline, communications
- PUT /api/cases/:id — update case fields (including next_action, next_action_due_date)
- DELETE /api/cases/:id — soft delete (is_deleted=1, cancelled_at=now, cancellation_reason required). Distinct from closing.

### Case Pipeline
- POST /api/cases/:id/transition — validate against transition matrix, log in timeline
- GET /api/cases/:id/timeline — full history
- POST /api/cases/:id/assign — assign to broker user, set next_action

### Documents
- POST /api/cases/:id/documents — upload (triggers async OCR pipeline)
- GET /api/cases/:id/documents — list with requirement status (uploaded count vs min_count)
- GET /api/cases/:id/completeness — completeness check result (from latest completed job, or trigger new)
- GET /api/cases/:id/submission-package — generate insurer submission summary

### Processing Jobs
- GET /api/jobs/:id — check single job status (for polling)
- GET /api/cases/:id/jobs — all jobs for case with statuses

### Communications
- POST /api/cases/:id/communications — log communication (auto-updates last_contact_date)
- GET /api/cases/:id/communications — history

### Decisions & Payments
- POST /api/cases/:id/decisions — record insurer decision (auto-transitions status)
- POST /api/cases/:id/payments — record payment (auto-transitions to paid if full amount)

### Dashboard & Work Queue
- GET /api/dashboard — KPIs (open, awaiting docs, submitted, overdue, avg days)
- GET /api/dashboard/workqueue — cases sorted by: overdue first, then by next_action_due_date ASC, then created_at ASC

### Auth (reuse from Argus)
- POST /api/auth/login
- POST /api/auth/register
- GET /api/auth/me

## Frontend Pages

### 1. Work Queue / Inbox (MAIN PAGE)
- **This is the hero screen**
- Cases sorted by urgency: overdue (red) → due today (amber) → upcoming → no due date
- Each row: case #, claimant name, type badge, status badge, next_action, next_action_due_date, days open, missing docs count, assigned to
- Group tabs: "Нуждае се от действие", "Чака клиент", "Чака застраховател", "Приключени"
- Quick filters: my cases, all, by insurer, by type, overdue only
- Click → case detail

### 2. Case Detail
- **Header**: case # + insurer_claim_#, status badge + allowed transition buttons, priority, assigned to
- **Left panel**:
  - Parties list (claimant, insured, counterparty — EGN masked ****1234, click to reveal + audit)
  - Vehicles (claimant's + counterparty's with reg_no, make/model, damage)
  - Policy info + insurer info
- **Center**:
  - Document checklist grid: each required doc_type as a row, status icon (✅ uploaded / ❌ missing / ⚠️ conditional / ⚪ optional), count (have/need), upload button
  - Uploaded documents with thumbnails + OCR confidence badge (green/yellow/red)
  - AI extraction results (editable, low-confidence fields highlighted yellow)
  - "Ready to submit" / "X documents missing" prominent banner
- **Right panel**: timeline (all events: status changes, docs, comms, AI, notes)
- **Bottom actions**: Transition, Add Communication, Generate Submission Package, Add Note
- **Next Action bar**: prominent display of next_action + next_action_due_date, edit inline

### 3. New Case / Intake
- Drag & drop zone (multi-file)
- Progress bar per document (queued → processing → done)
- Overall pipeline progress (OCR → Classification → Completeness)
- After processing: auto-populated form with confidence indicators
- Party + vehicle forms (pre-filled from AI where possible)
- Missing document alerts immediately visible
- "Save as Draft" / "Create Case"

### 4. Dashboard (secondary page)
- KPI cards: Open Cases, Awaiting Client Docs, Submitted to Insurer, Overdue (>30 days), Avg Processing Days
- Cases by insurer (bar chart)
- Cases by type (donut)
- Monthly throughput trend

### 5. Settings
- User management + roles
- Branding (logo, colors, company name) — for demo "wow"
- Document requirement templates (editable per claim type)
- Insurer directory
- AI provider selection

## Color Scheme
- Primary: #1E40AF (professional blue)
- Success: #059669 (green — complete/approved)
- Danger: #DC2626 (red — rejected/overdue/missing)
- Warning: #F59E0B (amber — awaiting/attention/conditional)
- Background: #F8FAFC
- Sidebar: #0F172A
- Confidence: green (>0.8), yellow (0.5-0.8), red (<0.5)

## Privacy & Compliance
- EGN masked in UI (****1234), full only on click + audit_log entry with IP
- Sensitive field access logged
- File uploads local (not cloud)
- Role-based: only assigned broker + admin see case details
- Data retention configurable in settings

## File Structure
```
D:\AutomatON\claims-demo\
├── server.js              (routes + business logic + transition matrix)
├── db.js                  (SQLite schema + queries + seed data)
├── auth.js                (JWT + bcrypt, from Argus)
├── rbac.js                (role-based access)
├── claims-engine.js       (AI orchestration: prompts, extraction, classification, completeness)
├── job-worker.js          (async pipeline worker with locking + dependency resolution)
├── ai/                    (from Argus — unchanged)
│   ├── index.js           (factory + extractJSON + timeout)
│   ├── anthropic.js
│   ├── google.js
│   └── openai.js
├── public/
│   ├── index.html         (SPA frontend — work queue, case detail, intake, dashboard, settings)
│   └── login.html
├── data/
│   ├── claim-types.json   (taxonomy + document requirements with min_count + conditions)
│   └── insurers.json      (BG insurer directory)
├── fixtures/              (pre-built AI responses for FIXTURE_MODE)
│   ├── auto-collision-complete.json
│   ├── auto-collision-incomplete.json
│   └── property-damage.json
├── uploads/
├── test.js
├── package.json
├── .env
├── CONTEXT.md
└── PLAN.md
```

## Seed Data (pre-loaded for demo)
1. **Case AMR-2026-0001** — Каско ПТП, status: `validated_by_broker`, all docs present, 2 parties + 2 vehicles, ready to submit. Demonstrates the complete happy path.
2. **Case AMR-2026-0002** — ГО/MTPL, status: `awaiting_client_docs`, 2 of 6 required docs uploaded, next_action: "Обадете се на клиента за двустранен протокол", next_action_due_date: tomorrow. Demonstrates missing doc detection.
3. **Case AMR-2026-0003** — Имущество наводнение, status: `awaiting_insurer_decision`, submitted 5 days ago, next_action: "Проверете статус при ДЗИ", next_action_due_date: today. Demonstrates follow-up tracking.

## Demo Script (for Amarant meeting)
1. Open **Work Queue** — show 3 pre-loaded cases in different states, explain the urgency sorting
2. **Case 2 (incomplete)** — Click into it, show document checklist with red ❌ for missing docs
   - Show next_action: "Обадете се на клиента"
   - Upload the missing bilateral statement + photos → watch async AI process
   - Checklist updates: ❌→✅, banner changes to "Ready to submit"
   - Transition to validated_by_broker
3. **Case 1 (ready)** — Show complete case with 2 parties, 2 vehicles, all docs green
   - Generate insurer submission package
   - Transition: validated → submitted to insurer
   - Set next_action: "Проверете за отговор от Алианц", next_action_due_date: +7 days
4. **Case 3 (awaiting insurer)** — Show follow-up tracking
   - Add communication: "Обадих се на ДЗИ, казаха до петък"
   - Update next_action_due_date
5. **Live intake** — Create new case from scratch: upload 1 photo
   - Watch AI extract data + classify as auto_collision
   - See missing doc checklist immediately
   - "This is what your brokers would see every day"
6. Show **branding** — swap to Amarant logo + colors in 10 seconds
7. Closing: "Изграждаме такива системи за 2-3 седмици. За вас — ПТП, имущество, каквото е нужно."

## Success Criteria
- Upload → async OCR starts immediately, results within 15-30 seconds with progress indicator
- Missing document detection with min_count is the "wow" moment
- Fixture mode ensures demo NEVER fails
- Work queue driven by next_action + next_action_due_date feels like real broker daily tool
- Parties + vehicles properly modeled for bilateral statement scenarios
- Bulgarian language throughout
- Works on localhost, demoable via screen share

## Implementation Priority
P0 (must have for demo — this IS the demo):
- Cases CRUD + parties + vehicles
- Document upload + async OCR pipeline (OCR→classification→completeness)
- Document requirements with min_count + conditions + completeness checking
- Broker pipeline state machine with transition matrix
- Work queue / inbox sorted by next_action_due_date + overdue
- Case detail with document checklist + parties + timeline
- Insurer submission package generation
- Fixture mode for reliable demo
- Seed data (3 cases in different states)

P1 (build if time allows):
- Communications log with follow_up_date
- Dashboard with KPIs + charts
- Branding customization
- Excel export

P2 (post-demo):
- Email ingestion
- Multi-tenant
- Payment tracking
- Insurer portal integration
- Reporting
