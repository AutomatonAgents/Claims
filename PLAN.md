# AutomatON Claims — Insurance Claims Processing Demo
## Target: Amarant Bulgaria (Застрахователен брокер)

## Context
Amarant is an insurance BROKER — they process claims on behalf of clients and submit to insurance companies. Their pain: manual processing of hundreds of claims/month, slow approvals, data entry errors.

## What the Demo Must Show (to close the deal)
1. **Upload claim documents** (PDF, photos of damage, police reports, medical docs)
2. **AI OCR extraction** — date, incident type, parties, policy number, amounts, damage description
3. **Auto-classification** — claim type (auto, property, health, liability, travel)
4. **Risk scoring** — AI rates 1-10 with explanation (fraud indicators, claim validity)
5. **Claims pipeline dashboard** — submitted → reviewing → approved → sent to insurer → resolved
6. **Anomaly/fraud detection** — duplicate claims, suspicious patterns, amount outliers
7. **Professional UI** — clean, modern, Bulgarian language

## Architecture (Fork from Argus)

### Reuse from Argus (~70%)
- Express.js + SQLite backend structure
- Multi-provider AI abstraction (ai/index.js + anthropic.js, google.js, openai.js)
- OCR pipeline (document upload → AI vision → JSON extraction)
- Classification module pattern (classify-module.js → claims-classify.js)
- Auth + JWT + RBAC
- Multer file upload
- Dashboard pattern with KPIs
- Anomaly detection pattern (statistical + rule-based)
- Activity log / timeline
- White-label branding system
- Helmet, CORS, rate limiting

### New / Modified
- **Data model**: claims table (not invoices), claim_documents, claim_timeline, risk_scores, policies
- **AI prompts**: insurance-specific extraction + classification + risk scoring
- **Claims pipeline**: state machine (submitted → under_review → approved → rejected → sent_to_insurer → resolved)
- **Risk scoring engine**: AI + rule-based hybrid (amount vs policy limit, claim frequency, time since policy start, document completeness)
- **Fraud indicators**: duplicate detection, velocity checks, amount anomalies per claim type
- **Frontend**: insurance-themed UI (blue/professional, not accounting green)
- **Reports**: claims summary, payout forecast, fraud alert report

## Database Schema (SQLite)

```sql
-- Core
claims (id, claim_number, policy_number, client_name, client_egn, client_phone, client_email,
        incident_date, report_date, claim_type, sub_type, description,
        estimated_amount, approved_amount, currency, status, priority,
        assigned_to, risk_score, risk_explanation, fraud_flags,
        insurer_name, insurer_ref, resolution_date, resolution_notes,
        created_at, updated_at, created_by)

claim_documents (id, claim_id, filename, original_name, mimetype, size_bytes,
                 doc_type, ocr_data, ai_extraction, uploaded_at)
                 -- doc_type: police_report, medical_report, damage_photo, invoice, policy_copy, other

claim_timeline (id, claim_id, action, old_status, new_status, actor, notes, created_at)

policies (id, policy_number, holder_name, holder_egn, insurer_name,
          policy_type, start_date, end_date, coverage_amount, premium,
          status, created_at)

fraud_alerts (id, claim_id, alert_type, severity, description, resolved, resolved_by, created_at)

-- Platform
users (id, username, password_hash, role, full_name, created_at)
settings (key, value)
audit_log (id, user_id, action, entity_type, entity_id, details, created_at)
```

## API Endpoints

### Claims CRUD
- POST /api/claims — create new claim (manual)
- POST /api/claims/process — upload document → AI OCR → auto-create claim
- GET /api/claims — list claims (filterable by status, type, date range)
- GET /api/claims/:id — get claim with documents + timeline
- PUT /api/claims/:id — update claim
- DELETE /api/claims/:id — soft delete

### Claims Pipeline
- POST /api/claims/:id/transition — move claim to next status
- GET /api/claims/:id/timeline — get full history
- POST /api/claims/:id/assign — assign to user

### Documents
- POST /api/claims/:id/documents — upload additional documents
- GET /api/claims/:id/documents — list documents
- POST /api/claims/:id/documents/:docId/ocr — re-run OCR on document

### AI Processing
- POST /api/claims/:id/analyze — full AI analysis (classify + risk score + fraud check)
- POST /api/claims/:id/risk-score — recalculate risk score
- GET /api/claims/:id/fraud-check — check for fraud indicators

### Dashboard
- GET /api/dashboard — KPIs (total claims, by status, avg processing time, fraud alerts, payout forecast)
- GET /api/dashboard/charts — chart data (claims by type, by month, risk distribution)

### Reports
- GET /api/reports/claims-summary — filtered summary export
- GET /api/reports/fraud-alerts — active fraud alerts
- GET /api/export/claims-excel — Excel export

### Auth (reuse from Argus)
- POST /api/auth/login
- POST /api/auth/register
- GET /api/auth/me

## AI Prompts Design

