const db = require('../db/init');

/**
 * Records who changed what, and when. Call this after any create, update,
 * delete, or status change so every item has a visible history.
 */
function logAudit(req, { entityType, entityId, entityLabel, action, summary }) {
  try {
    db.prepare(`INSERT INTO audit_log (entity_type,entity_id,entity_label,user_id,user_name,action,summary,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      entityType, entityId, entityLabel || '', req.user ? req.user.id : null,
      req.user ? req.user.name : 'Unknown', action, summary || '', new Date().toISOString()
    );
  } catch (e) {
    console.error('Audit log write failed:', e.message);
  }
}

/** Builds a short human-readable "changed X from A to B" summary for a PUT. */
function diffSummary(oldRow, newValues, fieldLabels) {
  const parts = [];
  for (const [key, label] of Object.entries(fieldLabels)) {
    const before = oldRow[key];
    const after = newValues[key];
    if (after !== undefined && String(before ?? '') !== String(after ?? '')) {
      parts.push(`${label}: "${before ?? '—'}" → "${after ?? '—'}"`);
    }
  }
  return parts.join('; ');
}

module.exports = { logAudit, diffSummary };
