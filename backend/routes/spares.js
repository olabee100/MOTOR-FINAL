const express = require('express');
const db = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit, diffSummary } = require('../services/audit');
const router = express.Router();

function rowToSpare(r) {
  return {
    id: r.id, name: r.name, partNumber: r.part_number, category: r.category,
    qty: r.qty, minQty: r.min_qty, unitCost: r.unit_cost, location: r.location,
    supplier: r.supplier, compatibleMotorIds: JSON.parse(r.compatible_motor_ids || '[]'),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM spares ORDER BY name').all();
  res.json(rows.map(rowToSpare));
});

router.post('/', requireAuth, requireRole('admin', 'storekeeper'), (req, res) => {
  const b = req.body || {};
  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO spares
    (name,part_number,category,qty,min_qty,unit_cost,location,supplier,compatible_motor_ids,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    b.name || 'Unnamed part', b.partNumber || '', b.category || 'Other',
    b.qty || 0, b.minQty || 0, b.unitCost || 0, b.location || '', b.supplier || '',
    JSON.stringify(b.compatibleMotorIds || []), now, now
  );
  logAudit(req, { entityType: 'spares', entityId: info.lastInsertRowid, entityLabel: b.name, action: 'create', summary: `Added spare "${b.name}" — qty ${b.qty || 0}` });
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/:id', requireAuth, requireRole('admin', 'storekeeper'), (req, res) => {
  const b = req.body || {};
  const now = new Date().toISOString();
  const oldRow = db.prepare('SELECT * FROM spares WHERE id = ?').get(req.params.id);
  if (!oldRow) return res.status(404).json({ error: 'Spare not found.' });

  db.prepare(`UPDATE spares SET name=?,part_number=?,category=?,qty=?,min_qty=?,unit_cost=?,location=?,supplier=?,updated_at=? WHERE id=?`)
    .run(b.name, b.partNumber, b.category, b.qty, b.minQty, b.unitCost, b.location, b.supplier, now, req.params.id);

  const summary = diffSummary(oldRow, {
    name: b.name, part_number: b.partNumber, category: b.category, qty: b.qty,
    min_qty: b.minQty, unit_cost: b.unitCost, location: b.location, supplier: b.supplier,
  }, {
    name: 'Name', part_number: 'Part number', category: 'Category', qty: 'Qty',
    min_qty: 'Min qty', unit_cost: 'Unit cost', location: 'Location', supplier: 'Supplier',
  });
  logAudit(req, { entityType: 'spares', entityId: req.params.id, entityLabel: b.name, action: 'update', summary: summary || 'Updated with no field changes.' });
  res.json({ ok: true });
});

// Quick stock adjustment (+received / -damaged/miscounted, etc.)
router.post('/:id/adjust', requireAuth, requireRole('admin', 'storekeeper'), (req, res) => {
  const delta = parseInt(req.body?.delta) || 0;
  const row = db.prepare('SELECT * FROM spares WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Spare not found.' });
  const newQty = Math.max(0, row.qty + delta);
  db.prepare('UPDATE spares SET qty = ?, updated_at = ? WHERE id = ?').run(newQty, new Date().toISOString(), req.params.id);
  logAudit(req, { entityType: 'spares', entityId: req.params.id, entityLabel: row.name, action: 'adjust', summary: `Stock ${delta >= 0 ? '+' : ''}${delta} (${row.qty} → ${newQty})` });
  res.json({ ok: true, qty: newQty });
});

// Bulk create — paste a list of spares at once
router.post('/bulk', requireAuth, requireRole('admin', 'storekeeper'), (req, res) => {
  const rows = Array.isArray(req.body?.spares) ? req.body.spares : [];
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO spares
    (name,part_number,category,qty,min_qty,unit_cost,location,supplier,compatible_motor_ids,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const tx = db.transaction((items) => {
    for (const b of items) {
      const info = insert.run(b.name || 'Unnamed part', b.partNumber || '', b.category || 'Other',
        parseInt(b.qty) || 0, parseInt(b.minQty) || 0, parseFloat(b.unitCost) || 0,
        b.location || '', b.supplier || '', '[]', now, now);
      logAudit(req, { entityType: 'spares', entityId: info.lastInsertRowid, entityLabel: b.name, action: 'create', summary: `Added via bulk import — "${b.name}"` });
    }
  });
  tx(rows);
  res.status(201).json({ added: rows.length });
});

router.delete('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT name FROM spares WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM spares WHERE id = ?').run(req.params.id);
  if (row) logAudit(req, { entityType: 'spares', entityId: req.params.id, entityLabel: row.name, action: 'delete', summary: `Deleted spare "${row.name}"` });
  res.json({ ok: true });
});

router.post('/bulk-delete', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.json({ deleted: 0 });
  const del = db.prepare('DELETE FROM spares WHERE id = ?');
  const getName = db.prepare('SELECT name FROM spares WHERE id = ?');
  const tx = db.transaction((items) => {
    items.forEach(id => {
      const row = getName.get(id);
      del.run(id);
      if (row) logAudit(req, { entityType: 'spares', entityId: id, entityLabel: row.name, action: 'delete', summary: `Deleted spare "${row.name}" (bulk delete)` });
    });
  });
  tx(ids);
  res.json({ deleted: ids.length });
});

module.exports = router;
