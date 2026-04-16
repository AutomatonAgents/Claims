const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'data', 'claims.db');

let db;

function getDB() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

// ─── Schema ────────────────────────────────────────────────────────────────

function initDB() {
  const db = getDB();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE,
      password_hash TEXT,
      role TEXT,
      full_name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY,
      case_number TEXT UNIQUE NOT NULL,
      insurer_claim_number TEXT,
      status TEXT NOT NULL DEFAULT 'received',
      priority TEXT DEFAULT 'normal',
      assigned_to INTEGER REFERENCES users(id),

      next_action TEXT,
      next_action_due_date TEXT,
      last_contact_date TEXT,
      overdue_reason TEXT,

      policy_number TEXT,
      policy_type TEXT,
      insurer_name TEXT,
      insurer_branch TEXT,
      insurer_contact TEXT,

      incident_date TEXT,
      incident_location TEXT,
      incident_description TEXT,
      claim_type TEXT,
      sub_type TEXT,

      estimated_amount REAL,
      insurer_approved_amount REAL,
      paid_amount REAL,
      currency TEXT DEFAULT 'BGN',

      extraction_confidence REAL,
      ai_notes TEXT,

      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      submitted_to_insurer_at TEXT,
      insurer_decision_at TEXT,
      paid_at TEXT,
      closed_at TEXT,
      cancelled_at TEXT,
      cancellation_reason TEXT,
      is_deleted INTEGER DEFAULT 0,
      created_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS parties (
      id INTEGER PRIMARY KEY,
      case_id INTEGER NOT NULL REFERENCES cases(id),
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      egn TEXT,
      phone TEXT,
      email TEXT,
      iban TEXT,
      address TEXT,
      power_of_attorney INTEGER DEFAULT 0,
      is_at_fault INTEGER,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY,
      case_id INTEGER NOT NULL REFERENCES cases(id),
      owner_party_id INTEGER REFERENCES parties(id),
      driver_party_id INTEGER REFERENCES parties(id),
      role TEXT NOT NULL,
      reg_no TEXT,
      vin TEXT,
      make TEXT,
      model TEXT,
      year INTEGER,
      color TEXT,
      damage_description TEXT,
      service_center TEXT,
      insurer_name TEXT,
      policy_number TEXT
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      case_id INTEGER NOT NULL REFERENCES cases(id),
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mimetype TEXT,
      size_bytes INTEGER,
      doc_type TEXT NOT NULL,
      ocr_raw TEXT,
      ocr_confidence REAL,
      uploaded_at TEXT DEFAULT (datetime('now')),
      uploaded_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS document_requirements (
      id INTEGER PRIMARY KEY,
      claim_type TEXT NOT NULL,
      policy_type TEXT,
      doc_type TEXT NOT NULL,
      requirement TEXT NOT NULL DEFAULT 'required',
      min_count INTEGER DEFAULT 1,
      condition_description TEXT,
      insurer_specific TEXT,
      description_bg TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS case_timeline (
      id INTEGER PRIMARY KEY,
      case_id INTEGER NOT NULL REFERENCES cases(id),
      action TEXT NOT NULL,
      old_status TEXT,
      new_status TEXT,
      actor TEXT NOT NULL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS communications (
      id INTEGER PRIMARY KEY,
      case_id INTEGER NOT NULL REFERENCES cases(id),
      direction TEXT NOT NULL,
      channel TEXT,
      subject TEXT,
      body TEXT,
      response_type TEXT,
      follow_up_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      created_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY,
      case_id INTEGER NOT NULL REFERENCES cases(id),
      decision_type TEXT NOT NULL,
      approved_amount REAL,
      rejection_reason TEXT,
      decision_date TEXT,
      decision_document TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY,
      case_id INTEGER NOT NULL REFERENCES cases(id),
      amount REAL NOT NULL,
      payment_date TEXT,
      payment_method TEXT,
      reference TEXT,
      recipient_party_id INTEGER REFERENCES parties(id),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS processing_jobs (
      id INTEGER PRIMARY KEY,
      case_id INTEGER,
      document_id INTEGER,
      job_type TEXT NOT NULL,
      status TEXT DEFAULT 'queued',
      locked_at TEXT,
      depends_on_type TEXT,
      depends_on_job_id INTEGER REFERENCES processing_jobs(id),
      result TEXT,
      error TEXT,
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 3,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY,
      user_id INTEGER,
      action TEXT,
      entity_type TEXT,
      entity_id INTEGER,
      details TEXT,
      ip_address TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Seed document requirements ──────────────────────────────────────────

  const existingReqs = db.prepare('SELECT COUNT(*) AS cnt FROM document_requirements').get();
  if (existingReqs.cnt === 0) {
    const insertReq = db.prepare(`
      INSERT INTO document_requirements (claim_type, policy_type, doc_type, requirement, min_count, condition_description, insurer_specific, description_bg)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const seedReqs = db.transaction(() => {
      // ── Auto Collision ──
      insertReq.run('auto_collision', null, 'bilateral_statement', 'required', 1, null, null, 'Двустранен констативен протокол');
      insertReq.run('auto_collision', null, 'kat_protocol', 'conditional', 1, 'Ако има пострадали или спор за вина', null, 'КАТ протокол');
      insertReq.run('auto_collision', null, 'damage_photo', 'required', 4, null, null, 'Снимки на щетите (мин. 4: преден, заден, 2 странични + детайл)');
      insertReq.run('auto_collision', null, 'police_report', 'conditional', 1, 'Ако има пострадали', null, 'Полицейски протокол');
      insertReq.run('auto_collision', null, 'id_copy', 'required', 1, null, null, 'Копие на лична карта на застрахования');
      insertReq.run('auto_collision', null, 'policy_copy', 'required', 1, null, null, 'Копие на полицата');
      insertReq.run('auto_collision', null, 'vehicle_registration', 'required', 1, null, null, 'Талон на МПС');
      insertReq.run('auto_collision', null, 'repair_invoice', 'optional', 1, null, null, 'Фактура от сервиз (ако вече е ремонтирано)');
      insertReq.run('auto_collision', null, 'expert_assessment', 'optional', 1, null, null, 'Оценка от вещо лице');

      // ── Auto Theft ──
      insertReq.run('auto_theft', null, 'police_report', 'required', 1, null, null, 'Протокол от МВР за кражба');
      insertReq.run('auto_theft', null, 'policy_copy', 'required', 1, null, null, 'Копие на полицата');
      insertReq.run('auto_theft', null, 'id_copy', 'required', 1, null, null, 'Копие на лична карта');
      insertReq.run('auto_theft', null, 'vehicle_keys_declaration', 'required', 1, null, null, 'Декларация за предадени ключове');
      insertReq.run('auto_theft', null, 'vehicle_registration', 'required', 1, null, null, 'Талон на МПС');

      // ── Auto Glass ──
      insertReq.run('auto_glass', null, 'damage_photo', 'required', 2, null, null, 'Снимки на счупеното стъкло');
      insertReq.run('auto_glass', null, 'policy_copy', 'required', 1, null, null, 'Копие на полицата');
      insertReq.run('auto_glass', null, 'id_copy', 'required', 1, null, null, 'Копие на лична карта');
      insertReq.run('auto_glass', null, 'vehicle_registration', 'required', 1, null, null, 'Талон на МПС');
      insertReq.run('auto_glass', null, 'repair_invoice', 'optional', 1, null, null, 'Фактура от сервиз (ако вече е сменено)');

      // ── Property Fire ──
      insertReq.run('property_fire', null, 'damage_photo', 'required', 4, null, null, 'Снимки на щетите');
      insertReq.run('property_fire', null, 'policy_copy', 'required', 1, null, null, 'Копие на полицата');
      insertReq.run('property_fire', null, 'expert_assessment', 'required', 1, null, null, 'Оценка от вещо лице');
      insertReq.run('property_fire', null, 'ownership_proof', 'required', 1, null, null, 'Документ за собственост');
      insertReq.run('property_fire', null, 'incident_report', 'required', 1, null, null, 'Писмено описание на събитието');
      insertReq.run('property_fire', null, 'police_report', 'conditional', 1, 'Ако има съмнение за умишлен палеж', null, 'Полицейски протокол');

      // ── Property Flood ──
      insertReq.run('property_flood', null, 'damage_photo', 'required', 4, null, null, 'Снимки на щетите');
      insertReq.run('property_flood', null, 'policy_copy', 'required', 1, null, null, 'Копие на полицата');
      insertReq.run('property_flood', null, 'expert_assessment', 'required', 1, null, null, 'Оценка от вещо лице');
      insertReq.run('property_flood', null, 'ownership_proof', 'required', 1, null, null, 'Документ за собственост');
      insertReq.run('property_flood', null, 'incident_report', 'required', 1, null, null, 'Писмено описание на събитието');

      // ── Property Theft ──
      insertReq.run('property_theft', null, 'damage_photo', 'required', 4, null, null, 'Снимки на щетите');
      insertReq.run('property_theft', null, 'policy_copy', 'required', 1, null, null, 'Копие на полицата');
      insertReq.run('property_theft', null, 'expert_assessment', 'required', 1, null, null, 'Оценка от вещо лице');
      insertReq.run('property_theft', null, 'ownership_proof', 'required', 1, null, null, 'Документ за собственост');
      insertReq.run('property_theft', null, 'incident_report', 'required', 1, null, null, 'Писмено описание на събитието');
      insertReq.run('property_theft', null, 'police_report', 'required', 1, null, null, 'Полицейски протокол за кражба');

      // ── Insurer-specific overrides ──
      insertReq.run('auto_collision', null, 'damage_photo', 'required', 6, null, 'ДЗИ', 'ДЗИ изисква 6 снимки (4 ъгъла + 2 детайла)');
      insertReq.run('auto_collision', null, 'expert_assessment', 'required', 1, null, 'Алианц', 'Алианц винаги иска вещо лице');
      insertReq.run('auto_theft', null, 'police_report', 'required', 2, null, 'Булстрад', 'Булстрад иска и протокол от районно');
    });
    seedReqs();
  }

  // ── Seed default admin user ─────────────────────────────────────────────

  const existingUsers = db.prepare('SELECT COUNT(*) AS cnt FROM users').get();
  if (existingUsers.cnt === 0) {
    const passwordHash = crypto.createHash('sha256').update('admin123').digest('hex');
    db.prepare(`
      INSERT INTO users (username, password_hash, role, full_name)
      VALUES (?, ?, ?, ?)
    `).run('admin', passwordHash, 'admin', 'Администратор');
  }

  // ── Seed demo cases ─────────────────────────────────────────────────────

  const existingCases = db.prepare('SELECT COUNT(*) AS cnt FROM cases').get();
  if (existingCases.cnt === 0) {
    const adminUser = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    const adminId = adminUser ? adminUser.id : null;

    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const fifteenDaysAgo = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);
    const twentyDaysAgo = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);

    const seedCases = db.transaction(() => {
      // ── Case 1: AMR-2026-0001 — Каско ПТП, validated_by_broker ──
      db.prepare(`
        INSERT INTO cases (case_number, status, priority, assigned_to, next_action, next_action_due_date,
          policy_number, policy_type, insurer_name, incident_date, incident_location, incident_description,
          claim_type, estimated_amount, currency, extraction_confidence, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'AMR-2026-0001', 'validated_by_broker', 'normal', adminId,
        'Подгответе пакет за изпращане до Алианц', tomorrow,
        'CSK-2026-445566', 'casco', 'Алианц',
        tenDaysAgo, 'София, бул. Витоша / ул. Граф Игнатиев',
        'ПТП на кръстовище. Удар в задната част на автомобила на застрахования от насрещно движещо се МПС.',
        'auto_collision', 4500.00, 'BGN', 0.92, adminId, fifteenDaysAgo
      );

      const case1Id = db.prepare('SELECT id FROM cases WHERE case_number = ?').get('AMR-2026-0001').id;

      // Parties for case 1
      const insertParty = db.prepare(`
        INSERT INTO parties (case_id, role, name, egn, phone, email, address, power_of_attorney, is_at_fault)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertParty.run(case1Id, 'insured', 'Георги Иванов Петров', '8501124578', '+359888123456', 'g.petrov@mail.bg', 'София, ул. Алабин 12', 1, 0);
      insertParty.run(case1Id, 'counterparty_driver', 'Мария Стоянова Димитрова', '9003287612', '+359877654321', null, 'София, ж.к. Люлин бл. 45', 0, 1);

      const party1 = db.prepare("SELECT id FROM parties WHERE case_id = ? AND role = 'insured'").get(case1Id);
      const party2 = db.prepare("SELECT id FROM parties WHERE case_id = ? AND role = 'counterparty_driver'").get(case1Id);

      // Vehicles for case 1
      const insertVehicle = db.prepare(`
        INSERT INTO vehicles (case_id, owner_party_id, driver_party_id, role, reg_no, vin, make, model, year, color, damage_description, insurer_name, policy_number)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertVehicle.run(case1Id, party1.id, party1.id, 'claimant_vehicle', 'СА 1234 ВК', 'WVWZZZ3CZWE123456', 'Volkswagen', 'Golf', 2020, 'сив', 'Деформиран заден капак и броня, счупен ляв стоп', null, null);
      insertVehicle.run(case1Id, party2.id, party2.id, 'counterparty_vehicle', 'СА 5678 МН', 'TMBJG7NE1J0123456', 'Skoda', 'Octavia', 2018, 'бял', 'Увредена предна броня и маска', 'Лев Инс', 'GO-2026-998877');

      // Documents for case 1 (all required docs present)
      const insertDoc = db.prepare(`
        INSERT INTO documents (case_id, filename, original_name, mimetype, size_bytes, doc_type, ocr_confidence, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertDoc.run(case1Id, 'c1_bilateral.pdf', 'dvustranen_protokol.pdf', 'application/pdf', 245000, 'bilateral_statement', 0.95, adminId);
      insertDoc.run(case1Id, 'c1_photo_1.jpg', 'shteta_zad.jpg', 'image/jpeg', 1800000, 'damage_photo', 0.88, adminId);
      insertDoc.run(case1Id, 'c1_photo_2.jpg', 'shteta_lqvo.jpg', 'image/jpeg', 1650000, 'damage_photo', 0.90, adminId);
      insertDoc.run(case1Id, 'c1_photo_3.jpg', 'shteta_dqsno.jpg', 'image/jpeg', 1720000, 'damage_photo', 0.87, adminId);
      insertDoc.run(case1Id, 'c1_photo_4.jpg', 'shteta_detayl.jpg', 'image/jpeg', 2100000, 'damage_photo', 0.91, adminId);
      insertDoc.run(case1Id, 'c1_id.jpg', 'lk_petrov.jpg', 'image/jpeg', 850000, 'id_copy', 0.93, adminId);
      insertDoc.run(case1Id, 'c1_policy.pdf', 'polica_casco.pdf', 'application/pdf', 320000, 'policy_copy', 0.96, adminId);
      insertDoc.run(case1Id, 'c1_talon.jpg', 'talon_golf.jpg', 'image/jpeg', 780000, 'vehicle_registration', 0.94, adminId);

      // Timeline for case 1
      const insertTimeline = db.prepare(`
        INSERT INTO case_timeline (case_id, action, old_status, new_status, actor, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insertTimeline.run(case1Id, 'case_created', null, 'received', 'admin', 'Случай създаден от прием на документи', fifteenDaysAgo);
      insertTimeline.run(case1Id, 'status_change', 'received', 'awaiting_client_docs', 'admin', 'Липсва талон на МПС', tenDaysAgo);
      insertTimeline.run(case1Id, 'document_uploaded', null, null, 'admin', 'Качен талон на МПС', tenDaysAgo);
      insertTimeline.run(case1Id, 'status_change', 'awaiting_client_docs', 'validated_by_broker', 'admin', 'Всички документи налични, готов за изпращане', tenDaysAgo);

      // ── Case 2: AMR-2026-0002 — ГО/MTPL, awaiting_client_docs ──
      db.prepare(`
        INSERT INTO cases (case_number, status, priority, assigned_to, next_action, next_action_due_date,
          policy_number, policy_type, insurer_name, incident_date, incident_location, incident_description,
          claim_type, estimated_amount, currency, extraction_confidence, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'AMR-2026-0002', 'awaiting_client_docs', 'high', adminId,
        'Обадете се на клиента за двустранен протокол', tomorrow,
        'GO-2026-112233', 'mtpl', 'Булстрад',
        fiveDaysAgo, 'Пловдив, ул. Капитан Райчо 15',
        'ПТП при паркиране. Виновен водач е блъснал паркиран автомобил и е напуснал мястото.',
        'auto_collision', 2800.00, 'BGN', 0.75, adminId, fiveDaysAgo
      );

      const case2Id = db.prepare('SELECT id FROM cases WHERE case_number = ?').get('AMR-2026-0002').id;

      // Parties for case 2
      insertParty.run(case2Id, 'insured', 'Стоян Николаев Колев', '7806159834', '+359899112233', 's.kolev@abv.bg', 'Пловдив, ул. Гладстон 8', 0, 0);
      insertParty.run(case2Id, 'counterparty_driver', 'Неизвестен водач', null, null, null, null, 0, 1);

      const party3 = db.prepare("SELECT id FROM parties WHERE case_id = ? AND role = 'insured'").get(case2Id);

      // Vehicle for case 2
      insertVehicle.run(case2Id, party3.id, party3.id, 'claimant_vehicle', 'РВ 9876 АВ', 'WBAPH5C55BA123456', 'BMW', '320d', 2019, 'черен', 'Надраскана и вдлъбната лява врата, счупено ляво огледало', null, null);

      // Documents for case 2 (only 2 of required uploaded)
      insertDoc.run(case2Id, 'c2_photo_1.jpg', 'bmw_shteta_1.jpg', 'image/jpeg', 1950000, 'damage_photo', 0.85, adminId);
      insertDoc.run(case2Id, 'c2_policy.pdf', 'polica_go.pdf', 'application/pdf', 290000, 'policy_copy', 0.94, adminId);

      // Timeline for case 2
      insertTimeline.run(case2Id, 'case_created', null, 'received', 'admin', 'Случай създаден — клиент дойде с 2 документа', fiveDaysAgo);
      insertTimeline.run(case2Id, 'status_change', 'received', 'awaiting_client_docs', 'admin', 'Липсват двустранен протокол, лична карта, талон, снимки', fiveDaysAgo);

      // ── Case 3: AMR-2026-0003 — Имущество наводнение, awaiting_insurer_decision ──
      db.prepare(`
        INSERT INTO cases (case_number, status, priority, assigned_to, next_action, next_action_due_date,
          policy_number, policy_type, insurer_name, incident_date, incident_location, incident_description,
          claim_type, estimated_amount, currency, extraction_confidence, submitted_to_insurer_at, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'AMR-2026-0003', 'awaiting_insurer_decision', 'normal', adminId,
        'Проверете статус при ДЗИ', today,
        'PROP-2026-778899', 'property', 'ДЗИ',
        twentyDaysAgo, 'Бургас, ж.к. Славейков бл. 22, вх. А, ап. 14',
        'Наводнение от спукана тръба на горен етаж. Засегнати стени, подови настилки и мебели в хол и спалня.',
        'property_flood', 12000.00, 'BGN', 0.89, fiveDaysAgo, adminId, twentyDaysAgo
      );

      const case3Id = db.prepare('SELECT id FROM cases WHERE case_number = ?').get('AMR-2026-0003').id;

      // Party for case 3
      insertParty.run(case3Id, 'insured', 'Елена Тодорова Маринова', '9201085432', '+359878445566', 'e.marinova@gmail.com', 'Бургас, ж.к. Славейков бл. 22, вх. А, ап. 14', 1, null);

      // Documents for case 3 (all required docs present — was submitted)
      insertDoc.run(case3Id, 'c3_photo_1.jpg', 'navodnenie_hol_1.jpg', 'image/jpeg', 2200000, 'damage_photo', 0.86, adminId);
      insertDoc.run(case3Id, 'c3_photo_2.jpg', 'navodnenie_hol_2.jpg', 'image/jpeg', 2050000, 'damage_photo', 0.88, adminId);
      insertDoc.run(case3Id, 'c3_photo_3.jpg', 'navodnenie_spalnya.jpg', 'image/jpeg', 1900000, 'damage_photo', 0.84, adminId);
      insertDoc.run(case3Id, 'c3_photo_4.jpg', 'navodnenie_pod.jpg', 'image/jpeg', 2150000, 'damage_photo', 0.87, adminId);
      insertDoc.run(case3Id, 'c3_policy.pdf', 'polica_imushtestvo.pdf', 'application/pdf', 350000, 'policy_copy', 0.95, adminId);
      insertDoc.run(case3Id, 'c3_expert.pdf', 'ocenka_veshto_lice.pdf', 'application/pdf', 520000, 'expert_assessment', 0.91, adminId);
      insertDoc.run(case3Id, 'c3_ownership.pdf', 'notarialen_akt.pdf', 'application/pdf', 410000, 'ownership_proof', 0.97, adminId);
      insertDoc.run(case3Id, 'c3_report.pdf', 'opisanie_sabitie.pdf', 'application/pdf', 180000, 'incident_report', 0.93, adminId);

      // Timeline for case 3
      insertTimeline.run(case3Id, 'case_created', null, 'received', 'admin', 'Случай създаден — наводнение от горен етаж', twentyDaysAgo);
      insertTimeline.run(case3Id, 'status_change', 'received', 'validated_by_broker', 'admin', 'Всички документи налични', fifteenDaysAgo);
      insertTimeline.run(case3Id, 'status_change', 'validated_by_broker', 'submitted_to_insurer', 'admin', 'Пакет изпратен до ДЗИ по имейл', fiveDaysAgo);
      insertTimeline.run(case3Id, 'status_change', 'submitted_to_insurer', 'awaiting_insurer_decision', 'admin', 'ДЗИ потвърдиха получаване, очакваме решение', fiveDaysAgo);
    });
    seedCases();
  }

  return db;
}

// ─── Query Helpers ─────────────────────────────────────────────────────────

// ── Cases ──

function getCases(filters = {}) {
  const db = getDB();
  let where = ['c.is_deleted = 0'];
  const params = [];

  if (filters.status) {
    where.push('c.status = ?');
    params.push(filters.status);
  }
  if (filters.claim_type) {
    where.push('c.claim_type = ?');
    params.push(filters.claim_type);
  }
  if (filters.assigned_to) {
    where.push('c.assigned_to = ?');
    params.push(filters.assigned_to);
  }
  if (filters.insurer_name) {
    where.push('c.insurer_name = ?');
    params.push(filters.insurer_name);
  }
  if (filters.priority) {
    where.push('c.priority = ?');
    params.push(filters.priority);
  }
  if (filters.overdue) {
    where.push("c.next_action_due_date < date('now') AND c.status NOT IN ('paid','closed')");
  }
  if (filters.date_from) {
    where.push('c.created_at >= ?');
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    where.push('c.created_at <= ?');
    params.push(filters.date_to);
  }
  if (filters.search) {
    where.push('(c.case_number LIKE ? OR c.insurer_claim_number LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term);
  }

  const sql = `
    SELECT c.*, u.full_name AS assigned_to_name,
      (SELECT COUNT(*) FROM documents d WHERE d.case_id = c.id) AS doc_count,
      (SELECT p.name FROM parties p WHERE p.case_id = c.id AND p.role IN ('insured','claimant') LIMIT 1) AS claimant_name
    FROM cases c
    LEFT JOIN users u ON c.assigned_to = u.id
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE WHEN c.next_action_due_date < date('now') AND c.status NOT IN ('paid','closed') THEN 0 ELSE 1 END,
      CASE WHEN c.next_action_due_date = date('now') THEN 0 ELSE 1 END,
      c.next_action_due_date ASC,
      c.created_at ASC
  `;
  return db.prepare(sql).all(...params);
}

function getCase(id) {
  const db = getDB();
  const caseRow = db.prepare(`
    SELECT c.*, u.full_name AS assigned_to_name
    FROM cases c
    LEFT JOIN users u ON c.assigned_to = u.id
    WHERE c.id = ? AND c.is_deleted = 0
  `).get(id);
  if (!caseRow) return null;

  caseRow.parties = getParties(id);
  caseRow.vehicles = getVehicles(id);
  caseRow.documents = getDocuments(id);
  caseRow.timeline = getTimeline(id);
  caseRow.communications = getCommunications(id);
  caseRow.decisions = getDecisions(id);
  caseRow.payments = getPayments(id);
  return caseRow;
}

function createCase(data) {
  const db = getDB();
  const fields = [
    'case_number', 'insurer_claim_number', 'status', 'priority', 'assigned_to',
    'next_action', 'next_action_due_date', 'last_contact_date', 'overdue_reason',
    'policy_number', 'policy_type', 'insurer_name', 'insurer_branch', 'insurer_contact',
    'incident_date', 'incident_location', 'incident_description', 'claim_type', 'sub_type',
    'estimated_amount', 'insurer_approved_amount', 'paid_amount', 'currency',
    'extraction_confidence', 'ai_notes', 'created_by'
  ];
  const present = fields.filter(f => data[f] !== undefined);
  const placeholders = present.map(() => '?').join(', ');
  const values = present.map(f => data[f]);

  const result = db.prepare(`
    INSERT INTO cases (${present.join(', ')})
    VALUES (${placeholders})
  `).run(...values);
  return { id: result.lastInsertRowid, ...data };
}

function updateCase(id, data) {
  const db = getDB();
  const fields = Object.keys(data).filter(k => k !== 'id');
  if (fields.length === 0) return null;

  // Always update updated_at
  if (!fields.includes('updated_at')) {
    fields.push('updated_at');
    data.updated_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  }

  const sets = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => data[f]);
  values.push(id);

  db.prepare(`UPDATE cases SET ${sets} WHERE id = ? AND is_deleted = 0`).run(...values);
  return getCase(id);
}

function softDeleteCase(id, reason) {
  const db = getDB();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    UPDATE cases SET is_deleted = 1, cancelled_at = ?, cancellation_reason = ?, updated_at = ?
    WHERE id = ?
  `).run(now, reason, now, id);
  return { id, is_deleted: 1 };
}

// ── Parties ──

function getParties(caseId) {
  return getDB().prepare('SELECT * FROM parties WHERE case_id = ?').all(caseId);
}

function createParty(data) {
  const db = getDB();
  const fields = ['case_id', 'role', 'name', 'egn', 'phone', 'email', 'iban', 'address', 'power_of_attorney', 'is_at_fault', 'notes'];
  const present = fields.filter(f => data[f] !== undefined);
  const placeholders = present.map(() => '?').join(', ');
  const values = present.map(f => data[f]);

  const result = db.prepare(`INSERT INTO parties (${present.join(', ')}) VALUES (${placeholders})`).run(...values);
  return { id: result.lastInsertRowid, ...data };
}

// ── Vehicles ──

function getVehicles(caseId) {
  return getDB().prepare('SELECT * FROM vehicles WHERE case_id = ?').all(caseId);
}

function createVehicle(data) {
  const db = getDB();
  const fields = ['case_id', 'owner_party_id', 'driver_party_id', 'role', 'reg_no', 'vin', 'make', 'model', 'year', 'color', 'damage_description', 'service_center', 'insurer_name', 'policy_number'];
  const present = fields.filter(f => data[f] !== undefined);
  const placeholders = present.map(() => '?').join(', ');
  const values = present.map(f => data[f]);

  const result = db.prepare(`INSERT INTO vehicles (${present.join(', ')}) VALUES (${placeholders})`).run(...values);
  return { id: result.lastInsertRowid, ...data };
}

// ── Documents ──

function getDocuments(caseId) {
  return getDB().prepare('SELECT * FROM documents WHERE case_id = ? ORDER BY uploaded_at DESC').all(caseId);
}

function createDocument(data) {
  const db = getDB();
  const fields = ['case_id', 'filename', 'original_name', 'mimetype', 'size_bytes', 'doc_type', 'ocr_raw', 'ocr_confidence', 'uploaded_by'];
  const present = fields.filter(f => data[f] !== undefined);
  const placeholders = present.map(() => '?').join(', ');
  const values = present.map(f => data[f]);

  const result = db.prepare(`INSERT INTO documents (${present.join(', ')}) VALUES (${placeholders})`).run(...values);
  return { id: result.lastInsertRowid, ...data };
}

function getDocumentRequirements(claimType, policyType, insurerName) {
  const db = getDB();

  // Get base requirements (insurer_specific IS NULL = applies to all)
  const baseReqs = db.prepare(`
    SELECT * FROM document_requirements
    WHERE claim_type = ? AND insurer_specific IS NULL
      AND (policy_type IS NULL OR policy_type = ?)
    ORDER BY requirement ASC, doc_type ASC
  `).all(claimType, policyType || null);

  // Get insurer-specific overrides
  let insurerOverrides = [];
  if (insurerName) {
    insurerOverrides = db.prepare(`
      SELECT * FROM document_requirements
      WHERE claim_type = ? AND insurer_specific = ?
        AND (policy_type IS NULL OR policy_type = ?)
    `).all(claimType, insurerName, policyType || null);
  }

  // Merge: insurer overrides replace base for matching doc_type
  const overrideMap = {};
  for (const ov of insurerOverrides) {
    overrideMap[ov.doc_type] = ov;
  }

  const merged = baseReqs.map(req => {
    if (overrideMap[req.doc_type]) {
      return { ...req, ...overrideMap[req.doc_type], _overridden_by: insurerName };
    }
    return req;
  });

  // Add any insurer-specific reqs that don't exist in base
  for (const ov of insurerOverrides) {
    if (!baseReqs.find(r => r.doc_type === ov.doc_type)) {
      merged.push({ ...ov, _overridden_by: insurerName });
    }
  }

  return merged;
}

// ── Timeline ──

function getTimeline(caseId) {
  return getDB().prepare('SELECT * FROM case_timeline WHERE case_id = ? ORDER BY created_at DESC').all(caseId);
}

function addTimelineEntry(data) {
  const db = getDB();
  const fields = ['case_id', 'action', 'old_status', 'new_status', 'actor', 'notes'];
  const present = fields.filter(f => data[f] !== undefined);
  const placeholders = present.map(() => '?').join(', ');
  const values = present.map(f => data[f]);

  const result = db.prepare(`INSERT INTO case_timeline (${present.join(', ')}) VALUES (${placeholders})`).run(...values);
  return { id: result.lastInsertRowid, ...data };
}

// ── Communications ──

function getCommunications(caseId) {
  return getDB().prepare('SELECT * FROM communications WHERE case_id = ? ORDER BY created_at DESC').all(caseId);
}

function addCommunication(data) {
  const db = getDB();
  const fields = ['case_id', 'direction', 'channel', 'subject', 'body', 'response_type', 'follow_up_date', 'created_by'];
  const present = fields.filter(f => data[f] !== undefined);
  const placeholders = present.map(() => '?').join(', ');
  const values = present.map(f => data[f]);

  const result = db.prepare(`INSERT INTO communications (${present.join(', ')}) VALUES (${placeholders})`).run(...values);

  // Auto-update last_contact_date on the case
  if (data.case_id) {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('UPDATE cases SET last_contact_date = ?, updated_at = ? WHERE id = ?').run(now, now, data.case_id);
  }

  return { id: result.lastInsertRowid, ...data };
}

// ── Decisions ──

function getDecisions(caseId) {
  return getDB().prepare('SELECT * FROM decisions WHERE case_id = ? ORDER BY created_at DESC').all(caseId);
}

function addDecision(data) {
  const db = getDB();
  const fields = ['case_id', 'decision_type', 'approved_amount', 'rejection_reason', 'decision_date', 'decision_document'];
  const present = fields.filter(f => data[f] !== undefined);
  const placeholders = present.map(() => '?').join(', ');
  const values = present.map(f => data[f]);

  const result = db.prepare(`INSERT INTO decisions (${present.join(', ')}) VALUES (${placeholders})`).run(...values);
  return { id: result.lastInsertRowid, ...data };
}

// ── Payments ──

function getPayments(caseId) {
  return getDB().prepare('SELECT * FROM payments WHERE case_id = ? ORDER BY created_at DESC').all(caseId);
}

function addPayment(data) {
  const db = getDB();
  const fields = ['case_id', 'amount', 'payment_date', 'payment_method', 'reference', 'recipient_party_id'];
  const present = fields.filter(f => data[f] !== undefined);
  const placeholders = present.map(() => '?').join(', ');
  const values = present.map(f => data[f]);

  const result = db.prepare(`INSERT INTO payments (${present.join(', ')}) VALUES (${placeholders})`).run(...values);
  return { id: result.lastInsertRowid, ...data };
}

// ── Processing Jobs ──

function createJob(data) {
  const db = getDB();
  const fields = ['case_id', 'document_id', 'job_type', 'status', 'depends_on_type', 'depends_on_job_id', 'max_attempts'];
  const present = fields.filter(f => data[f] !== undefined);
  const placeholders = present.map(() => '?').join(', ');
  const values = present.map(f => data[f]);

  const result = db.prepare(`INSERT INTO processing_jobs (${present.join(', ')}) VALUES (${placeholders})`).run(...values);
  return { id: result.lastInsertRowid, ...data };
}

function getJob(id) {
  return getDB().prepare('SELECT * FROM processing_jobs WHERE id = ?').get(id);
}

function getJobsForCase(caseId) {
  return getDB().prepare('SELECT * FROM processing_jobs WHERE case_id = ? ORDER BY created_at ASC').all(caseId);
}

function lockNextJob() {
  const db = getDB();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Stale lock recovery: any job locked > 60s still in 'locked' status → reset
  db.prepare(`
    UPDATE processing_jobs SET status = 'queued', locked_at = NULL
    WHERE status = 'locked' AND locked_at < datetime('now', '-60 seconds')
  `).run();

  // Find next ready job (in a transaction to prevent races)
  const job = db.transaction(() => {
    // Jobs with no dependency
    let candidate = db.prepare(`
      SELECT * FROM processing_jobs
      WHERE status = 'queued' AND depends_on_type IS NULL
      ORDER BY created_at ASC
      LIMIT 1
    `).get();

    if (!candidate) {
      // Jobs depending on specific job_id that is completed
      candidate = db.prepare(`
        SELECT pj.* FROM processing_jobs pj
        INNER JOIN processing_jobs dep ON pj.depends_on_job_id = dep.id
        WHERE pj.status = 'queued'
          AND pj.depends_on_type = 'job_id'
          AND dep.status = 'completed'
        ORDER BY pj.created_at ASC
        LIMIT 1
      `).get();
    }

    if (!candidate) {
      // Jobs depending on all_ocr_for_case — check if all OCR for that case are done
      const candidates = db.prepare(`
        SELECT * FROM processing_jobs
        WHERE status = 'queued' AND depends_on_type = 'all_ocr_for_case'
        ORDER BY created_at ASC
      `).all();

      for (const c of candidates) {
        const pending = db.prepare(`
          SELECT COUNT(*) AS cnt FROM processing_jobs
          WHERE case_id = ? AND job_type = 'ocr_extraction' AND status NOT IN ('completed', 'failed')
        `).get(c.case_id);

        if (pending.cnt === 0) {
          // All OCR jobs are done (completed or failed) — this job can run
          candidate = c;
          break;
        }
      }
    }

    if (candidate) {
      db.prepare(`
        UPDATE processing_jobs SET status = 'locked', locked_at = ?
        WHERE id = ?
      `).run(now, candidate.id);
      candidate.status = 'locked';
      candidate.locked_at = now;
    }

    return candidate || null;
  })();

  return job;
}

function completeJob(id, result) {
  const db = getDB();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    UPDATE processing_jobs SET status = 'completed', result = ?, completed_at = ?
    WHERE id = ?
  `).run(typeof result === 'string' ? result : JSON.stringify(result), now, id);
  return getJob(id);
}

function failJob(id, error) {
  const db = getDB();
  const job = getJob(id);
  if (!job) return null;

  const newAttempts = (job.attempts || 0) + 1;
  if (newAttempts >= (job.max_attempts || 3)) {
    db.prepare(`
      UPDATE processing_jobs SET status = 'failed', error = ?, attempts = ?
      WHERE id = ?
    `).run(error, newAttempts, id);
  } else {
    db.prepare(`
      UPDATE processing_jobs SET status = 'queued', locked_at = NULL, error = ?, attempts = ?
      WHERE id = ?
    `).run(error, newAttempts, id);
  }
  return getJob(id);
}

// ── Work Queue & Dashboard ──

function getWorkQueue(userId) {
  const db = getDB();
  let where = "c.is_deleted = 0 AND c.status NOT IN ('paid', 'closed')";
  const params = [];

  if (userId) {
    where += ' AND c.assigned_to = ?';
    params.push(userId);
  }

  return db.prepare(`
    SELECT c.*,
      u.full_name AS assigned_to_name,
      (SELECT COUNT(*) FROM documents d WHERE d.case_id = c.id) AS doc_count,
      (SELECT p.name FROM parties p WHERE p.case_id = c.id AND p.role IN ('insured','claimant') LIMIT 1) AS claimant_name,
      CASE
        WHEN c.next_action_due_date < date('now') THEN 'overdue'
        WHEN c.next_action_due_date = date('now') THEN 'due_today'
        WHEN c.next_action_due_date IS NOT NULL THEN 'upcoming'
        ELSE 'no_due_date'
      END AS urgency,
      CAST(julianday('now') - julianday(c.created_at) AS INTEGER) AS days_open
    FROM cases c
    LEFT JOIN users u ON c.assigned_to = u.id
    WHERE ${where}
    ORDER BY
      CASE
        WHEN c.next_action_due_date < date('now') THEN 0
        WHEN c.next_action_due_date = date('now') THEN 1
        WHEN c.next_action_due_date IS NOT NULL THEN 2
        ELSE 3
      END,
      c.next_action_due_date ASC,
      c.created_at ASC
  `).all(...params);
}

function getDashboardKPIs(userId) {
  const db = getDB();
  let userFilter = '';
  const params = [];
  if (userId) {
    userFilter = ' AND assigned_to = ?';
    params.push(userId);
  }

  const open = db.prepare(`
    SELECT COUNT(*) AS cnt FROM cases
    WHERE is_deleted = 0 AND status NOT IN ('paid','closed') ${userFilter}
  `).get(...params);

  const awaitingDocs = db.prepare(`
    SELECT COUNT(*) AS cnt FROM cases
    WHERE is_deleted = 0 AND status = 'awaiting_client_docs' ${userFilter}
  `).get(...params);

  const submitted = db.prepare(`
    SELECT COUNT(*) AS cnt FROM cases
    WHERE is_deleted = 0 AND status IN ('submitted_to_insurer','awaiting_insurer_decision','insurer_requested_info') ${userFilter}
  `).get(...params);

  const overdue = db.prepare(`
    SELECT COUNT(*) AS cnt FROM cases
    WHERE is_deleted = 0 AND next_action_due_date < date('now') AND status NOT IN ('paid','closed') ${userFilter}
  `).get(...params);

  const avgDays = db.prepare(`
    SELECT AVG(julianday(COALESCE(closed_at, datetime('now'))) - julianday(created_at)) AS avg_days
    FROM cases
    WHERE is_deleted = 0 ${userFilter}
  `).get(...params);

  const byInsurer = db.prepare(`
    SELECT insurer_name, COUNT(*) AS cnt FROM cases
    WHERE is_deleted = 0 AND status NOT IN ('paid','closed') ${userFilter}
    GROUP BY insurer_name ORDER BY cnt DESC
  `).all(...params);

  const byType = db.prepare(`
    SELECT claim_type, COUNT(*) AS cnt FROM cases
    WHERE is_deleted = 0 AND status NOT IN ('paid','closed') ${userFilter}
    GROUP BY claim_type ORDER BY cnt DESC
  `).all(...params);

  const byStatus = db.prepare(`
    SELECT status, COUNT(*) AS cnt FROM cases
    WHERE is_deleted = 0 ${userFilter}
    GROUP BY status ORDER BY cnt DESC
  `).all(...params);

  return {
    open_cases: open.cnt,
    awaiting_client_docs: awaitingDocs.cnt,
    submitted_to_insurer: submitted.cnt,
    overdue: overdue.cnt,
    avg_processing_days: avgDays.avg_days ? Math.round(avgDays.avg_days * 10) / 10 : 0,
    by_insurer: byInsurer,
    by_type: byType,
    by_status: byStatus
  };
}

// ── Users ──

function getUsers() {
  return getDB().prepare('SELECT id, username, role, full_name, created_at FROM users ORDER BY id').all();
}

function createUser(data) {
  const db = getDB();
  const passwordHash = crypto.createHash('sha256').update(data.password || 'changeme').digest('hex');
  const result = db.prepare(`
    INSERT INTO users (username, password_hash, role, full_name)
    VALUES (?, ?, ?, ?)
  `).run(data.username, passwordHash, data.role || 'broker', data.full_name || data.username);
  return { id: result.lastInsertRowid, username: data.username, role: data.role || 'broker', full_name: data.full_name || data.username };
}

function getUserByUsername(username) {
  return getDB().prepare('SELECT * FROM users WHERE username = ?').get(username);
}

// ── Audit Log ──

function addAuditLog(data) {
  const db = getDB();
  const result = db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, ip_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(data.user_id || null, data.action, data.entity_type || null, data.entity_id || null, data.details || null, data.ip_address || null);
  return { id: result.lastInsertRowid, ...data };
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  getDB,
  initDB,

  // Cases
  getCases,
  getCase,
  createCase,
  updateCase,
  softDeleteCase,

  // Parties
  getParties,
  createParty,

  // Vehicles
  getVehicles,
  createVehicle,

  // Documents
  getDocuments,
  createDocument,
  getDocumentRequirements,

  // Timeline
  getTimeline,
  addTimelineEntry,

  // Communications
  getCommunications,
  addCommunication,

  // Decisions
  getDecisions,
  addDecision,

  // Payments
  getPayments,
  addPayment,

  // Processing Jobs
  createJob,
  getJob,
  getJobsForCase,
  lockNextJob,
  completeJob,
  failJob,

  // Work Queue & Dashboard
  getWorkQueue,
  getDashboardKPIs,

  // Users
  getUsers,
  createUser,
  getUserByUsername,

  // Audit
  addAuditLog
};