### 1. Document OCR + Extraction
```
You are an AI assistant for an insurance broker in Bulgaria.
Extract the following from this insurance claim document:
- incident_date (DD.MM.YYYY)
- incident_type (auto_accident, property_damage, health_injury, theft, natural_disaster, liability, travel)
- parties_involved (array of {name, role, egn_eik})
- policy_number (if visible)
- description (brief summary in Bulgarian)
- estimated_damage_amount (BGN)
- location (city, address)
- document_type (police_report, medical_report, damage_photo, repair_invoice, policy_copy, other)
- key_details (any other relevant extracted info)
Return as JSON.
```

### 2. Claim Classification
```
Classify this insurance claim into:
- claim_type: auto | property | health | liability | travel | cargo | professional
- sub_type: (e.g., for auto: collision, theft, glass, third_party; for health: accident, illness, hospitalization)
- priority: urgent | high | normal | low
- complexity: simple | moderate | complex
Based on: {extracted data}
```

### 3. Risk Scoring
```
Score this claim 1-10 for risk/fraud probability:
Factors to consider:
- Time between incident and report (>30 days = suspicious)
- Claimed amount vs policy coverage
- Claim frequency for this client (>3/year = flag)
- Document completeness
- Consistency between documents
- Known fraud patterns (staged accidents, inflated repairs)
Return: { score: N, explanation: "...", flags: [...] }
```

## Frontend Pages

### 1. Dashboard (/)
- KPI cards: Total Claims, Pending Review, Approved This Month, Fraud Alerts, Avg Processing Days
- Charts: Claims by Type (donut), Claims by Month (bar), Risk Distribution (histogram)
- Recent claims list
- Active fraud alerts

### 2. Claims List (/claims)
- Table with filters (status, type, date, assignee)
- Status badges (color-coded pipeline)
- Quick actions (assign, transition, view)
- Search by claim number, client name, policy

### 3. Claim Detail (/claims/:id)
- Header: claim number, status badge, priority, risk score gauge
- Left: client info, policy info, incident details
- Center: uploaded documents (thumbnails, OCR viewer)
- Right: timeline (all status changes, comments, AI analyses)
- Actions: transition, assign, add document, re-analyze, add note

### 4. New Claim (/claims/new)
- Drop zone for documents (drag & drop, multi-file)
- AI auto-fills form after upload
- Manual override for all fields
- "Analyze" button for AI classification + risk score

### 5. Reports (/reports)
- Claims summary with date range
- Fraud alerts dashboard
- Payout forecast
- Excel export

### 6. Settings (/settings)
- User management
- Branding (logo, colors, company name)
- AI provider selection
- Notification preferences

## Color Scheme / Branding
- Primary: #1E40AF (professional blue)
- Accent: #059669 (green for approved), #DC2626 (red for rejected/fraud)
- Background: #F8FAFC
- Sidebar: #0F172A (dark)
- Typography: Inter / system fonts

## File Structure
```
D:\AutomatON\claims-demo\
├── server.js              (main backend — routes + business logic)
├── db.js                  (SQLite schema + queries)
├── auth.js                (JWT + bcrypt, copied from Argus)
├── rbac.js                (role-based access)
├── claims-engine.js       (classification + risk scoring + fraud detection)
├── ai/                    (copied from Argus)
│   ├── index.js
│   ├── anthropic.js
│   ├── google.js
│   └── openai.js
├── public/
│   ├── index.html         (SPA frontend)
│   ├── login.html
│   └── sw.js
├── data/
│   └── claim-types.json   (insurance claim taxonomy)
├── uploads/               (uploaded documents)
├── test.js                (test suite)
├── package.json
├── .env
├── CONTEXT.md
└── PLAN.md
```

## Demo Script (for Amarant meeting)
1. Open dashboard — show empty state, explain KPIs
2. Upload a car accident claim (photo of damage + police report PDF)
3. Watch AI extract data in real-time, auto-fill the form
4. Show classification: auto → collision, priority: high
5. Show risk score: 3/10 (low risk) with explanation
6. Transition through pipeline: submitted → under review → approved
7. Upload a suspicious claim (high amount, late report, incomplete docs)
8. Show risk score: 8/10 with fraud flags
9. Show fraud alerts dashboard
10. Export claims report to Excel
11. Show branding customization (Amarant logo + colors)

## Success Criteria
- Upload document → AI extraction in <5 seconds
- Classification accuracy visible and editable
- Risk scoring with clear explanation
- Professional, polished UI that feels like a real product
- Bulgarian language throughout
- Works on localhost, demoable via screen share

## Implementation Priority
P0 (must have for demo):
- Claims CRUD + document upload + OCR extraction
- AI classification + risk scoring
- Pipeline status management
- Dashboard with KPIs
- Claims list + detail views
- Professional UI

P1 (nice to have):
- Fraud detection
- Excel export
- Policy management
- Reports page

P2 (post-demo):
- Email ingestion
- Multi-tenant
- IMAP auto-polling
- Insurer API integrations
