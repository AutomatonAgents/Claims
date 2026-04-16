// rbac.js — Shared RBAC helpers for AutomatON Invoice Platform
// Single source of truth: used by server.js, bank-module.js, classify-module.js

const db = require('./db');

function requireAdmin(req, res) {
  if (req.user && req.user.role === 'admin') return true;
  res.status(403).json({ success: false, error: 'Недостатъчни права.' });
  return false;
}

function requireClientAccess(req, res, clientEik) {
  if (!clientEik) { res.status(400).json({ success: false, error: 'Липсва client_eik.' }); return false; }
  if (req.user && req.user.role === 'admin') return true;
  const allowed = db.getAssignedClientEiks(req.user.id, true);
  if (allowed.includes(String(clientEik))) return true;
  res.status(403).json({ success: false, error: 'Нямате достъп до този клиент.' });
  return false;
}

function getEffectiveClientEik(req) {
  const requested = req.query.client_eik || req.body?.client_eik;
  if (requested) return String(requested);
  if (req.user && req.user.role === 'admin') return null; // admin sees all
  const assigned = db.getAssignedClientEiks(req.user.id, false);
  return assigned.length > 0 ? assigned[0] : '__none__'; // __none__ returns empty results
}

/**
 * requireClientEik — For WRITE operations where an explicit client_eik is mandatory.
 * Returns the client_eik string or null (after sending 400 response).
 * Usage: const eik = requireClientEik(req, res); if (!eik) return;
 */
function requireClientEik(req, res) {
  const eik = req.query.client_eik || req.body?.client_eik;
  if (!eik) {
    res.status(400).json({ success: false, error: 'Липсва client_eik. За запис е необходим изричен client_eik.' });
    return null;
  }
  return String(eik);
}

module.exports = { requireAdmin, requireClientAccess, getEffectiveClientEik, requireClientEik };
