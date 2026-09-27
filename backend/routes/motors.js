const express = require('express');
const db = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit, diffSummary } = require('../services/audit');
const router = express.Router();

function rowToMotor(r) {
  const locType = r.location_type || 'Mill floor';
  const detail = r.placement_detail || '';
  return {
    id: r.id, tag: r.tag, name: r.name, department: r.department,
    kw: r.hp, voltage: r.voltage, rpm: r.rpm, manualStatus: r.manual_status,
    locationType: locType, placementDetail: detail,
    currentLocation: detail ? `${locType} — ${detail}` : locType,
    standbyCategory: r.standby_category || 'new',
    condition: r.condition_notes,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM motors ORDER BY tag').all();
  res.json(rows.map(rowToMotor));
});

router.post('/', requireAuth, requireRole('admin', 'technician'), (req, res) => {
  const b = req.body || {};
  const tag = (b.tag || 'UNTAGGED').trim();
  const dupe = db.prepare('SELECT id FROM motors WHERE LOWER(tag) = LOWER(?)').get(tag);
  if (dupe) return res.status(409).json({ error: `A motor with tag "${tag}" already exists. Each motor needs a unique tag.` });
  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO motors
    (tag,name,department,hp,voltage,rpm,manual_status,current_location,location_type,placement_detail,standby_category,condition_notes,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    tag, b.name || 'Unnamed motor', b.department || 'Milling',
    b.kw || 0, b.voltage || 415, b.rpm || 1450, b.manualStatus || 'running',
    '', b.locationType || 'Mill floor', b.placementDetail || '', b.standbyCategory || 'new', b.condition || '', now, now
  );
  logAudit(req, { entityType: 'motors', entityId: info.lastInsertRowid, entityLabel: tag, action: 'create', summary: `Added motor "${tag}" — ${b.name || ''}` });
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/:id', requireAuth, requireRole('admin', 'technician'), (req, res) => {
  const b = req.body || {};
  const now = new Date().toISOString();
  const oldRow = db.prepare('SELECT * FROM motors WHERE id = ?').get(req.params.id);
  if (!oldRow) return res.status(404).json({ error: 'Motor not found.' });
  const tag = (b.tag || '').trim();
  const dupe = db.prepare('SELECT id FROM motors WHERE LOWER(tag) = LOWER(?) AND id != ?').get(tag, req.params.id);
  if (dupe) return res.status(409).json({ error: `A motor with tag "${tag}" already exists. Each motor needs a unique tag.` });

  db.prepare(`UPDATE motors SET tag=?,name=?,department=?,hp=?,voltage=?,rpm=?,manual_status=?,location_type=?,placement_detail=?,standby_category=?,condition_notes=?,updated_at=? WHERE id=?`)
    .run(tag, b.name, b.department, b.kw, b.voltage, b.rpm, b.manualStatus, b.locationType || 'Mill floor', b.placementDetail || '', b.standbyCategory || 'new', b.condition, now, req.params.id);

  const summary = diffSummary(oldRow, {
    tag: b.tag, name: b.name, department: b.department, hp: b.kw, manual_status: b.manualStatus,
    location_type: b.locationType, placement_detail: b.placementDetail, standby_category: b.standbyCategory, condition_notes: b.condition,
  }, {
    tag: 'Tag', name: 'Name', department: 'Department', hp: 'kW', manual_status: 'Status',
    location_type: 'Location type', placement_detail: 'Placement', standby_category: 'Spare category', condition_notes: 'Condition',
  });
  logAudit(req, { entityType: 'motors', entityId: req.params.id, entityLabel: b.tag, action: 'update', summary: summary || 'Updated with no field changes.' });
  res.json({ ok: true });
});

// Bulk create — paste a list of motors, or import from a CSV file. Rows
// whose tag already exists (in the database, or earlier in the same
// batch) are skipped rather than failing the whole import.
router.post('/bulk', requireAuth, requireRole('admin', 'technician'), (req, res) => {
  const rows = Array.isArray(req.body?.motors) ? req.body.motors : [];
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO motors
    (tag,name,department,hp,voltage,rpm,manual_status,current_location,location_type,placement_detail,standby_category,condition_notes,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const findTag = db.prepare('SELECT id FROM motors WHERE LOWER(tag) = LOWER(?)');
  const seenInBatch = new Set();
  const skipped = [];
  const tx = db.transaction((items) => {
    for (const b of items) {
      const tag = (b.tag || 'UNTAGGED').trim();
      if (seenInBatch.has(tag.toLowerCase()) || findTag.get(tag)) { skipped.push(tag); continue; }
      seenInBatch.add(tag.toLowerCase());
      const info = insert.run(tag, b.name || tag || 'Unnamed motor', b.department || 'Milling',
        parseFloat(b.kw) || 0, parseInt(b.voltage) || 415, parseInt(b.rpm) || 1450, b.manualStatus || 'running',
        '', b.locationType || 'Mill floor', b.placementDetail || b.currentLocation || '', b.standbyCategory || 'new', b.condition || '', now, now);
      logAudit(req, { entityType: 'motors', entityId: info.lastInsertRowid, entityLabel: tag, action: 'create', summary: `Added via bulk import — "${tag}"` });
    }
  });
  tx(rows);
  res.status(201).json({ added: rows.length - skipped.length, skipped });
});

// Delete is open to any signed-in role — anyone on the team can remove a
// mistaken or retired entry, not just admins. Deleting a motor also removes
// its breakdown/repair history (can't leave orphaned records pointing at a
// motor that no longer exists) — both are logged.
router.delete('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT tag FROM motors WHERE id = ?').get(req.params.id);
  if (!row) return res.json({ ok: true });
  const tx = db.transaction(() => {
    const removedEvents = db.prepare('SELECT COUNT(*) AS n FROM events WHERE motor_id = ?').get(req.params.id).n;
    db.prepare('DELETE FROM events WHERE motor_id = ?').run(req.params.id);
    db.prepare('DELETE FROM motors WHERE id = ?').run(req.params.id);
    return removedEvents;
  });
  const removedEvents = tx();
  logAudit(req, { entityType: 'motors', entityId: req.params.id, entityLabel: row.tag, action: 'delete', summary: `Deleted motor "${row.tag}"${removedEvents ? ` and ${removedEvents} breakdown record(s)` : ''}` });
  res.json({ ok: true, removedEvents });
});

router.post('/bulk-delete', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.json({ deleted: 0 });
  const del = db.prepare('DELETE FROM motors WHERE id = ?');
  const delEvents = db.prepare('DELETE FROM events WHERE motor_id = ?');
  const countEvents = db.prepare('SELECT COUNT(*) AS n FROM events WHERE motor_id = ?');
  const getTag = db.prepare('SELECT tag FROM motors WHERE id = ?');
  const tx = db.transaction((items) => {
    items.forEach(id => {
      const row = getTag.get(id);
      const n = countEvents.get(id).n;
      delEvents.run(id);
      del.run(id);
      if (row) logAudit(req, { entityType: 'motors', entityId: id, entityLabel: row.tag, action: 'delete', summary: `Deleted motor "${row.tag}"${n ? ` and ${n} breakdown record(s)` : ''} (bulk delete)` });
    });
  });
  tx(ids);
  res.json({ deleted: ids.length });
});

module.exports = router;
