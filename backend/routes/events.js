const express = require('express');
const db = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendAlertSms } = require('../services/sms');
const { logAudit } = require('../services/audit');
const router = express.Router();

function rowToEvent(r) {
  return {
    id: r.id, motorId: r.motor_id, reportedAt: r.reported_at, reportedBy: r.reported_by,
    description: r.description, urgency: r.urgency, stage: r.stage,
    repairLocation: r.repair_location, repairLocationType: r.repair_location_type || '', condition: r.condition_notes,
    sparesUsed: JSON.parse(r.spares_used || '[]'), motorSwaps: JSON.parse(r.motor_swaps || '[]'), timeline: JSON.parse(r.timeline || '[]'),
    resolvedAt: r.resolved_at, downtimeHours: r.downtime_hours,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function who(req) { return req.user ? `${req.user.name} (${req.user.role})` : 'Unknown'; }

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM events ORDER BY reported_at DESC').all();
  res.json(rows.map(rowToEvent));
});

router.post('/', requireAuth, requireRole('admin', 'technician'), async (req, res) => {
  const b = req.body || {};
  const now = new Date().toISOString();
  const motor = db.prepare('SELECT * FROM motors WHERE id = ?').get(b.motorId);
  if (!motor) return res.status(400).json({ error: 'Motor not found.' });

  // A motor that's already broken down or under repair can't break down
  // again until that record is resolved — this prevents duplicate tickets
  // for the same ongoing issue.
  const openExisting = db.prepare("SELECT id FROM events WHERE motor_id = ? AND stage != 'resolved'").get(b.motorId);
  if (openExisting) return res.status(409).json({ error: `${motor.tag} already has an open breakdown (#${openExisting.id}). Resolve it before logging a new one.` });
  if (motor.manual_status === 'standby') return res.status(409).json({ error: `${motor.tag} is on standby, not in service — it can't break down.` });
  if (motor.manual_status === 'decommissioned') return res.status(409).json({ error: `${motor.tag} is decommissioned — it can't break down.` });

  const timeline = [{ at: now, text: `Breakdown reported by ${who(req)}.` }];
  const info = db.prepare(`INSERT INTO events
    (motor_id,reported_at,reported_by,description,urgency,stage,repair_location,condition_notes,spares_used,timeline,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    b.motorId, now, b.reportedBy || req.user.name, b.description || '', b.urgency || 'medium',
    'reported', '', '', '[]', JSON.stringify(timeline), now, now
  );

  logAudit(req, { entityType: 'events', entityId: info.lastInsertRowid, entityLabel: motor.tag, action: 'create', summary: `Reported breakdown on ${motor.tag} (${b.urgency || 'medium'} urgency)` });

  if ((b.urgency || 'medium') === 'high') {
    sendAlertSms(`MotorTrack alert: ${motor.tag} (${motor.name}) is down — HIGH urgency. Reported by ${b.reportedBy || req.user.name}.`)
      .catch(() => {});
  }

  res.status(201).json({ id: info.lastInsertRowid });
});

// Single PUT handles everything: workflow progress (stage/location/condition)
// AND editing the original report details (description/urgency/reportedBy).
// Only fields actually sent are changed — everything else is left exactly
// as it was, so editing one thing never wipes another.
router.put('/:id', requireAuth, requireRole('admin', 'technician'), (req, res) => {
  const b = req.body || {};
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Event not found.' });
  const now = new Date().toISOString();

  const next = {
    stage: b.stage !== undefined ? b.stage : row.stage,
    repairLocation: b.repairLocation !== undefined ? b.repairLocation : row.repair_location,
    repairLocationType: b.repairLocationType !== undefined ? b.repairLocationType : row.repair_location_type,
    condition: b.condition !== undefined ? b.condition : row.condition_notes,
    description: b.description !== undefined ? b.description : row.description,
    urgency: b.urgency !== undefined ? b.urgency : row.urgency,
    reportedBy: b.reportedBy !== undefined ? b.reportedBy : row.reported_by,
  };

  const timeline = JSON.parse(row.timeline || '[]');
  const changes = [];
  if (b.stage !== undefined && b.stage !== row.stage) changes.push(`stage → "${b.stage}"`);
  if (b.repairLocationType !== undefined && b.repairLocationType !== row.repair_location_type) changes.push(`workshop → "${b.repairLocationType}"`);
  if (b.repairLocation !== undefined && b.repairLocation !== row.repair_location) changes.push(`location → "${b.repairLocation}"`);
  if (b.condition !== undefined && b.condition !== row.condition_notes) changes.push(`condition → "${b.condition}"`);
  if (b.description !== undefined && b.description !== row.description) changes.push('description updated');
  if (b.urgency !== undefined && b.urgency !== row.urgency) changes.push(`urgency → "${b.urgency}"`);
  if (b.reportedBy !== undefined && b.reportedBy !== row.reported_by) changes.push(`reported by → "${b.reportedBy}"`);

  let text = changes.length ? changes.join(', ') : 'Updated.';
  if (b.note) text += (changes.length ? ' — ' : '') + b.note;
  timeline.push({ at: now, text: `${text} (${who(req)})` });

  db.prepare(`UPDATE events SET stage=?,repair_location=?,repair_location_type=?,condition_notes=?,description=?,urgency=?,reported_by=?,timeline=?,updated_at=? WHERE id=?`)
    .run(next.stage, next.repairLocation, next.repairLocationType, next.condition, next.description, next.urgency, next.reportedBy, JSON.stringify(timeline), now, req.params.id);

  const motor = db.prepare('SELECT tag FROM motors WHERE id = ?').get(row.motor_id);
  logAudit(req, { entityType: 'events', entityId: req.params.id, entityLabel: motor ? motor.tag : '', action: 'update', summary: changes.length ? changes.join('; ') : 'Updated with no field changes.' });

  res.json({ ok: true, event: rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id)) });
});

// Record a spare used on this repair — decrements stock in the same transaction
router.post('/:id/use-spare', requireAuth, requireRole('admin', 'technician'), (req, res) => {
  const { spareId, qty } = req.body || {};
  const useQty = Math.max(1, parseInt(qty) || 1);
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  const spare = db.prepare('SELECT * FROM spares WHERE id = ?').get(spareId);
  if (!event || !spare) return res.status(404).json({ error: 'Event or spare not found.' });

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const sparesUsed = JSON.parse(event.spares_used || '[]');
    sparesUsed.push({ spareId: spare.id, spareName: spare.name, qty: useQty });
    const timeline = JSON.parse(event.timeline || '[]');
    timeline.push({ at: now, text: `Used ${useQty} x ${spare.name} from stock (${who(req)}).` });
    db.prepare('UPDATE events SET spares_used=?, timeline=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(sparesUsed), JSON.stringify(timeline), now, event.id);
    db.prepare('UPDATE spares SET qty = MAX(0, qty - ?), updated_at=? WHERE id=?').run(useQty, now, spare.id);
  });
  tx();
  logAudit(req, { entityType: 'events', entityId: req.params.id, action: 'use-spare', summary: `Used ${useQty} x ${spare.name}` });
  logAudit(req, { entityType: 'spares', entityId: spare.id, entityLabel: spare.name, action: 'adjust', summary: `Used on repair — qty -${useQty}` });
  res.json({ ok: true, event: rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id)) });
});

// Install a standby spare motor in place of the broken one. The spare
// motor's own status flips from standby to running (it's out of the spare
// pool now, physically installed), and the swap is logged on both the
// breakdown record and the spare motor's own history.
router.post('/:id/swap-motor', requireAuth, requireRole('admin', 'technician'), (req, res) => {
  const { spareMotorId } = req.body || {};
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  const spareMotor = db.prepare('SELECT * FROM motors WHERE id = ?').get(spareMotorId);
  const brokenMotor = event ? db.prepare('SELECT * FROM motors WHERE id = ?').get(event.motor_id) : null;
  if (!event || !spareMotor || !brokenMotor) return res.status(404).json({ error: 'Breakdown or spare motor not found.' });
  if (spareMotor.manual_status !== 'standby') return res.status(409).json({ error: `${spareMotor.tag} is not currently on standby.` });

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const swaps = JSON.parse(event.motor_swaps || '[]');
    swaps.push({ motorId: spareMotor.id, tag: spareMotor.tag, at: now, by: who(req) });
    const timeline = JSON.parse(event.timeline || '[]');
    timeline.push({ at: now, text: `Spare motor ${spareMotor.tag} installed in place of ${brokenMotor.tag} (${who(req)}).` });
    db.prepare('UPDATE events SET motor_swaps=?, timeline=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(swaps), JSON.stringify(timeline), now, event.id);
    db.prepare("UPDATE motors SET manual_status='running', location_type=?, placement_detail=?, condition_notes=?, updated_at=? WHERE id=?")
      .run(brokenMotor.location_type, brokenMotor.placement_detail, `Installed in place of ${brokenMotor.tag}`, now, spareMotor.id);
  });
  tx();
  logAudit(req, { entityType: 'events', entityId: req.params.id, entityLabel: brokenMotor.tag, action: 'swap-motor', summary: `Installed spare motor ${spareMotor.tag} in place of ${brokenMotor.tag}` });
  logAudit(req, { entityType: 'motors', entityId: spareMotor.id, entityLabel: spareMotor.tag, action: 'update', summary: `Taken off standby — installed in place of ${brokenMotor.tag}` });
  res.json({ ok: true, event: rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id)) });
});

router.post('/:id/resolve', requireAuth, requireRole('admin', 'technician'), (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const now = new Date().toISOString();
  const downtimeHours = (new Date(now).getTime() - new Date(event.reported_at).getTime()) / 3600000;
  const timeline = JSON.parse(event.timeline || '[]');
  timeline.push({ at: now, text: `Resolved — motor returned to service. Total downtime ${downtimeHours.toFixed(1)} hours. (${who(req)})` });
  db.prepare(`UPDATE events SET stage='resolved', resolved_at=?, downtime_hours=?, timeline=?, updated_at=? WHERE id=?`)
    .run(now, downtimeHours, JSON.stringify(timeline), now, event.id);
  db.prepare('UPDATE motors SET condition_notes = ?, updated_at=? WHERE id=?')
    .run('Good — returned from repair', now, event.motor_id);
  const motor = db.prepare('SELECT tag FROM motors WHERE id = ?').get(event.motor_id);
  logAudit(req, { entityType: 'events', entityId: req.params.id, entityLabel: motor ? motor.tag : '', action: 'resolve', summary: `Resolved — downtime ${downtimeHours.toFixed(1)}h` });
  res.json({ ok: true, downtimeHours, event: rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id)) });
});

// Reopen a resolved event if it turns out the fix didn't hold — keeps the
// same record (and its history) instead of forcing a brand new report.
router.post('/:id/reopen', requireAuth, requireRole('admin', 'technician'), (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const now = new Date().toISOString();
  const timeline = JSON.parse(event.timeline || '[]');
  timeline.push({ at: now, text: `Reopened — issue recurred. (${who(req)})` });
  db.prepare(`UPDATE events SET stage='in_repair', resolved_at=NULL, downtime_hours=NULL, timeline=?, updated_at=? WHERE id=?`)
    .run(JSON.stringify(timeline), now, event.id);
  logAudit(req, { entityType: 'events', entityId: req.params.id, action: 'reopen', summary: 'Reopened after resolution' });
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  const motor = event ? db.prepare('SELECT tag FROM motors WHERE id = ?').get(event.motor_id) : null;
  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  if (event) logAudit(req, { entityType: 'events', entityId: req.params.id, entityLabel: motor ? motor.tag : '', action: 'delete', summary: `Deleted breakdown record for ${motor ? motor.tag : 'unknown motor'}` });
  res.json({ ok: true });
});

router.post('/bulk-delete', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.json({ deleted: 0 });
  const del = db.prepare('DELETE FROM events WHERE id = ?');
  const tx = db.transaction((items) => { items.forEach(id => del.run(id)); });
  tx(ids);
  ids.forEach(id => logAudit(req, { entityType: 'events', entityId: id, action: 'delete', summary: 'Deleted (bulk delete)' }));
  res.json({ deleted: ids.length });
});

module.exports = router;
